// 节点延迟历史路由（v1.13.0+）
// GET /api/nodes/:tag/history?hours=168
// GET /api/history?hours=168   （全部节点聚合）
// DELETE /api/nodes/:tag/history （清空某节点历史）
// DELETE /api/history           （清空全部历史）

const express = require('express');
const router = express.Router();
const xray = require('../xray');
const { wrap } = require('./_utils');

// 单节点历史
router.get('/nodes/:tag/history', wrap(async (req, res) => {
  const hours = Math.min(720, Math.max(1, parseInt(req.query.hours) || 168));  // 上限 30d
  const list = xray.history.getHistory(req.params.tag, hours);
  res.json({ ok: true, tag: req.params.tag, hours, count: list.length, history: list });
}));

// 全部节点历史（聚合）
router.get('/history', wrap(async (req, res) => {
  const hours = Math.min(720, Math.max(1, parseInt(req.query.hours) || 168));
  const all = xray.history.getAllHistory(hours);
  // 同时返回节点元信息（tag + 当前健康状态）方便前端绘图
  const cfg = xray.getConfig();
  const nodes = {};
  for (const o of (cfg.outbounds || [])) {
    nodes[o.tag] = { tag: o.tag, protocol: o.protocol, address: o._address };
  }
  res.json({ ok: true, hours, nodes, history: all });
}));

router.delete('/nodes/:tag/history', wrap(async (req, res) => {
  xray.history.clearNode(req.params.tag);
  res.json({ ok: true, msg: '节点历史已清空' });
}));

router.delete('/history', wrap(async (req, res) => {
  xray.history.clearAll();
  res.json({ ok: true, msg: '全部历史已清空' });
}));

module.exports = router;
