// 鉴权路由（无需 token）
// v1.15.0+ 新增：/status /setup /refresh + login 接受账号密码
const express = require('express');
const router = express.Router();
const auth = require('../auth');
const { wrap } = require('./_utils');

// 兼容 v1.14.0 老的前端代码（GET /api/auth/check）
// v1.15.0+ 推荐用 /api/auth/status（多了 hasPassword + status 字段）
router.get('/check', (req, res) => {
  const meta = auth.getAuthMeta();
  res.json({ ok: true, ...meta });
});

// v1.15.0+ 检查鉴权状态（前端启动时调用，决定显示 设置密码 / 账号密码登录）
router.get('/status', (req, res) => {
  const meta = auth.getAuthMeta();
  res.json({ ok: true, ...meta });
});

// v1.15.0+ 首次设置密码（仅在 setup_needed 时可用）
// 同时生成 access token + refresh token，返回前端
// 老用户升级到 v1.15.0 时：token 已存在但 hasPassword=false，调用此端点把密码写入
router.post('/setup', wrap(async (req, res) => {
  const { password } = req.body || {};
  // v1.16.0+ 锁定检查（防暴力设置密码，覆盖场景）
  const ip = auth.getClientIp(req);
  const setupLock = auth.isLocked(ip);
  if (setupLock) {
    res.set('Retry-After', Math.ceil(setupLock.retryAfterMs / 1000));
    return res.status(429).json({
      ok: false,
      error: `尝试次数过多，请 ${Math.ceil(setupLock.retryAfterMs / 1000)} 秒后重试`,
      locked: true,
      retry_after: Math.ceil(setupLock.retryAfterMs / 1000)
    });
  }
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ ok: false, error: '缺少 password 参数' });
  }
  if (auth.hasPassword()) {
    return res.status(409).json({ ok: false, error: '密码已设置，如需修改请卸载后重装（或手动清理 auth.json）' });
  }
  if (!auth.isInitialized()) {
    return res.status(503).json({ ok: false, error: 'Token 尚未初始化（cmd/main 启动生成中），请稍候' });
  }
  try {
    auth.setPassword(password);
    // 同时生成 refresh token（首次设置时一并生成）
    const refresh = auth.rotateRefreshToken();
    res.json({
      ok: true,
      token: auth.loadToken(),
      refresh_token: refresh.token,
      refresh_expires: refresh.expires,
      access_ttl: auth.getAccessTokenTtl()
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}));

// v1.15.0+ 登录（兼容 token 登录 + 账号密码登录两种模式）
//  - body { token: 'xxx' }    v1.14.0 兼容（用 token 登录）
//  - body { password: 'xxx' } v1.15.0+（用账号密码登录，hasPassword 必须为 true）
router.post('/login', wrap(async (req, res) => {
  const { token, password } = req.body || {};
  // v1.16.0+ 登录失败锁定检查（防暴力破解）
  const ip = auth.getClientIp(req);
  const lockStatus = auth.isLocked(ip);
  if (lockStatus) {
    res.set('Retry-After', Math.ceil(lockStatus.retryAfterMs / 1000));
    // v1.16.0+ 通知：登录失败锁定（仅在「刚触发」时通知：lockUntil 刚生成）
    // 防刷屏：每 IP 锁定期间最多通知一次
    if (!lockStatus._notified) {
      try {
        const notify = require('../notify');
        notify.send('login_locked', {
          title: '登录失败锁定',
          message: `IP ${ip} 登录失败达到 ${lockStatus.attempts || lockStatus.maxAttempts} 次，已锁定 ${Math.ceil(lockStatus.retryAfterMs / 1000)} 秒\n如非本人操作，请检查面板安全`
        }).catch(() => {});
      } catch (_) {}
    }
    return res.status(429).json({
      ok: false,
      error: `尝试次数过多，请 ${Math.ceil(lockStatus.retryAfterMs / 1000)} 秒后重试`,
      locked: true,
      retry_after: Math.ceil(lockStatus.retryAfterMs / 1000)
    });
  }
  // 模式 1：账号密码登录（v1.20.1 起优先 password，避免前端同时提交 token/password 时误走 token 分支）
  if (password && typeof password === 'string') {
    if (!auth.hasPassword()) {
      return res.status(400).json({ ok: false, error: '尚未设置密码，请先设置密码', setup_needed: true });
    }
    if (!auth.verifyPassword(password)) {
      // v1.16.0+ 记录失败次数（可能触发锁定）
      const failResult = auth.recordFailedLogin(ip);
      if (failResult && failResult.locked) {
        res.set('Retry-After', Math.ceil(failResult.retryAfterMs / 1000));
        return res.status(429).json({
          ok: false,
          error: `密码错误，已触发锁定（${failResult.attempts}/${failResult.maxAttempts} 次），请 ${Math.ceil(failResult.retryAfterMs / 1000)} 秒后重试`,
          locked: true,
          attempts: failResult.attempts,
          retry_after: Math.ceil(failResult.retryAfterMs / 1000)
        });
      }
      return res.status(401).json({
        ok: false,
        error: '密码错误',
        attempts: failResult ? failResult.attempts : 1,
        remaining: failResult ? failResult.remaining : 0
      });
    }
    // 验证成功 → 清除失败记录 + 返回 token
    auth.clearFailedLogin(ip);
    let refresh = auth.loadRefreshToken();
    if (!refresh) refresh = auth.rotateRefreshToken();
    return res.json({
      ok: true,
      token: auth.loadToken(),
      refresh_token: refresh.token,
      refresh_expires: refresh.expires,
      access_ttl: auth.getAccessTokenTtl()
    });
  }

  // 模式 2：token 登录（兼容 v1.14.0 老用户，不计入失败锁定）
  if (token && typeof token === 'string') {
    if (!auth.verifyToken(token)) {
      return res.status(401).json({ ok: false, error: 'Token 错误' });
    }
    // 顺便给老用户发 refresh token（如果还没生成过）
    let refresh = auth.loadRefreshToken();
    if (!refresh) refresh = auth.rotateRefreshToken();
    // 登录成功 → 清除该 IP 的失败记录
    auth.clearFailedLogin(ip);
    return res.json({
      ok: true,
      token,
      refresh_token: refresh.token,
      refresh_expires: refresh.expires,
      access_ttl: auth.getAccessTokenTtl()
    });
  }
  return res.status(400).json({ ok: false, error: '缺少 token 或 password 参数' });
}));

// v1.15.0+ 刷新 access token（前端 setInterval 50 分钟调一次）
// 用 refresh_token 换新的 access token + 新的 refresh_token（refresh 轮换）
router.post('/refresh', wrap(async (req, res) => {
  const { refresh_token } = req.body || {};
  if (!refresh_token || typeof refresh_token !== 'string') {
    return res.status(400).json({ ok: false, error: '缺少 refresh_token 参数' });
  }
  const newRefresh = auth.verifyAndRotateRefreshToken(refresh_token);
  if (!newRefresh) {
    return res.status(401).json({ ok: false, error: 'refresh_token 无效或已过期', need_login: true });
  }
  res.json({
    ok: true,
    token: auth.loadToken(),
    refresh_token: newRefresh.token,
    refresh_expires: newRefresh.expires,
    access_ttl: auth.getAccessTokenTtl()
  });
}));

module.exports = router;
