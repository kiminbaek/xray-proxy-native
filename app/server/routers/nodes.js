// 节点路由
const express = require('express');
const http = require('http');
const https = require('https');
const router = express.Router();
const xray = require('../xray');
const { wrap } = require('./_utils');
// v1.14.0+ 并发限流（共享 xray/utils.pLimit）
const { pLimit } = require('../xray/utils');

// 节点列表（v1.12.1+ 给系统节点加 system:true 标记，前端不依赖硬编码）
const SYSTEM_TAGS = ['proxy', 'direct', 'block', 'api'];


// v1.19.0 节点导入增强：文本/订阅 URL 批量解析 + 自动重名
function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s || '').trim());
}

function fetchText(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('订阅 URL 格式错误')); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout: timeoutMs, headers: { 'User-Agent': 'proc-xray-proxy-native/1.19.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, u).toString(), timeoutMs));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('订阅拉取失败 HTTP ' + res.statusCode));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 2 * 1024 * 1024) {
          req.destroy(new Error('订阅内容超过 2MB'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('订阅拉取超时')));
    req.on('error', reject);
  });
}

function maybeDecodeBase64Text(text) {
  const raw = String(text || '').trim();
  if (!raw) return raw;
  if (/^[A-Za-z0-9+/=_\-\s]+$/.test(raw) && !raw.includes('://')) {
    try {
      const normalized = raw.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(normalized, 'base64').toString('utf8');
      if (decoded.includes('://')) return decoded;
    } catch (_) {}
  }
  return raw;
}

function extractShareLinks(text) {
  const decoded = maybeDecodeBase64Text(text);
  const matches = decoded.match(/(?:vless|vmess|trojan|ss):\/\/[^\s\r\n]+/gi) || [];
  return matches.map(x => x.trim()).filter(Boolean);
}

function uniqueTag(tag, used) {
  const base = String(tag || 'node').trim().replace(/[\r\n\t]/g, ' ').slice(0, 64) || 'node';
  if (!used.has(base)) { used.add(base); return base; }
  for (let i = 2; i < 1000; i++) {
    const t = `${base}-${i}`;
    if (!used.has(t)) { used.add(t); return t; }
  }
  const t = `${base}-${Date.now()}`;
  used.add(t);
  return t;
}
router.get('/', (req, res) => {
  const config = xray.getConfig();
  const nodes = (config.outbounds || []).map(o => ({
    ...o,
    system: SYSTEM_TAGS.includes(o.tag)
  }));
  res.json({ ok: true, nodes });
});

// 添加节点
router.post('/', wrap(async (req, res) => {
  const tag = xray.addNode(req.body);
  res.json({ ok: true, tag });
}));

// 更新节点
router.put('/:tag', wrap(async (req, res) => {
  const node = xray.updateNode(req.params.tag, req.body);
  if (!node) return res.status(404).json({ ok: false, error: '节点不存在' });
  res.json({ ok: true, node });
}));

// 删除节点
router.delete('/:tag', wrap(async (req, res) => {
  const result = xray.deleteNode(req.params.tag);
  // v1.7.4+ 系统节点保护：返回 {ok: false, error}
  if (result && result.ok === false) {
    return res.status(400).json(result);
  }
  if (!result) return res.status(404).json({ ok: false, error: '节点不存在' });
  res.json({ ok: true });
}));

// 启用/禁用节点
router.post('/:tag/toggle', wrap(async (req, res) => {
  const { enabled } = req.body;
  const node = xray.toggleNode(req.params.tag, !!enabled);
  if (!node) return res.status(404).json({ ok: false, error: '节点不存在' });
  res.json({ ok: true, node });
}));

// 测试节点延迟
router.post('/:tag/test', wrap(async (req, res) => {
  const cfg = xray.getConfig();
  const node = (cfg.outbounds || []).find(o => o.tag === req.params.tag);
  if (!node) return res.status(404).json({ ok: false, error: '节点不存在' });
  const result = await xray.testNode(node);
  // v1.13.0+ 手动测速也写历史（环形 buffer 自动去重 <2s）
  if (xray.history) {
    xray.history.recordHistory(req.params.tag, result.ok ? result.ms : null, result.ok);
  }
  res.json(result);
}));

