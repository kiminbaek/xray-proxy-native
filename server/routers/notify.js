// 通知配置路由（v1.16.0+）
// GET    /api/notify/config             获取通知配置（脱敏：botToken 只返前 4 字符 + ***）
// POST   /api/notify/config             修改通知配置
// POST   /api/notify/test               测试所有启用渠道
// POST   /api/notify/test/:channel      测试单个渠道（telegram / wechatWork / serverchan）
// GET    /api/notify/log                获取发送历史（最近 50 条）

const express = require('express');
const router = express.Router();
const notify = require('../notify');
const { wrap } = require('./_utils');

// 脱敏：botToken / sendKey 只返前 4 字符 + ****
function maskConfig(cfg) {
  const masked = JSON.parse(JSON.stringify(cfg));
  if (masked.channels.telegram && masked.channels.telegram.botToken) {
    const t = masked.channels.telegram.botToken;
    masked.channels.telegram.botToken = t.length > 8 ? t.slice(0, 4) + '****' + t.slice(-4) : '****';
  }
  if (masked.channels.serverchan && masked.channels.serverchan.sendKey) {
    const k = masked.channels.serverchan.sendKey;
    masked.channels.serverchan.sendKey = k.length > 8 ? k.slice(0, 4) + '****' + k.slice(-4) : '****';
  }
  if (masked.channels.wechatWork && masked.channels.wechatWork.webhookUrl) {
    const u = masked.channels.wechatWork.webhookUrl;
    // webhook 包含 key 参数，保留协议 + 域名 + ****
    try {
      const url = new URL(u);
      masked.channels.wechatWork.webhookUrl = url.origin + url.pathname + '?key=****';
    } catch (_) {
      masked.channels.wechatWork.webhookUrl = '****';
    }
  }
  return masked;
}

// 完整配置（含明文），仅内部使用
function unmaskConfig(partial) {
  // 客户端发过来的 masked 值（如 "1102****Dsaw"）应被忽略，让用户重新填明文
  // 所以这里只对每个渠道的明文字段做处理：如果以 **** 结尾，认为是占位符，丢弃
  const out = JSON.parse(JSON.stringify(partial || {}));
  for (const ch of ['telegram', 'wechatWork', 'serverchan']) {
    if (out.channels && out.channels[ch]) {
      const c = out.channels[ch];
      if (ch === 'telegram' && c.botToken && c.botToken.includes('****')) {
        // 占位符：不修改
        delete c.botToken;
      }
      if (ch === 'wechatWork' && c.webhookUrl && c.webhookUrl.includes('****')) {
        delete c.webhookUrl;
      }
      if (ch === 'serverchan' && c.sendKey && c.sendKey.includes('****')) {
        delete c.sendKey;
      }
    }
  }
  return out;
}

router.get('/config', (req, res) => {
  const cfg = notify.getConfig();
  res.json({ ok: true, config: maskConfig(cfg), channels: notify.CHANNELS, events: notify.EVENTS });
});

router.post('/config', wrap(async (req, res) => {
  const body = req.body || {};
  const unmasked = unmaskConfig(body);
  const cfg = notify.setConfig(unmasked);
  res.json({ ok: true, config: maskConfig(cfg) });
}));

router.post('/test', wrap(async (req, res) => {
  try {
    const result = await notify.test();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}));

router.post('/test/:channel', wrap(async (req, res) => {
  try {
    const result = await notify.test(req.params.channel);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}));

router.get('/log', (req, res) => {
  const log = notify.loadLog();
  res.json({ ok: true, log });
});

module.exports = router;
