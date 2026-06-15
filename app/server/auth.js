// 鉴权模块 - v1.3.0+
// v1.15.0+ 账号密码登录：scrypt 加盐 hash + refresh token
// Token 存储在 ${TRIM_PKGVAR}/auth.json，权限 0600
// auth.json 格式：
//   v1.0/v1.14.0 旧: { token, created, version }
//   v1.15.0+ 新: { token, created, version: '1.1', password_hash, password_salt, refresh_token, refresh_expires, password_set_at }
// 所有 /api/* 路由（除 /api/auth/* 自身）必须通过 Bearer Token

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const errorStats = require('./error_stats');

const TRIM_PKGVAR = process.env.TRIM_PKGVAR || path.join(require('os').tmpdir(), 'xray-proxy-native');
const AUTH_FILE = path.join(TRIM_PKGVAR, 'auth.json');
const FAILED_LOGINS_FILE = path.join(TRIM_PKGVAR, 'failed_logins.json');

// ====== 内部 helper：读写 auth.json 完整结构 ======

function loadAuthData() {
  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function saveAuthData(data) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(AUTH_FILE, 0o600); } catch (_) {}
}

// ====== Token 生成 / 加载 / 校验 ======

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function loadToken() {
  const data = loadAuthData();
  if (data && typeof data.token === 'string' && /^[A-Za-z0-9_-]{32,48}$/.test(data.token)) {
    return data.token;
  }
  return null;
}

function saveToken(token) {
  // v1.15.0+ 保留其他字段（password_hash / refresh_token 等），不覆盖
  const existing = loadAuthData() || {};
  const data = {
    ...existing,
    token,
    created: existing.created || new Date().toISOString(),
    version: '1.1'
  };
  saveAuthData(data);
}

function isInitialized() {
  return loadToken() !== null;
}

function verifyToken(provided) {
  if (!provided || typeof provided !== 'string') return false;
  const expected = loadToken();
  if (!expected) return false;
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

// ====== v1.15.0+ 账号密码（scrypt 加盐 hash，Node.js 内置，无新依赖）======
// v1.16.0+ 升级：SCRYPT_N 16384 → 131072（OWASP 2023+ 推荐 2^17）
// 向后兼容：旧 hash 用 16384 校验；登录成功后自动用 131072 重写（无感升级）

const SCRYPT_KEYLEN = 64;          // 64 字节 = 512 bits
const SCRYPT_N_LEGACY = 16384;     // 2^14（v1.15.0 旧值）
const SCRYPT_N_CURRENT = 131072;   // 2^17（v1.16.0+ 新值，OWASP 2023+）
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;  // 256MB（131072 需 ~256MB maxmem）
const PASSWORD_MIN_LEN = 6;

function generateSalt() {
  return crypto.randomBytes(16).toString('base64');
}

function hashPassword(password, saltBase64, n) {
  const salt = Buffer.from(saltBase64, 'base64');
  const useN = n || SCRYPT_N_CURRENT;
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: useN, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }).toString('base64');
}

function setPassword(password) {
  if (!password || typeof password !== 'string' || password.length < PASSWORD_MIN_LEN) {
    throw new Error('密码至少 ' + PASSWORD_MIN_LEN + ' 字符');
  }
  const existing = loadAuthData() || {};
  if (!existing.token) {
    throw new Error('token 未初始化，先调用 generateToken() / saveToken()');
  }
  const salt = generateSalt();
  const hash = hashPassword(password, salt, SCRYPT_N_CURRENT);
  const data = {
    ...existing,
    password_hash: hash,
    password_salt: salt,
    scrypt_n: SCRYPT_N_CURRENT,
    password_set_at: new Date().toISOString(),
    version: '1.1'
  };
  saveAuthData(data);
}

function verifyPassword(password) {
  if (!password || typeof password !== 'string') return false;
  const data = loadAuthData();
  if (!data || !data.password_hash || !data.password_salt) return false;
  // 读 scrypt_n：未设置（旧版）= 16384；已设置 = 实际值
  const n = (typeof data.scrypt_n === 'number' && data.scrypt_n > 0) ? data.scrypt_n : SCRYPT_N_LEGACY;
  let expected, candidate;
  try {
    expected = Buffer.from(data.password_hash, 'base64');
    candidate = Buffer.from(hashPassword(password, data.password_salt, n), 'base64');
  } catch (_) {
    return false;
  }
  if (expected.length !== candidate.length) return false;
  let ok = false;
  try {
    ok = crypto.timingSafeEqual(expected, candidate);
  } catch (_) {
    return false;
  }
  // 升级路径：旧 N（< 131072）登录成功后自动用 131072 重写（无感升级）
  if (ok && n < SCRYPT_N_CURRENT) {
    try {
      const newSalt = generateSalt();
      const newHash = hashPassword(password, newSalt, SCRYPT_N_CURRENT);
      const updated = {
        ...data,
        password_hash: newHash,
        password_salt: newSalt,
        scrypt_n: SCRYPT_N_CURRENT,
        password_upgraded_at: new Date().toISOString(),
        version: '1.1'
      };
      saveAuthData(updated);
    } catch (e) {
      // 升级失败：不影响登录成功
      console.error('[auth] auto-upgrade scrypt_n failed:', e.message);
    }
  }
  return ok;
}

