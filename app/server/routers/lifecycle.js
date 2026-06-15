// 生命周期路由（start/stop/restart）
const express = require('express');
const router = express.Router();
const xray = require('../xray');
const config = require('../xray/config');
const { logToInfo } = require('../xray/utils');
const status = require('./status');
const { wrap } = require('./_utils');

// 启动代理（带"启动中"状态）
router.post('/start', wrap(async (req, res) => {
  status.setStartingUp(true);
  try {
    const result = await xray.startXray();
    res.json(result);
  } finally {
    status.setStartingUp(false);
  }
}));

async function stopTunSafelyIfEnabled() {
  const tunConfig = config.getTunConfig();
  if (!tunConfig || !tunConfig.enabled) return { skipped: true, reason: 'TUN 未启用' };
  logToInfo(`[tun] lifecycle stop: TUN enabled, cleanup before stopping xray (${tunConfig.name})`);
  const cleanupBefore = config.cleanupTun(tunConfig.name);
  const apply = config.applyTunToConfig(false, tunConfig);
  const cleanupAfter = config.cleanupTun(tunConfig.name);
  return { skipped: false, cleanupBefore, apply, cleanupAfter };
}

// 停止代理：如果 TUN 已启用，先关闭 TUN 配置并清理残留，避免仅停止 xray 后断网
router.post('/stop', wrap(async (req, res) => {
  const tun = await stopTunSafelyIfEnabled();
  const result = await xray.stopXray();
  res.json({ ...result, tun });
}));

// 重启代理
router.post('/restart', wrap(async (req, res) => {
  status.setStartingUp(true);
  try {
    const tun = await stopTunSafelyIfEnabled();
    const result = await xray.restartXray();
    res.json({ ...result, tun });
  } finally {
    status.setStartingUp(false);
  }
}));

module.exports = router;
