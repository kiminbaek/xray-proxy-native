// v1.24.1 节点标签 / 订阅 / 配额 / 路由 / Geo 数据 / 一键复制 等扩展路由
// 统一存储到 DATA_DIR 下独立 JSON 文件，避免动现有 schema
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execSync, exec } = require('child_process');
const router = express.Router();
const { wrap } = require('./_utils');
const xray = require('../xray');
const { logToInfo } = require('../xray/utils');

const DATA_DIR = process.env.TRIM_PKGVAR || '/tmp/xray-proxy-native';
const APP_VERSION = '1.24.5';
const TAGS_FILE = path.join(DATA_DIR, 'node_tags.json');
const SUB_FILE = path.join(DATA_DIR, 'subscriptions.json');
const QUOTA_FILE = path.join(DATA_DIR, 'quota.json');
const ROUTING_FILE = path.join(DATA_DIR, 'routing_rules.json');
const GEO_DIR = path.join(DATA_DIR, 'xray-bin');

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return fallback; }
}
function writeJSON(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    logToInfo('[ext] writeJSON ' + file + ' failed: ' + e.message);
    return false;
  }
}

// ============ 节点 tag 标签（A/C4） ============
router.get('/tags', wrap(async (req, res) => {
  res.json({ ok: true, tags: readJSON(TAGS_FILE, {}) });
}));
router.put('/tags/:nodeTag', wrap(async (req, res) => {
  const all = readJSON(TAGS_FILE, {});
  const labels = Array.isArray(req.body.labels) ? req.body.labels.map(s => String(s).slice(0, 32)).filter(Boolean).slice(0, 10) : [];
  if (labels.length === 0) delete all[req.params.nodeTag];
  else all[req.params.nodeTag] = labels;
  writeJSON(TAGS_FILE, all);
  res.json({ ok: true, labels });
}));

// ============ 订阅自动更新（C1） ============
// subscriptions.json: { items: [{id, name, url, interval_hours, last_run, last_status, last_added}] }
function genId() { return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

router.get('/subscriptions', wrap(async (req, res) => {
  const data = readJSON(SUB_FILE, { items: [] });
  const now = Date.now();
  const items = (data.items || []).map(it => {
    const last = it.last_run ? Date.parse(it.last_run) : 0;
    const intervalMs = (it.interval_hours || 24) * 3600 * 1000;
    const nextTs = last ? last + intervalMs : now;
    return { ...it, next_run: new Date(nextTs).toISOString(), due: !last || now >= nextTs };
  });
  res.json({ ok: true, items });
}));
router.post('/subscriptions', wrap(async (req, res) => {
  const { name, url, interval_hours } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: 'URL 无效' });
  const data = readJSON(SUB_FILE, { items: [] });
  const item = { id: genId(), name: String(name || '').slice(0, 64) || 'subscription', url, interval_hours: Math.min(720, Math.max(1, parseInt(interval_hours) || 24)), last_run: null, last_status: null, last_added: 0 };
  data.items.push(item);
  writeJSON(SUB_FILE, data);
  res.json({ ok: true, item });
}));
router.put('/subscriptions/:id', wrap(async (req, res) => {
  const data = readJSON(SUB_FILE, { items: [] });
  const it = data.items.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ ok: false });
  if (req.body.name !== undefined) it.name = String(req.body.name).slice(0, 64);
  if (req.body.url !== undefined && /^https?:\/\//i.test(req.body.url)) it.url = req.body.url;
  if (req.body.interval_hours !== undefined) it.interval_hours = Math.min(720, Math.max(1, parseInt(req.body.interval_hours) || 24));
  writeJSON(SUB_FILE, data);
  res.json({ ok: true, item: it });
}));
router.delete('/subscriptions/:id', wrap(async (req, res) => {
  const data = readJSON(SUB_FILE, { items: [] });
  data.items = data.items.filter(x => x.id !== req.params.id);
  writeJSON(SUB_FILE, data);
  res.json({ ok: true });
}));
router.post('/subscriptions/:id/run', wrap(async (req, res) => {
  const data = readJSON(SUB_FILE, { items: [] });
  const it = data.items.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ ok: false });
  const r = await runSubscription(it);
  writeJSON(SUB_FILE, data);
  res.json(r);
}));