// 重排序
router.post('/reorder', wrap(async (req, res) => {
  const { tags } = req.body;
  if (!Array.isArray(tags)) return res.status(400).json({ ok: false, error: 'tags 必须为数组' });
  xray.reorderNodes(tags);
  res.json({ ok: true });
}));

// 批量测速（v1.13.0+）
// POST /api/nodes/test-all  body: { tags?: string[] }  // 不传 tags = 所有用户节点
// 返回每节点的 {tag, ok, ms, error}，并写入 history
router.post('/test-all', wrap(async (req, res) => {
  const cfg = xray.getConfig();
  let targets = (cfg.outbounds || []).filter(o => !['proxy', 'direct', 'block', 'api'].includes(o.tag));
  if (Array.isArray(req.body?.tags) && req.body.tags.length > 0) {
    const tagSet = new Set(req.body.tags);
    targets = targets.filter(o => tagSet.has(o.tag));
  }
  if (targets.length === 0) return res.json({ ok: true, results: [] });

  // v1.14.0+ 并发限流（p-limit 10）：避免 100 节点触发目标限流 / 本地端口耗尽
  // 修 v1.13.0 风险：Promise.all 全部并发 → TCP 连接暴增
  const TEST_ALL_CONCURRENCY = 10;
  const limit = pLimit(TEST_ALL_CONCURRENCY);
  const results = await Promise.all(targets.map((node) => limit(async () => {
    const r = await xray.testNode(node);
    if (xray.history) xray.history.recordHistory(node.tag, r.ok ? r.ms : null, r.ok);
    return { tag: node.tag, ...r };
  })));
  // 按延迟升序（失败的排最后）
  results.sort((a, b) => {
    if (a.ok && b.ok) return a.ms - b.ms;
    if (a.ok) return -1;
    if (b.ok) return 1;
    return 0;
  });
  res.json({ ok: true, count: results.length, results });
}));

// 批量操作（v1.10.0+）：action = 'enable' | 'disable' | 'delete' | 'group' | 'test'
// v1.12.1+ 加白名单 + tags 数量上限：避免误传 action 或大数组导致 DoS
// v1.13.0+ 加 'test'（批量测速）
const BATCH_ACTIONS = ['enable', 'disable', 'delete', 'group', 'test'];
const BATCH_MAX_TAGS = 100;
router.post('/batch', wrap(async (req, res) => {
  const { action, tags, group } = req.body || {};
  if (!action || !BATCH_ACTIONS.includes(action)) {
    return res.status(400).json({ ok: false, error: 'action 必须为: ' + BATCH_ACTIONS.join('/') });
  }
  if (!Array.isArray(tags) || tags.length === 0) {
    return res.status(400).json({ ok: false, error: 'tags 必须为非空数组' });
  }
  if (tags.length > BATCH_MAX_TAGS) {
    return res.status(400).json({ ok: false, error: 'tags 数量超过上限 ' + BATCH_MAX_TAGS + '（当前 ' + tags.length + '）' });
  }
  // v1.12.1+ tag 必须是字符串
  for (const t of tags) {
    if (typeof t !== 'string' || !t) {
      return res.status(400).json({ ok: false, error: 'tags 元素必须为非空字符串' });
    }
  }
  const results = [];
  for (const tag of tags) {
    if (action === 'enable') {
      const r = xray.toggleNode(tag, true);
      results.push({ tag, ok: !!r });
    } else if (action === 'disable') {
      const r = xray.toggleNode(tag, false);
      results.push({ tag, ok: !!r });
    } else if (action === 'delete') {
      const r = xray.deleteNode(tag);
      // 系统节点返 { ok: false, error }
      if (r && r.ok === false) results.push({ tag, ok: false, error: r.error });
      else results.push({ tag, ok: !!r });
    } else if (action === 'group') {
      const r = xray.updateNode(tag, { group: group || '' });
      results.push({ tag, ok: !!r });
    }
  }
  const failed = results.filter(r => !r.ok);
  res.json({ ok: failed.length === 0, total: tags.length, success: tags.length - failed.length, failed: failed.length, results });
}));



