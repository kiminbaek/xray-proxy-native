// 配置备份/导入路由（v1.9.0+，v1.13.0+ 加密压缩）
// v1.13.0 改动：
//   1. 导出支持密码加密（AES-256-GCM + PBKDF2-SHA256 100k 迭代）
//   2. 导出支持 gzip 压缩
//   3. 导入自动检测格式：v1 明文 / v2 加密压缩 / v2 压缩 / v2 加密
//   4. 旧 v1.9.0/v1.12.0 明文包仍可导入（向后兼容）
// 不包含：xray 二进制本身（37MB）、xray.log、info.log
// 不动：cmd/main, xray.js, nodes.js

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { wrap } = require('./_utils');
const { logToInfo } = require('../xray/utils');
// v1.14.0+ 导入校验：拒绝坏配置
const { validateConfig } = require('../xray/config');

const DATA_DIR = process.env.TRIM_PKGVAR || '/tmp/xray-proxy-native';
const MAX_IMPORT_BAK = 5;

// ====== v1.13.0+ 加密参数 ======
// v1.16.0+ 升级：KDF_ITERATIONS 100000 → 600000（OWASP 2023+ PBKDF2-SHA256 推荐）
// 向后兼容：旧备份记录 kdfIterations=100000，导入时按记录值派生（不丢失）
const KDF_ALGO = 'pbkdf2-sha256';
const KDF_ITERATIONS = 600000;       // PBKDF2 迭代次数（OWASP 2023+ 推荐 600k）
const SALT_LEN = 16;                 // salt 长度
const IV_LEN = 12;                   // GCM IV 长度（推荐 12 字节）
const KEY_LEN = 32;                  // AES-256 密钥长度
const CIPHER = 'aes-256-gcm';        // 认证加密（防篡改）

