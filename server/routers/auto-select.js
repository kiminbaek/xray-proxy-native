// 自动选择最优节点路由（v1.13.0+）
// GET    /api/auto-select           看当前配置 + 状态
// POST   /api/auto-select/config    改配置
// POST   /api/auto-select/tick      手动触发一次 tick（受抖动保护）
// POST   /api/auto-select/now       立即切换最优（不走抖动保护）
// POST   /api/auto-select/switch    切换到指定 tag（不走抖动保护）

const express = require('express');
const router = express.Router();
const xray = require('../xray');
const { wrap } = require('./_utils');

router.get('/', (req, res) => {
  res.json({
    ok: true,
    config: xray.autoSelect.getConfig(),
    current: xray.autoSelect.getCurrentPrimary(),
    optimal: xray.autoSelect.findOptimal(),
    optimalAvg: (() => {
      const t = xray.autoSelect.findOptimal();
      return t ? xray.autoSelect.avgLatency(t, xray.autoSelect.getConfig().avgWindow) : null;
    })()
  });
});

router.post('/config', (req, res) => {
  const cfg = xray.autoSelect.setConfig(req.body || {});
  res.json({ ok: true, config: cfg });
});

router.post('/tick', (req, res) => {
  const result = xray.autoSelect.tick();
  res.json({ ok: true, result });
});

router.post('/now', (req, res) => {
  // 立即切换最优（不走抖动保护）
  const optimal = xray.autoSelect.findOptimal();
  if (!optimal) return res.status(400).json({ ok: false, error: '无可用节点' });
  const result = xray.autoSelect.switchTo(optimal);
  res.json({ ok: true, optimal, result });
});

router.post('/switch', (req, res) => {
  const { tag } = req.body || {};
  if (!tag) return res.status(400).json({ ok: false, error: '缺少 tag' });
  const result = xray.autoSelect.switchTo(tag);
  res.json({ ok: true, result });
});

module.exports = router;
