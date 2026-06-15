// 生命周期路由（start/stop/restart）
const express = require('express');
const router = express.Router();
const xray = require('../xray');
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

// 停止代理
router.post('/stop', wrap(async (req, res) => {
  const result = await xray.stopXray();
  res.json(result);
}));

// 重启代理
router.post('/restart', wrap(async (req, res) => {
  status.setStartingUp(true);
  try {
    const result = await xray.restartXray();
    res.json(result);
  } finally {
    status.setStartingUp(false);
  }
}));

module.exports = router;