function fetchText(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('URL 错误')); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout: timeoutMs, headers: { 'User-Agent': 'xray-proxy-native/' + APP_VERSION } }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        resp.resume();
        return resolve(fetchText(new URL(resp.headers.location, u).toString(), timeoutMs));
      }
      if (resp.statusCode !== 200) { resp.resume(); return reject(new Error('HTTP ' + resp.statusCode)); }
      const chunks = []; let size = 0;
      resp.on('data', c => { size += c.length; if (size > 4 * 1024 * 1024) { req.destroy(new Error('订阅过大')); return; } chunks.push(c); });
      resp.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('订阅拉取超时')));
    req.on('error', reject);
  });
}

async function runSubscription(item) {
  item.last_run = new Date().toISOString();
  try {
    const text = await fetchText(item.url);
    // v1.24.1 调内部 API：复用 xray.parseShareLink + addNode
    const xrayMod = require('../xray');
    let nodes = [];
    {
      const decoded = (function tryDecode(t){ try { if (/^[A-Za-z0-9+/=_\-\s]+$/.test(t)&&!t.includes('://')) { const n = t.replace(/\s+/g,'').replace(/-/g,'+').replace(/_/g,'/'); const d = Buffer.from(n,'base64').toString('utf8'); if (d.includes('://')) return d; } } catch(_){} return t; })(text);
      const matches = decoded.match(/(?:vless|vmess|trojan|ss):\/\/[^\s\r\n]+/gi) || [];
      for (const link of matches) {
        try { const n = xrayMod.parseShareLink(link); if (n) nodes.push(n); } catch (_) {}
      }
    }
    const cfg = xrayMod.getConfig();
    const existing = new Set((cfg.outbounds || []).map(o => o.tag));
    let added = 0;
    for (const n of nodes) {
      try {
        if (!n || !n.tag) continue;
        // 用订阅名加前缀；已存在同名 tag 时跳过，避免自动更新无限重复添加
        const safeName = String(item.name || 'subscription').replace(/[\r\n\t]/g, ' ').slice(0, 32) || 'subscription';
        const tag = `${safeName}-${n.tag}`.slice(0, 64);
        if (existing.has(tag)) continue;
        xrayMod.addNode({ ...n, tag });
        existing.add(tag);
        added++;
      } catch (_) {}
    }
    item.last_status = 'ok';
    item.last_error = '';
    item.last_added = added;
    return { ok: true, added, total: nodes.length };
  } catch (e) {
    item.last_status = 'error';
    item.last_error = e.message || String(e);
    item.last_added = 0;
    return { ok: false, error: e.message };
  }
}

// v1.24.1 后台订阅自动更新：30 分钟扫描一次 + 60 秒首扫 + 防重入
let cronTimer = null;
let cronRunning = false;
async function runDueSubscriptions() {
  if (cronRunning) return { ok: false, skipped: true, reason: 'running' };
  cronRunning = true;
  try {
    const data = readJSON(SUB_FILE, { items: [] });
    let changed = false;
    let ran = 0;
    const now = Date.now();
    for (const it of (data.items || [])) {
      const last = it.last_run ? Date.parse(it.last_run) : 0;
      const intervalMs = (it.interval_hours || 24) * 3600 * 1000;
      if (!last || now - last >= intervalMs) {
        logToInfo('[ext] subscription auto update: ' + (it.name || it.id));
        await runSubscription(it);
        changed = true;
        ran++;
      }
    }
    if (changed) writeJSON(SUB_FILE, data);
    return { ok: true, ran };
  } catch (e) {
    logToInfo('[ext] sub cron error: ' + e.message);
    return { ok: false, error: e.message };
  } finally {
    cronRunning = false;
  }
}
function startCron() {
  if (cronTimer) return;
  setTimeout(() => runDueSubscriptions(), 60 * 1000).unref?.();
  cronTimer = setInterval(() => runDueSubscriptions(), 30 * 60 * 1000);
  cronTimer.unref && cronTimer.unref();
  logToInfo('[ext] subscription auto update scheduler started (30min scan)');
}
router.post('/subscriptions/run-due', wrap(async (req, res) => {
  res.json(await runDueSubscriptions());
}));
startCron();