function hasPassword() {
  const data = loadAuthData();
  return !!(data && data.password_hash && data.password_salt);
}

// ====== v1.15.0+ Refresh Token（短期 access 1h + 长期 refresh 30d）======

const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60 * 1000;  // 30 天
const ACCESS_TOKEN_TTL = 60 * 60 * 1000;              // 1 小时

function generateRefreshToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function loadRefreshToken() {
  const data = loadAuthData();
  if (data && data.refresh_token && data.refresh_expires && data.refresh_expires > Date.now()) {
    return { token: data.refresh_token, expires: data.refresh_expires };
  }
  return null;
}

function rotateRefreshToken() {
  const existing = loadAuthData() || {};
  const refresh_token = generateRefreshToken();
  const refresh_expires = Date.now() + REFRESH_TOKEN_TTL;
  const data = {
    ...existing,
    refresh_token,
    refresh_expires,
    version: '1.1'
  };
  saveAuthData(data);
  return { token: refresh_token, expires: refresh_expires };
}

function verifyAndRotateRefreshToken(provided) {
  if (!provided || typeof provided !== 'string') return null;
  const current = loadRefreshToken();
  if (!current) return null;
  if (provided.length !== current.token.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(current.token, 'utf8'))) {
      return null;
    }
  } catch (_) {
    return null;
  }
  // 验证通过 → 轮换（旧 refresh 立即失效，refresh token 轮换安全实践）
  return rotateRefreshToken();
}

function getAccessTokenTtl() {
  return ACCESS_TOKEN_TTL;
}

// ====== 元信息（前端 /api/auth/status 调用）======

function getAuthMeta() {
  const data = loadAuthData();
  if (!data) {
    return { initialized: false, hasPassword: false, status: 'setup_needed', path: AUTH_FILE };
  }
  const initialized = !!data.token;
  const hasPwd = !!(data.password_hash && data.password_salt);
  let status;
  if (!initialized) status = 'setup_needed';  // cmd/main 还没生成 token（极罕见，503 引导）
  else if (!hasPwd) status = 'setup_needed';  // 老用户升级到 v1.15.0：强制设置密码
  else status = 'password_set';
  return {
    initialized,
    hasPassword: hasPwd,
    status,
    created: data.created,
    passwordSetAt: data.password_set_at,
    refreshExpires: data.refresh_expires,
    path: AUTH_FILE
  };
}

