// 鉴权路由（无需 token）
const express = require('express');
const router = express.Router();
const auth = require('../auth');
const { wrap } = require('./_utils');

// 检查鉴权状态（前端启动时调用，决定显示登录页还是主界面）
router.get('/check', (req, res) => {
  const meta = auth.getAuthMeta();
  res.json({ ok: true, ...meta });
});

// 验证 token 是否正确（前端登录时调用）
router.post('/login', wrap(async (req, res) => {
  const { token } = req.body || {};
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ ok: false, error: '缺少 token 参数' });
  }
  if (!auth.verifyToken(token)) {
    return res.status(401).json({ ok: false, error: 'Token 错误' });
  }
  res.json({ ok: true });
}));

module.exports = router;
