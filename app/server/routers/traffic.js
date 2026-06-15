// 流量统计路由
const express = require('express');
const router = express.Router();
const xray = require('../xray');
const { wrap } = require('./_utils');

router.get('/', wrap(async (req, res) => {
  res.json(await xray.getTraffic());
}));

// v1.10.0+ 24h 流量历史（用于图表）
router.get('/history', (req, res) => {
  res.json({ ok: true, history: xray.getHistory() });
});

module.exports = router;
