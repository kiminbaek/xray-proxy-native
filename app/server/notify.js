// 通知发送模块（v1.16.0+）
// 支持渠道：Telegram Bot / 企业微信 Webhook / Server 酱
// 用途：xray 崩溃 / 节点失效 / 登录失败锁定 / 流量告警
// 设计：
//   1. 异步发送（不阻塞主流程）
//   2. 失败重试 3 次（指数退避 1s+2s+4s）
//   3. 防刷屏：同 event 类型最小间隔 30s
//   4. 错误隔离：单个渠道失败不影响其他渠道
//   5. 持久化配置：${PKGVAR}/notify_config.json（重启不丢）
//   6. 发送历史：${PKGVAR}/notify_log.json（最近 50 条）

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { logToInfo } = require('./xray/utils');

const TRIM_PKGVAR = process.env.TRIM_PKGVAR || path.join(require('os').tmpdir(), 'xray-proxy-native');
const CONFIG_FILE = path.join(TRIM_PKGVAR, 'notify_config.json');
const LOG_FILE = path.join(TRIM_PKGVAR, 'notify_log.json');

// ====== 默认配置 ======
const DEFAULT_CONFIG = {
  channels: {
    telegram:    { enabled: false, botToken: '', chatId: '' },
    wechatWork:  { enabled: false, webhookUrl: '' },
    serverchan:  { enabled: false, sendKey: '' }
  },
  rules: {
    xray_crashed:        true,   // xray 进程崩溃
    xray_restart_failed: true,   // xray 自动重启失败
    node_disabled:       true,   // 节点自动禁用
    node_health_low:     true,   // 节点健康率低
    login_locked:        true,   // 登录失败锁定
    traffic_warning:     false,  // 流量达 80%
    traffic_exceeded:    false   // 流量超 100%
  }
};

// ====== 防刷屏：同 event 类型最小间隔 30s ======
const MIN_INTERVAL_MS = 30 * 1000;
const lastSentAt = new Map();  // event -> timestamp

// ====== 内部：HTTP POST 辅助（支持 https/http） ======
function httpPostJson(targetUrl, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(targetUrl);
    } catch (e) {
      return reject(new Error('URL 无效: ' + targetUrl));
    }
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const data = Buffer.from(JSON.stringify(body), 'utf-8');
    const opts = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + (url.search || ''),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      },
      timeout: timeoutMs || 5000
    };
    const req = lib.request(opts, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body: buf });
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('请求超时（' + (timeoutMs || 5000) + 'ms）'));
    });
    req.write(data);
    req.end();
  });
}

// ====== 重试：3 次，指数退避 1s+2s+4s ======
async function retryWithBackoff(fn, maxRetries) {
  const tries = maxRetries || 3;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) {
        const delay = Math.pow(2, i) * 1000;  // 1s, 2s, 4s
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ====== 渠道发送函数 ======
async function sendTelegram(cfg, text) {
  if (!cfg.botToken || !cfg.chatId) {
    throw new Error('Telegram 未配置 Bot Token 或 Chat ID');
  }
  const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
  return await retryWithBackoff(() => httpPostJson(url, {
    chat_id: cfg.chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  }, 8000));
}

async function sendWechatWork(cfg, text) {
  if (!cfg.webhookUrl) {
    throw new Error('企业微信 Webhook URL 未配置');
  }
  return await retryWithBackoff(() => httpPostJson(cfg.webhookUrl, {
    msgtype: 'text',
    text: { content: text }
  }, 8000));
}

async function sendServerChan(cfg, text) {
  if (!cfg.sendKey) {
    throw new Error('Server 酱 SendKey 未配置');
  }
  // Server 酱新版：https://sctapi.ftqq.com/{SendKey}.send
  const url = `https://sctapi.ftqq.com/${cfg.sendKey}.send`;
  return await retryWithBackoff(() => httpPostJson(url, {
    title: 'xray-proxy-native 通知',
    desp: text
  }, 8000));
}

const CHANNEL_SENDERS = {
  telegram: sendTelegram,
  wechatWork: sendWechatWork,
  serverchan: sendServerChan
};

// ====== 加载 / 保存配置 ======
function loadConfigRaw() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (_) {
    return null;
  }
}

function getConfig() {
  const raw = loadConfigRaw() || {};
  // 合并默认配置（缺字段补默认）
  return {
    channels: {
      telegram:    { ...DEFAULT_CONFIG.channels.telegram,    ...(raw.channels && raw.channels.telegram    || {}) },
      wechatWork:  { ...DEFAULT_CONFIG.channels.wechatWork,  ...(raw.channels && raw.channels.wechatWork  || {}) },
      serverchan:  { ...DEFAULT_CONFIG.channels.serverchan,  ...(raw.channels && raw.channels.serverchan  || {}) }
    },
    rules: {
      ...DEFAULT_CONFIG.rules,
      ...(raw.rules || {})
    }
  };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (_) {}
}