// ====== 导出 ======
// query 参数：
//   password=xxx   启用加密（PBKDF2-AES-256-GCM）
//   compress=true  启用 gzip 压缩
// 不传任何参数 = v1.9.0 旧格式（明文 JSON，向后兼容）
router.get('/export', (req, res) => {
  try {
    const password = req.query.password ? String(req.query.password) : null;
    const compress = req.query.compress === 'true' || req.query.compress === '1';
    const plain = {
      version: '1.13.0',
      exportedAt: new Date().toISOString(),
      app: 'xray-proxy-native',
      config: readJsonSafe(path.join(DATA_DIR, 'xray', 'config.json')),
      auth: readJsonSafe(path.join(DATA_DIR, 'auth.json')),
      traffic: readJsonSafe(path.join(DATA_DIR, 'traffic_state.json'))
    };
    let out;
    if (password) {
      // 加密 + （可选）压缩
      const json = JSON.stringify(plain);
      let data = Buffer.from(json, 'utf-8');
      if (compress) data = zlib.gzipSync(data);
      const salt = crypto.randomBytes(SALT_LEN);
      const iv = crypto.randomBytes(IV_LEN);
      const key = crypto.pbkdf2Sync(password, salt, KDF_ITERATIONS, KEY_LEN, 'sha256');
      const cipher = crypto.createCipheriv(CIPHER, key, iv);
      const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
      const tag = cipher.getAuthTag();
      out = {
        version: '1.13.0',
        app: 'xray-proxy-native',
        exportedAt: plain.exportedAt,
        encrypted: true,
        compressed: compress,
        kdf: KDF_ALGO,
        kdfIterations: KDF_ITERATIONS,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        ciphertext: encrypted.toString('base64')
      };
      logToInfo(`[backup] 导出加密压缩包 (compress=${compress}, ciphertext=${encrypted.length}B)`);
    } else if (compress) {
      // 仅压缩（无密码）
      const json = JSON.stringify(plain);
      const gz = zlib.gzipSync(Buffer.from(json, 'utf-8'));
      out = {
        version: '1.13.0',
        app: 'xray-proxy-native',
        exportedAt: plain.exportedAt,
        encrypted: false,
        compressed: true,
        data: gz.toString('base64')
      };
      logToInfo(`[backup] 导出压缩包 (gzipped=${gz.length}B)`);
    } else {
      // 明文（向后兼容 v1.9.0/v1.12.0）
      out = { version: '1.12.0', ...plain };
      logToInfo('[backup] 导出明文包（兼容旧版）');
    }
    res.json({ ok: true, data: out });
  } catch (e) {
    logToInfo('[backup] 导出失败: ' + e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ====== 导入 ======
// 自动检测格式：v1 明文 / v2 加密 / v2 压缩
// body: { data: <imported_pkg>, password?: 'xxx', options?: { includeTraffic?: bool } }
router.post('/import', wrap(async (req, res) => {
  const { data, password, options } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ ok: false, error: '缺少 data 参数' });
  }
  if (data.app !== 'xray-proxy-native') {
    return res.status(400).json({ ok: false, error: '数据格式不匹配（app 字段）' });
  }

  let plain = data;
  // v1.13.0 加密包 → 解密
  if (data.encrypted) {
    if (!password) return res.status(400).json({ ok: false, error: '加密包需要密码' });
    if (!data.salt || !data.iv || !data.tag || !data.ciphertext) {
      return res.status(400).json({ ok: false, error: '加密包字段不完整' });
    }
    if (data.kdf !== KDF_ALGO) {
      return res.status(400).json({ ok: false, error: '不支持的 KDF: ' + data.kdf });
    }
    try {
      const salt = Buffer.from(data.salt, 'base64');
      const iv = Buffer.from(data.iv, 'base64');
      const tag = Buffer.from(data.tag, 'base64');
      const ciphertext = Buffer.from(data.ciphertext, 'base64');
      const key = crypto.pbkdf2Sync(password, salt, data.kdfIterations || KDF_ITERATIONS, KEY_LEN, 'sha256');
      const decipher = crypto.createDecipheriv(CIPHER, key, iv);
      decipher.setAuthTag(tag);
      let decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (data.compressed) decrypted = zlib.gunzipSync(decrypted);
      plain = JSON.parse(decrypted.toString('utf-8'));
      logToInfo(`[backup] 解密成功 (compressed=${!!data.compressed}, ${decrypted.length}B)`);
    } catch (e) {
      // GCM tag 验证失败 / PBKDF2 错 / JSON 解析错 → 统一报"密码错或包损坏"
      logToInfo('[backup] 解密失败: ' + e.message);
      return res.status(400).json({ ok: false, error: '解密失败（密码错误或包损坏）' });
    }
  } else if (data.compressed) {
    // v1.13.0 仅压缩（无密码）
    if (!data.data) return res.status(400).json({ ok: false, error: '压缩包字段不完整' });
    try {
      const gz = Buffer.from(data.data, 'base64');
      const json = zlib.gunzipSync(gz).toString('utf-8');
      plain = JSON.parse(json);
      logToInfo(`[backup] 解压成功 (${gz.length}B)`);
    } catch (e) {
      return res.status(400).json({ ok: false, error: '解压失败: ' + e.message });
    }
  }
  // 旧版明文：plain === data，直接用

  if (!plain.version) {
    return res.status(400).json({ ok: false, error: '数据格式不匹配（version 字段）' });
  }

  // 备份当前配置
  backupCurrent();

  const { config, auth, traffic } = plain;
  const imported = [];
  if (config && typeof config === 'object') {
    // v1.14.0+ 导入前校验：坏配置直接拒绝，避免污染磁盘
    const errs = validateConfig(config);
    if (errs.length > 0) {
      logToInfo('[backup] 导入拒绝: 配置无效 ' + errs.join('；'));
      return res.status(400).json({ ok: false, error: '配置无效：' + errs.join('；') + '。请检查导入的配置文件' });
    }
    // 额外校验：outbounds 至少 1 个用户代理节点（vless/vmess/trojan/shadowsocks）
    // 避免导入一个"空配置"（仅系统节点）→ 启动后无代理可走
    const REAL_PROXY_PROTOCOLS = new Set(['vless', 'vmess', 'trojan', 'shadowsocks']);
    const hasUserNode = (config.outbounds || []).some(o => REAL_PROXY_PROTOCOLS.has(o.protocol));
    if (!hasUserNode) {
      logToInfo('[backup] 导入拒绝: 没有任何用户代理节点');
      return res.status(400).json({ ok: false, error: '导入的配置没有任何用户代理节点（vless/vmess/trojan/shadowsocks）' });
    }
    writeJsonSafe(path.join(DATA_DIR, 'xray', 'config.json'), config);
    imported.push('config');
  }
  if (auth && typeof auth === 'object' && auth.token) {
    writeJsonSafe(path.join(DATA_DIR, 'auth.json'), auth);
    imported.push('auth');
  }
  if (traffic && typeof traffic === 'object' && options && options.includeTraffic) {
    writeJsonSafe(path.join(DATA_DIR, 'traffic_state.json'), traffic);
    imported.push('traffic');
  }

  logToInfo(`[backup] 配置已导入: ${imported.join(', ')}`);
  res.json({ ok: true, imported, msg: '导入成功，请重启 xray 使配置生效' });
}));

// 重置：清空 config + traffic + health，保留 auth + xray 二进制 + config.json.bak
router.post('/reset', wrap(async (req, res) => {
  backupCurrent();
  try { fs.unlinkSync(path.join(DATA_DIR, 'xray', 'config.json')); } catch (_) {}
  try { fs.unlinkSync(path.join(DATA_DIR, 'traffic_state.json')); } catch (_) {}
  try { fs.unlinkSync(path.join(DATA_DIR, 'node_health.json')); } catch (_) {}
  logToInfo('[backup] 已重置 config + traffic + health，保留 auth + xray 二进制 + config.json.bak');
  res.json({ ok: true, msg: '已重置' });
}));

// ====== 内部函数 ======
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return null; }
}
function writeJsonSafe(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  try { fs.chmodSync(p, 0o600); } catch (_) {}
}

