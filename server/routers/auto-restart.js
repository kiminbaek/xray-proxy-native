// 自动重启守护路由
const express = require('express');
const router = express.Router();
const xray = require('../xray');
const { wrap } = require('./_utils');

router.get('/', (req, res) => {
  res.json(xray.getAutoRestartStatus());
});

router.post('/', wrap(async (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  res.json(xray.setAutoRestart(enabled));
}));

module.exports = router;