// ====== 中间件 ======
// 保护 /api/* 路由（除 /api/auth/* 自身）
function authMiddleware(req, res, next) {
  const url = req.path || req.url;
  // v1.15.0+ auth 路由白名单：/check /login /status /setup /refresh
  if (url === '/auth/check' || url === '/auth/login' || url === '/auth/status' || url === '/auth/setup' || url === '/auth/refresh') {
    return next();
  }
  if (!isInitialized()) {
    return res.status(503).json({
      ok: false,
      error: 'Auth not initialized. Token is being generated on first startup. Please wait or check info.log.',
      need_wait: true
    });
  }
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

// ====== v1.16.0+ 登录失败锁定（防暴力破解）======
// 锁定配置存 auth.json 的 lockout 字段；未设置则用 LOCKOUT_DEFAULT
// 失败记录存 failed_logins.json（持久化，重启不丢）
const LOCKOUT_DEFAULT = {
  enabled: true,            // 是否启用锁定
  maxAttempts: 5,           // 5 次错误后锁定
  lockoutMs: 5 * 60 * 1000  // 锁 5 分钟
};

function getLockoutConfig() {
  const data = loadAuthData() || {};
  return { ...LOCKOUT_DEFAULT, ...(data.lockout || {}) };
}

function loadFailedLogins() {
  try {
    const raw = fs.readFileSync(FAILED_LOGINS_FILE, 'utf-8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_) {
    return {};
  }
}

function saveFailedLogins(obj) {
  try {
    fs.writeFileSync(FAILED_LOGINS_FILE, JSON.stringify(obj, null, 2), { mode: 0o600 });
    try { fs.chmodSync(FAILED_LOGINS_FILE, 0o600); } catch (_) {}
  } catch (e) {
    // 持久化失败：记录但不抛错（不影响登录流程）
    console.error('[auth] save failed_logins.json failed:', e.message);
  }
}

function getClientIp(req) {
  // 优先 x-forwarded-for（fnOS 反代场景）
  const xff = req.headers['x-forwarded-for'];
  if (xff && typeof xff === 'string') {
    return xff.split(',')[0].trim();
  }
  // 否则 socket remote address
  return (req.socket && req.socket.remoteAddress) || (req.connection && req.connection.remoteAddress) || 'unknown';
}

function clearFailedLogin(ip) {
  if (!ip) return;
  const all = loadFailedLogins();
  if (all[ip]) {
    delete all[ip];
    saveFailedLogins(all);
  }
}

function isLocked(ip) {
  if (!ip) return null;
  const cfg = getLockoutConfig();
  if (!cfg.enabled) return null;
  const all = loadFailedLogins();
  const rec = all[ip];
  if (!rec) return null;
  const now = Date.now();
  if (rec.lockUntil && rec.lockUntil > now) {
    return {
      locked: true,
      retryAfterMs: rec.lockUntil - now,
      attempts: rec.count || cfg.maxAttempts,
      maxAttempts: cfg.maxAttempts
    };
  }
  // 已过期 → 清理
  if (rec.lockUntil && rec.lockUntil <= now) {
    delete all[ip];
    saveFailedLogins(all);
  }
  return null;
}

function recordFailedLogin(ip) {
  if (!ip) return null;
  const cfg = getLockoutConfig();
  if (!cfg.enabled) return null;
  const all = loadFailedLogins();
  const now = Date.now();
  const rec = all[ip] || { count: 0, firstFailedAt: now };
  rec.count = (rec.count || 0) + 1;
  rec.lastFailedAt = now;
  if (rec.count >= cfg.maxAttempts) {
    rec.lockUntil = now + cfg.lockoutMs;
  }
  all[ip] = rec;
  saveFailedLogins(all);
  if (rec.lockUntil && rec.lockUntil > now) {
    return {
      locked: true,
      retryAfterMs: rec.lockUntil - now,
      attempts: rec.count,
      maxAttempts: cfg.maxAttempts
    };
  }
  return {
    locked: false,
    attempts: rec.count,
    remaining: cfg.maxAttempts - rec.count
  };
}

function setLockoutConfig(partial) {
  const existing = loadAuthData() || {};
  const cfg = { ...getLockoutConfig(), ...(partial || {}) };
  // 校验参数
  if (cfg.maxAttempts !== undefined) {
    cfg.maxAttempts = Math.max(1, Math.min(100, parseInt(cfg.maxAttempts) || 5));
  }
  if (cfg.lockoutMs !== undefined) {
    cfg.lockoutMs = Math.max(1000, Math.min(24 * 60 * 60 * 1000, parseInt(cfg.lockoutMs) || 300000));
  }
  const data = { ...existing, lockout: cfg, version: '1.1' };
  saveAuthData(data);
  return cfg;
}

function getLockStatus(ip) {
  const cfg = getLockoutConfig();
  const lock = isLocked(ip);
  if (lock) return { ...lock, enabled: cfg.enabled };
  const all = loadFailedLogins();
  const rec = all[ip];
  return {
    locked: false,
    enabled: cfg.enabled,
    attempts: rec ? rec.count : 0,
    remaining: rec ? Math.max(0, cfg.maxAttempts - rec.count) : cfg.maxAttempts
  };
}

function cleanupExpiredLocks() {
  // 清理已过期的锁定记录（防止文件膨胀）
  const all = loadFailedLogins();
  const now = Date.now();
  let changed = false;
  for (const ip of Object.keys(all)) {
    const rec = all[ip];
    if (rec && rec.lockUntil && rec.lockUntil <= now) {
      delete all[ip];
      changed = true;
    }
  }
  if (changed) saveFailedLogins(all);
  return Object.keys(all).length;
}

// 启动时清理一次 + 每小时清理一次过期记录
setTimeout(cleanupExpiredLocks, 60 * 1000);
setInterval(cleanupExpiredLocks, 60 * 60 * 1000).unref();

module.exports = {
  generateToken,
  loadToken,
  saveToken,
  isInitialized,
  verifyToken,
  setPassword,
  verifyPassword,
  hasPassword,
  generateRefreshToken,
  loadRefreshToken,
  verifyAndRotateRefreshToken,
  rotateRefreshToken,
  getAccessTokenTtl,
  getAuthMeta,
  authMiddleware,
  // v1.16.0+ 登录失败锁定
  getClientIp,
  isLocked,
  recordFailedLogin,
  clearFailedLogin,
  getLockStatus,
  setLockoutConfig,
  getLockoutConfig,
  cleanupExpiredLocks,
  AUTH_FILE
};