function setConfig(partial) {
  const current = getConfig();
  const next = { ...current };
  if (partial.channels) {
    next.channels = { ...current.channels };
    for (const ch of ['telegram', 'wechatWork', 'serverchan']) {
      if (partial.channels[ch]) {
        next.channels[ch] = { ...current.channels[ch], ...partial.channels[ch] };
      }
    }
  }
  if (partial.rules) {
    next.rules = { ...current.rules, ...partial.rules };
  }
  saveConfig(next);
  return next;
}

// ====== 发送历史（最近 50 条）======
function loadLog() {
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function saveLog(log) {
  // 只保留最近 50 条
  const trimmed = log.slice(-50);
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(trimmed, null, 2), { mode: 0o600 });
  } catch (_) {}
}

function recordLog(event, channel, ok, error) {
  const log = loadLog();
  log.push({
    ts: new Date().toISOString(),
    event,
    channel,
    ok: !!ok,
    error: error ? String(error.message || error).slice(0, 200) : null
  });
  saveLog(log);
}

// ====== 核心：send(event, data) ======
// event: 事件名（如 'xray_crashed'）
// data:  { title, message, ... }  → 自动格式化为统一文本
// 返回： { sent: [{channel, ok, error}], skipped: bool }
async function send(event, data) {
  data = data || {};
  const cfg = getConfig();

  // 1. 检查规则是否启用
  if (!cfg.rules[event]) {
    return { sent: [], skipped: true, reason: 'rule_disabled' };
  }

  // 2. 防刷屏
  const now = Date.now();
  const last = lastSentAt.get(event) || 0;
  if (now - last < MIN_INTERVAL_MS) {
    return { sent: [], skipped: true, reason: 'throttled', lastSentMs: last };
  }

  // 3. 构造文本
  const title = data.title || event;
  const lines = [];
  lines.push(`🔔 xray-proxy-native 通知`);
  lines.push(`事件：${title}`);
  lines.push(`时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  if (data.message) lines.push('');
  if (typeof data.message === 'string') {
    lines.push(data.message);
  } else if (data.message && typeof data.message === 'object') {
    for (const [k, v] of Object.entries(data.message)) {
      lines.push(`${k}: ${v}`);
    }
  }
  const text = lines.join('\n');

  // 4. 找出启用的渠道
  const enabledChannels = Object.keys(cfg.channels).filter((ch) => cfg.channels[ch] && cfg.channels[ch].enabled);
  if (enabledChannels.length === 0) {
    return { sent: [], skipped: true, reason: 'no_channel_enabled' };
  }

  // 5. 异步并发发送（不阻塞主流程）
  //    用 setImmediate 让 send() 立即返回
  const sent = [];
  setImmediate(async () => {
    lastSentAt.set(event, now);
    for (const ch of enabledChannels) {
      const sender = CHANNEL_SENDERS[ch];
      if (!sender) continue;
      try {
        await sender(cfg.channels[ch], text);
        sent.push({ channel: ch, ok: true });
        recordLog(event, ch, true, null);
        logToInfo(`[notify] sent to ${ch}: ${event}`);
      } catch (e) {
        sent.push({ channel: ch, ok: false, error: e.message });
        recordLog(event, ch, false, e.message);
        logToInfo(`[notify] failed to send to ${ch}: ${e.message}`);
      }
    }
  });

  return { sent: [], skipped: false, pending: true, channels: enabledChannels };
}

// ====== 测试发送（同步等结果）======
async function test(channel) {
  const cfg = getConfig();
  if (channel) {
    const chCfg = cfg.channels[channel];
    if (!chCfg) throw new Error('未知渠道: ' + channel);
    if (!chCfg.enabled) throw new Error('渠道未启用: ' + channel);
    const sender = CHANNEL_SENDERS[channel];
    if (!sender) throw new Error('渠道未实现: ' + channel);
    const text = '🧪 xray-proxy-native 测试通知\n这是一条测试消息，收到请忽略。';
    await sender(chCfg, text);
    recordLog('test', channel, true, null);
    return { ok: true, channel };
  }
  // 测试所有启用的渠道
  const results = [];
  for (const ch of Object.keys(cfg.channels)) {
    if (cfg.channels[ch].enabled) {
      try {
        await test(ch);
        results.push({ channel: ch, ok: true });
      } catch (e) {
        results.push({ channel: ch, ok: false, error: e.message });
      }
    }
  }
  return { ok: true, results };
}

module.exports = {
  getConfig,
  setConfig,
  send,
  test,
  loadLog,
  CHANNELS: ['telegram', 'wechatWork', 'serverchan'],
  EVENTS: Object.keys(DEFAULT_CONFIG.rules)
};
