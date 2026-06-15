// 日志路由
const express = require('express');
const router = express.Router();
const xray = require('../xray');

router.get('/', (req, res) => {
  const lines = Math.min(parseInt(req.query.lines) || 50, 500);
  res.json({ ok: true, logs: xray.getLogs(lines) });
});

router.post('/rotate', (req, res) => {
  res.json(xray.rotateLogs());
});

// v1.10.0+ SSE 实时日志推送
router.get('/tail', (req, res) => {
  xray.tailSSE(req, res);
});

module.exports = router;