// ============ 流量配额（C6） ============
router.get('/quota', wrap(async (req, res) => {
  res.json({ ok: true, config: readJSON(QUOTA_FILE, { enabled: false, monthly_gb: 100, notify_at: [50, 80, 100], reset_day: 1, last_alert_pct: 0 }) });
}));
router.post('/quota', wrap(async (req, res) => {
  const old = readJSON(QUOTA_FILE, { enabled: false, monthly_gb: 100, notify_at: [50, 80, 100], reset_day: 1, last_alert_pct: 0 });
  const next = {
    enabled: !!req.body.enabled,
    monthly_gb: Math.max(1, parseFloat(req.body.monthly_gb) || old.monthly_gb),
    notify_at: Array.isArray(req.body.notify_at) ? req.body.notify_at.map(x => parseInt(x)).filter(x => x > 0 && x <= 200).slice(0, 5) : old.notify_at,
    reset_day: Math.min(28, Math.max(1, parseInt(req.body.reset_day) || old.reset_day)),
    last_alert_pct: old.last_alert_pct
  };
  writeJSON(QUOTA_FILE, next);
  res.json({ ok: true, config: next });
}));

// ============ 路由规则编辑器（C3） ============
router.get('/routing', wrap(async (req, res) => {
  const cfg = xray.getConfig();
  const routing = cfg.routing || { rules: [] };
  res.json({ ok: true, domainStrategy: routing.domainStrategy || 'IPIfNonMatch', rules: routing.rules || [] });
}));
router.post('/routing', wrap(async (req, res) => {
  // 只接受 rules + domainStrategy，避免破坏其他字段
  const rules = Array.isArray(req.body.rules) ? req.body.rules : null;
  if (!rules) return res.status(400).json({ ok: false, error: 'rules 必须是数组' });
  // 校验每条 rule
  for (const r of rules) {
    if (!r || typeof r !== 'object') return res.status(400).json({ ok: false, error: '规则格式错误' });
    if (!r.outboundTag) return res.status(400).json({ ok: false, error: '规则缺少 outboundTag' });
  }
  const cfg = xray.getConfig();
  cfg.routing = cfg.routing || {};
  cfg.routing.domainStrategy = String(req.body.domainStrategy || cfg.routing.domainStrategy || 'IPIfNonMatch');
  cfg.routing.rules = rules;
  xray.setConfig(cfg);
  res.json({ ok: true });
}));