// 批量导入节点（v1.19.0）
// body: { text?: string, url?: string, mode?: 'preview'|'import', duplicate?: 'rename'|'skip'|'overwrite', test?: boolean }
router.post('/import', wrap(async (req, res) => {
  const body = req.body || {};
  const mode = body.mode === 'import' ? 'import' : 'preview';
  const duplicate = ['rename', 'skip', 'overwrite'].includes(body.duplicate) ? body.duplicate : 'rename';
  let input = String(body.text || '').trim();
  let source = 'text';
  if (body.url || (isHttpUrl(input) && !input.includes('\n'))) {
    const url = String(body.url || input).trim();
    input = await fetchText(url);
    source = url;
  }
  const links = extractShareLinks(input).slice(0, 500);
  if (links.length === 0) return res.status(400).json({ ok: false, error: '未找到 vless/vmess/trojan/ss 节点链接' });

  const cfg = xray.getConfig();
  const existing = new Map((cfg.outbounds || []).map(o => [o.tag, o]));
  const used = new Set(existing.keys());
  const parsed = [];
  const failed = [];

  for (const link of links) {
    const node = xray.parseShareLink(link);
    if (!node || node.error) {
      failed.push({ link: link.slice(0, 120), error: node && node.error ? node.error : '空链接' });
      continue;
    }
    const originalTag = node.tag;
    if (existing.has(node.tag)) {
      if (duplicate === 'skip') {
        parsed.push({ node, originalTag, duplicate: true, action: 'skip' });
        continue;
      }
      if (duplicate === 'rename') {
        node.tag = uniqueTag(node.tag, used);
        parsed.push({ node, originalTag, duplicate: true, action: 'rename' });
        continue;
      }
      parsed.push({ node, originalTag, duplicate: true, action: 'overwrite' });
      used.add(node.tag);
      continue;
    }
    node.tag = uniqueTag(node.tag, used);
    parsed.push({ node, originalTag, duplicate: false, action: 'add' });
  }

  if (mode === 'preview') {
    return res.json({ ok: true, mode, source, total: links.length, parsed: parsed.length, failed: failed.length, nodes: parsed.map(x => ({ tag: x.node.tag, originalTag: x.originalTag, protocol: x.node.protocol, action: x.action, duplicate: x.duplicate })), errors: failed });
  }

  const results = [];
  for (const item of parsed) {
    try {
      if (item.action === 'skip') {
        results.push({ tag: item.node.tag, ok: true, action: 'skip' });
      } else if (item.action === 'overwrite') {
        xray.updateNode(item.node.tag, item.node);
        results.push({ tag: item.node.tag, ok: true, action: 'overwrite' });
      } else {
        const tag = xray.addNode(item.node);
        results.push({ tag, ok: true, action: item.action });
      }
    } catch (e) {
      results.push({ tag: item.node.tag, ok: false, action: item.action, error: e.message });
    }
  }

  let tests = [];
  if (body.test === true) {
    const limit = pLimit(8);
    tests = await Promise.all(results.filter(r => r.ok && r.action !== 'skip').map(r => limit(async () => {
      const cfg2 = xray.getConfig();
      const node = (cfg2.outbounds || []).find(o => o.tag === r.tag);
      const t = node ? await xray.testNode(node) : { ok: false, error: '节点不存在' };
      if (xray.history) xray.history.recordHistory(r.tag, t.ok ? t.ms : null, t.ok);
      return { tag: r.tag, ...t };
    })));
  }

  const success = results.filter(r => r.ok).length;
  res.json({ ok: failed.length === 0 && success > 0, mode, source, total: links.length, success, failed: failed.length + results.filter(r => !r.ok).length, results, errors: failed, tests });
}));

// 解析分享链接
router.post('/parse-link', wrap(async (req, res) => {
  const { link } = req.body;
  const result = xray.parseShareLink(link);
  if (result && result.error) return res.status(400).json({ ok: false, error: result.error });
  res.json({ ok: true, node: result });
}));

module.exports = router;
