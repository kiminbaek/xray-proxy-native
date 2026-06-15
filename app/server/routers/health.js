// 健康检查路由
const express = require('express');
const router = express.Router();
const { wrap } = require('./_utils');
const health = require('../xray/health');

// GET /api/health — 返回所有节点健康状态
router.get('/', (req, res) => {
  res.json({ ok: true, health: health.getHealth(), interval_ms: health.CHECK_INTERVAL, fail_threshold: health.FAIL_THRESHOLD });
});

// POST /api/health/check — 立即触发一次全量检查
router.post('/check', wrap(async (req, res) => {
  const h = await health.checkAll();
  res.json({ ok: true, checked: Object.keys(h).length, health: h });
}));

// POST /api/health/reset/:tag — 重置某节点
router.post('/reset/:tag', (req, res) => {
  const result = health.resetNode(req.params.tag);
  res.json({ ok: true, health: result });
});

module.exports = router;