// ============ GeoIP/GeoSite 一键更新（C7） ============
router.get('/geo/status', wrap(async (req, res) => {
  const files = { geoip: 'geoip.dat', geosite: 'geosite.dat' };
  const result = {};
  for (const [key, fname] of Object.entries(files)) {
    const p = path.join(GEO_DIR, fname);
    try {
      const st = fs.statSync(p);
      result[key] = { exists: true, size_kb: Math.round(st.size / 1024), size_mb: (st.size / 1048576).toFixed(1), mtime: st.mtime };
    } catch (_) {
      result[key] = { exists: false };
    }
  }
  res.json({ ok: true, dir: GEO_DIR, ...result });
}));
router.post('/geo/update', wrap(async (req, res) => {
  const urls = {
    'geoip.dat': 'https://github.com/v2fly/geoip/releases/latest/download/geoip.dat',
    'geosite.dat': 'https://github.com/v2fly/domain-list-community/releases/latest/download/dlc.dat'
  };
  const result = {};
  let allOk = true;
  for (const [name, url] of Object.entries(urls)) {
    try {
      const buf = await fetchBinary(url);
      fs.mkdirSync(GEO_DIR, { recursive: true });
      fs.writeFileSync(path.join(GEO_DIR, name), buf);
      result[name] = { ok: true, size: buf.length };
    } catch (e) {
      result[name] = { ok: false, error: e.message };
      allOk = false;
    }
  }
  // 更新成功后自动重启 xray 使 Geo 数据生效（F1）
  let restartInfo = '';
  if (allOk) {
    try {
      await xray.restartXray();
      restartInfo = '，xray 已自动重启';
    } catch (e) {
      restartInfo = '（xray 重启失败：' + e.message + '，请手动重启）';
    }
  }
  res.json({ ok: true, result, hint: '更新完成' + restartInfo });
}));

function fetchBinary(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('URL 错误')); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout: timeoutMs, headers: { 'User-Agent': 'xray-proxy-native/' + APP_VERSION } }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        resp.resume();
        return resolve(fetchBinary(new URL(resp.headers.location, u).toString(), timeoutMs));
      }
      if (resp.statusCode !== 200) { resp.resume(); return reject(new Error('HTTP ' + resp.statusCode)); }
      const chunks = []; let size = 0;
      resp.on('data', c => { size += c.length; if (size > 100 * 1024 * 1024) { req.destroy(new Error('文件过大')); return; } chunks.push(c); });
      resp.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

// ============ curl 快速测试（C9） ============
router.post('/curl-test', wrap(async (req, res) => {
  const target = String(req.body.target || 'https://www.google.com/generate_204');
  const modeRaw = String(req.body.mode || 'socks');
  const mode = modeRaw === 'proxy' ? 'socks' : modeRaw; // socks / http / direct; proxy is frontend alias
  if (!/^https?:\/\//i.test(target)) return res.status(400).json({ ok: false, error: 'URL 必须以 http(s) 开头' });
  let proxyArg = '';
  if (mode === 'socks') proxyArg = '--socks5 127.0.0.1:10808';
  else if (mode === 'http') proxyArg = '-x http://127.0.0.1:10809';
  exec(`curl -sS -o /dev/null -w "%{http_code} %{time_total}" --max-time 15 ${proxyArg} "${target.replace(/"/g, '')}"`, { timeout: 16000 }, (err, stdout) => {
    if (err) return res.json({ ok: false, error: err.message, output: stdout });
    const [code, time] = String(stdout).trim().split(/\s+/);
    const time_seconds = parseFloat(time);
    res.json({ ok: true, http_code: code, time_seconds, time_ms: Math.round(time_seconds * 1000), mode, target });
  });
}));

// ============ 流量配额检查（被通知中心轮询时用） ============
router.get('/quota/check', wrap(async (req, res) => {
  const cfg = readJSON(QUOTA_FILE, { enabled: false, monthly_gb: 100, notify_at: [80, 100], reset_day: 1, last_alert_pct: 0 });
  if (!cfg.enabled) return res.json({ ok: true, enabled: false });
  const traffic = xray.getTraffic ? xray.getTraffic() : {};
  const total = traffic.total || {};
  const usedBytes = (total.down || 0) + (total.up || 0);
  const usedGB = usedBytes / (1024 ** 3);
  const pct = Math.round((usedGB / cfg.monthly_gb) * 100);
  res.json({ ok: true, enabled: true, used_gb: +usedGB.toFixed(3), monthly_gb: cfg.monthly_gb, percent: pct, last_alert_pct: cfg.last_alert_pct });
}));

module.exports = router;