function backupCurrent() {
  const ts = Date.now();
  const files = [
    ['xray/config.json', '.import-bak.' + ts],
    ['auth.json', '.import-bak.' + ts],
    ['traffic_state.json', '.import-bak.' + ts]
  ];
  for (const [rel, suffix] of files) {
    const src = path.join(DATA_DIR, rel);
    const dst = path.join(DATA_DIR, rel + suffix);
    try { fs.copyFileSync(src, dst); } catch (_) {}
  }
  cleanupOldBackups();
}

function cleanupOldBackups() {
  try {
    const entries = fs.readdirSync(DATA_DIR);
    const groups = {};
    for (const f of entries) {
      if (!f.includes('.import-bak.')) continue;
      const baseName = f.split('.import-bak.')[0];
      if (!groups[baseName]) groups[baseName] = [];
      groups[baseName].push(f);
    }
    for (const baseName of Object.keys(groups)) {
      const list = groups[baseName].sort();
      const toDelete = list.slice(0, Math.max(0, list.length - MAX_IMPORT_BAK));
      for (const f of toDelete) {
        try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch (_) {}
      }
    }
    const xrayDir = path.join(DATA_DIR, 'xray');
    if (fs.existsSync(xrayDir)) {
      const xrayEntries = fs.readdirSync(xrayDir);
      const xrayGroups = {};
      for (const f of xrayEntries) {
        if (!f.includes('.import-bak.')) continue;
        const baseName = f.split('.import-bak.')[0];
        if (!xrayGroups[baseName]) xrayGroups[baseName] = [];
        xrayGroups[baseName].push(f);
      }
      for (const baseName of Object.keys(xrayGroups)) {
        const list = xrayGroups[baseName].sort();
        const toDelete = list.slice(0, Math.max(0, list.length - MAX_IMPORT_BAK));
        for (const f of toDelete) {
          try { fs.unlinkSync(path.join(xrayDir, f)); } catch (_) {}
        }
      }
    }
  } catch (_) { /* 清理失败不影响备份 */ }
}

module.exports = router;
