// 配置路由
const express = require('express');
const router = express.Router();
const xray = require('../xray');
const { wrap } = require('./_utils');

router.get('/', (req, res) => {
  res.json({ ok: true, config: xray.getConfig() });
});

// v1.12.0+ 加 wrap：防止 sanitizeConfig 异常直接崩 Express
router.post('/', wrap((req, res) => {
  const safe = xray.sanitizeConfig(req.body || {});
  xray.setConfig(safe);
  res.json({ ok: true });
}));

module.exports = router;
