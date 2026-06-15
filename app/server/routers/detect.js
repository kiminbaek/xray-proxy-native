// xray 二进制检测路由
const express = require('express');
const router = express.Router();
const xray = require('../xray');
const { wrap } = require('./_utils');

router.get('/', (req, res) => {
  const bin = xray.findXray();
  res.json({ found: !!bin, path: bin });
});

router.post('/', wrap(async (req, res) => {
  const { path } = req.body;
  if (!path) return res.status(400).json({ ok: false, error: '缺少 path 参数' });
  const found = xray.findXray(path);
  res.json({ found: !!found, path: found });
}));

module.exports = router;
