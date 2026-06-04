// 鉴权模块 - v1.3.0+
// Token 存储在 ${TRIM_PKGVAR}/auth.json，权限 0600
// cmd/main 启动时负责生成（首次）/ 复用（后续）
// 所有 /api/* 路由（除 /api/auth/* 自身）必须通过 Bearer Token

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const errorStats = require('./error_stats');

const TRIM_PKGVAR = process.env.TRIM_PKGVAR || path.join(require('os').tmpdir(), 'xray-proxy-native');
const AUTH_FILE = path.join(TRIM_PKGVAR, 'auth.json');

// ====== Token 生成 / 加载 / 校验 ======

function generateToken() {
  // 24 字节 → base64url → 32 字符，无 +/=
  return crypto.randomBytes(24).toString('base64url');
}

function loadToken() {
  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (data && typeof data.token === 'string' && /^[A-Za-z0-9_-]{32,48}$/.test(data.token)) {
      return data.token;
    }
  } catch (_) {}
  return null;
}

function saveToken(token) {
  const data = {
    token,
    created: new Date().toISOString(),
    version: '1.0'
  };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  // 尝试收紧权限（root 用户写的，普通用户读不了）
  try { fs.chmodSync(AUTH_FILE, 0o600); } catch (_) {}
}

function isInitialized() {
  return loadToken() !== null;
}

function verifyToken(provided) {
  if (!provided || typeof provided !== 'string') return false;
  const expected = loadToken();
  if (!expected) return false;
  // 防时序攻击 + 长度快速失败
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(provided, 'utf8'),
      Buffer.from(expected, 'utf8')
    );
  } catch (_) {
    return false;
  }
}

function getAuthMeta() {
  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return { initialized: true, created: data.created, path: AUTH_FILE };
  } catch (_) {
    return { initialized: false, path: AUTH_FILE };
  }
}

// ====== 中间件 ======
// 保护 /api/* 路由（除 /api/auth/check 和 /api/auth/login 自身）
function authMiddleware(req, res, next) {
  const url = req.path || req.url;
  // auth 路由自身放行
  if (url === '/auth/check' || url === '/auth/login') {
    return next();
  }
  // 鉴权未初始化（cmd/main 还没生成 token）→ 503 引导用户看日志
  if (!isInitialized()) {
    return res.status(503).json({
      ok: false,
      error: 'Auth not initialized. Token is being generated on first startup. Please wait or check info.log.',
      need_wait: true
    });
  }
  // 校验 token
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!verifyToken(token)) {
    errorStats.recordAuthFail(req.originalUrl || url);
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized',
      need_login: true
    });
  }
  next();
}

module.exports = {
  generateToken,
  loadToken,
  saveToken,
  isInitialized,
  verifyToken,
  getAuthMeta,
  authMiddleware,
  AUTH_FILE
};
