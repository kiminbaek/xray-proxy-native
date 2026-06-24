// TUN 模式路由（v1.17.0+）
// 透明代理：让本机所有进程的流量都走 xray（不只是 SOCKS5/HTTP 客户端）
// 实现原理：在 xray 配置中加 tun protocol inbound → 创建 /dev/net/tun 设备
// 前提：cmd/install_callback 已给 xray 二进制注入 cap_net_admin + cap_net_raw
// xray-core 26.6.1 TUN 配置：name/MTU/gateway[]/DNS[]/userLevel/autoSystemRoutingTable[]/autoOutboundsInterface
//
// API 设计：
//   GET  /api/tun/config    返 tun.json 当前配置 + xray 状态
//   POST /api/tun/config    改 tun.json 配置（新字段集）
//   POST /api/tun/start     启用 TUN（先 cleanupTun 防残留 → applyTunToConfig → restartXray 完全重启 → addTunRoutes 临时路由让应用自动走 TUN）
//   POST /api/tun/stop      关闭 TUN（delTunRoutes 清临时路由 → applyTunToConfig → restartXray 完全重启 → cleanupTun 清残留）
//   GET  /api/tun/status    返 TUN 实际运行状态
//   GET  /api/tun/backup    返 backup_network.sh 路径 + 手动恢复指南
//   POST /api/tun/cleanup   强制清理 TUN 残留（不依赖 xray 状态）

const express = require('express');
const router = express.Router();
const xray = require('../xray');
const config = require('../xray/config');
const status = require('./status');
const { wrap } = require('./_utils');
const { logToInfo } = require('../xray/utils');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.TRIM_PKGVAR || '/tmp/xray-proxy-native';

// 检测 TUN 设备是否存在（不依赖 ip 命令，sandbox 也能查）
// /sys/class/net/tun0 是符号链接，存在说明 tun 设备被创建
function checkTunDevice(name) {
  name = name || 'tun0';
  try {
    const stat = fs.lstatSync('/sys/class/net/' + name);
    if (stat.isSymbolicLink() || stat.isDirectory()) return true;
  } catch (_) {}
  return false;
}

// GET /api/tun/config - 返 tun.json + xray 状态
router.get('/config', wrap(async (req, res) => {
  const tunConfig = config.getTunConfig();
  const xrayStatus = xray.getStatus();
  res.json({
    ok: true,
    config: tunConfig,
    xray: {
      running: xrayStatus.running,
      pid: xrayStatus.pid
    },
    device: {
      exists: checkTunDevice(tunConfig.name)
    },
    safety: {
      // 返回备份文件路径（用户手动恢复用）
      backupScript: path.join(DATA_DIR, 'backup_network.sh'),
      backupConfig: path.join(DATA_DIR, 'network_backup.conf')
    }
  });
}));

// POST /api/tun/config - 改 tun.json 配置
// body: { name?, MTU?, gateway?, DNS?, userLevel?, autoSystemRoutingTable?, autoOutboundsInterface?, autoStart? }
router.post('/config', wrap(async (req, res) => {
  const current = config.getTunConfig();
  const updates = {};
  // name: 设备名（字符串）
  if (typeof req.body.name === 'string' && /^[a-zA-Z0-9_-]{1,16}$/.test(req.body.name)) {
    updates.name = req.body.name;
  }
  // MTU: 1280-1500
  if (typeof req.body.MTU === 'number' && req.body.MTU >= 1280 && req.body.MTU <= 1500) {
    updates.MTU = req.body.MTU;
  }
  // gateway: 数组（IP 列表）
  if (Array.isArray(req.body.gateway)) {
    const gw = req.body.gateway.filter(g => typeof g === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(g));
    if (gw.length > 0 && gw.length <= 4) updates.gateway = gw;
  }
  // DNS: 数组
  if (Array.isArray(req.body.DNS)) {
    const dns = req.body.DNS.filter(d => typeof d === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(d));
    if (dns.length > 0 && dns.length <= 4) updates.DNS = dns;
  }
  // userLevel: 0-255
  if (typeof req.body.userLevel === 'number' && req.body.userLevel >= 0 && req.body.userLevel <= 255) {
    updates.userLevel = req.body.userLevel;
  }
  // autoSystemRoutingTable: 数组（空数组 = 启用 auto route）
  if (Array.isArray(req.body.autoSystemRoutingTable)) {
    updates.autoSystemRoutingTable = req.body.autoSystemRoutingTable.filter(t => typeof t === 'string');
  }
  // autoOutboundsInterface: 出站网卡名（字符串，可空 = 自动检测）
  if (typeof req.body.autoOutboundsInterface === 'string') {
    if (req.body.autoOutboundsInterface === '' || /^[a-zA-Z0-9_-]{1,16}$/.test(req.body.autoOutboundsInterface)) {
      updates.autoOutboundsInterface = req.body.autoOutboundsInterface;
    }
  }
  // autoStart: 应用启动时是否自动启用
  if (typeof req.body.autoStart === 'boolean') {
    updates.autoStart = req.body.autoStart;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ ok: false, error: '没有有效字段（name/MTU/gateway/DNS/userLevel/autoSystemRoutingTable/autoOutboundsInterface/autoStart）' });
  }
  const merged = { ...current, ...updates };
  const saved = config.setTunConfig(merged);
  logToInfo(`[tun] config updated: ${JSON.stringify(updates)}`);
  res.json({ ok: true, config: saved });
}));

// 临**时**路**由**管**理**（v1.17.0 v9+ 修 M50：xray 26.6.1 TUN 不自动注入 OS 路由，**需**要**手**动**加**临**时**路**由**让**应**用**自**动**走** TUN**）
// 用**临**时**路**由**（metric 50 **优**于**原**默**认** 100**），**关**闭** TUN **时**要**记**得**清**理**，**不**然**会**断**网**
const { execSync } = require('child_process');
function addTunRoutes(tunName) {
  // 3 条覆盖所有 IPv4（default + 0.0.0.0/1 + 128.0.0.0/1）。iproute2 拒绝 0.0.0.0/0，**用** default + /1 拆**分**
  const cmds = [
    `ip route add default dev ${tunName} metric 50`,
    `ip route add 0.0.0.0/1 dev ${tunName} metric 50`,
    `ip route add 128.0.0.0/1 dev ${tunName} metric 50`
  ];
  const results = [];
  for (const cmd of cmds) {
    try {
      const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
      results.push({ cmd, ok: true, out });
    } catch (e) {
      // "File exists" = 已加过，**不**算**错**误**
      const msg = (e.stderr || e.stdout || e.message || '').toString();
      const ok = /File exists/i.test(msg);
      results.push({ cmd, ok, error: msg.trim() });
    }
  }
  return results;
}
function delTunRoutes(tunName) {
  const cmds = [
    `ip route del default dev ${tunName} metric 50`,
    `ip route del 0.0.0.0/1 dev ${tunName} metric 50`,
    `ip route del 128.0.0.0/1 dev ${tunName} metric 50`
  ];
  const results = [];
  for (const cmd of cmds) {
    try {
      execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] });
      results.push({ cmd, ok: true });
    } catch (e) {
      // "No such process" = 没**加**过，**不**算**错**误**
      const msg = (e.stderr || e.stdout || e.message || '').toString();
      const ok = /No such process|Cannot find device/i.test(msg);
      results.push({ cmd, ok, error: msg.trim() });
    }
  }
  return results;
}

// POST /api/tun/start - 启用 TUN 模式
// 流程：启动前先 cleanupTun（防残留）→ applyTunToConfig(true) → restartXray（完**全**重**启**）→ addTunRoutes（**临**时**路**由**让**应**用**自**动**走** TUN**）
// v1.17.0+ v9: 加 addTunRoutes（修 M50：xray 26.6.1 TUN 不自动注入 OS 路由）
router.post('/start', wrap(async (req, res) => {
  const xrayStatus = xray.getStatus();
  if (!xrayStatus.running) {
    return res.status(400).json({ ok: false, error: 'xray 未运行，请先启动代理' });
  }
  status.setStartingUp(true);
  try {
    // 启动前先清理 TUN 残留（防叠加 + 防御）
    const tunConfig = config.getTunConfig();
    const cleanup = config.cleanupTun(tunConfig.name);
    const result = config.applyTunToConfig(true, tunConfig);
    logToInfo(`[tun] starting TUN mode: name=${tunConfig.name}, MTU=${tunConfig.MTU}`);
    // v1.17.0+ 必须用 restartXray（SIGUSR2 热加载不会重新创建 TUN 设备，导致 tun0 不出现）
    const reloadResult = await xray.restartXray();
    // v1.17.0+ v9: 加临时路由让应用自动走 TUN（xray 26.6.1 TUN 不自动注入 OS 路由，**要**我**们**手**动**加**）
    const routeResults = addTunRoutes(tunConfig.name);
    logToInfo(`[tun] added ${routeResults.filter(r => r.ok).length}/${routeResults.length} 临时路由`);
    res.json({
      ok: true,
      enabled: true,
      cleanup: cleanup,
      apply: result,
      reload: reloadResult,
      routes: routeResults,
      message: 'TUN 模式已启用，所有应用已自动走 TUN 分流（国内直连/国外代理）。如网络异常，执行: sudo bash ' + path.join(DATA_DIR, 'backup_network.sh')
    });
  } catch (e) {
    logToInfo(`[tun] start failed: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    status.setStartingUp(false);
  }
}));

// POST /api/tun/stop - 关闭 TUN 模式
// 流程：delTunRoutes（清**临**时**路**由**）→ applyTunToConfig(false) → restartXray（完**全**重**启**） → cleanupTun 清残留
// v1.17.0+ v9: 加 delTunRoutes（**清**临**时**路**由**避**免**断**网**）
router.post('/stop', wrap(async (req, res) => {
  const xrayStatus = xray.getStatus();
  if (!xrayStatus.running) {
    return res.status(400).json({ ok: false, error: 'xray 未运行' });
  }
  status.setStartingUp(true);
  try {
    // v1.17.0+ v9: 先**清**临**时**路**由**（避**免**断**网**）
    const tunConfig = config.getTunConfig();
    const routeResults = delTunRoutes(tunConfig.name);
    logToInfo(`[tun] removed ${routeResults.filter(r => r.ok).length}/${routeResults.length} 临时路由`);
    const result = config.applyTunToConfig(false);
    logToInfo('[tun] stopping TUN mode');
    // v1.17.0+ 必须用 restartXray（同 start 端点）
    const reloadResult = await xray.restartXray();
    // 关闭后清理残留（不依赖 xray 是否完全停止）
    const cleanup = config.cleanupTun(tunConfig.name);
    res.json({
      ok: true,
      enabled: false,
      routes: routeResults,
      apply: result,
      reload: reloadResult,
      cleanup: cleanup,
      message: 'TUN 模式已关闭，临时路由已清理，网络已恢复正常'
    });
  } catch (e) {
    logToInfo(`[tun] stop failed: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    status.setStartingUp(false);
  }
}));

// GET /api/tun/status - 返 TUN 实际运行状态
router.get('/status', wrap(async (req, res) => {
  const xrayStatus = xray.getStatus();
  const tunConfig = config.getTunConfig();
  const deviceExists = checkTunDevice(tunConfig.name);
  res.json({
    ok: true,
    enabled: tunConfig.enabled,                // 配置层是否启用
    xrayRunning: xrayStatus.running,           // xray 是否在跑
    xrayPid: xrayStatus.pid,
    deviceExists: deviceExists,                // 实际 /dev/net/tun 是否被创建
    name: tunConfig.name,
    MTU: tunConfig.MTU,
    gateway: tunConfig.gateway,
    DNS: tunConfig.DNS
  });
}));


// GET /api/tun/diagnose - 只读 TUN 诊断：不启用 TUN、不改路由、不清理残留
router.get('/diagnose', wrap(async (req, res) => {
  const tunConfig = config.getTunConfig();
  const xrayStatus = xray.getStatus();
  const execFile = require('child_process').execFile;
  const run = (cmd, args, timeout) => new Promise((resolve) => {
    execFile(cmd, args || [], { timeout: timeout || 2000 }, (err, stdout, stderr) => {
      resolve({ cmd: [cmd].concat(args || []).join(' '), ok: !err, code: err && typeof err.code !== 'undefined' ? err.code : 0, stdout: String(stdout || '').slice(0, 8000), stderr: String(stderr || '').slice(0, 2000) });
    });
  });
  const esc = (v) => String(v || 'tun0').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const checks = [];
  const devTun = fs.existsSync('/dev/net/tun');
  const devExists = checkTunDevice(tunConfig.name);
  checks.push({ name: 'tun_config_enabled', ok: tunConfig.enabled === true, value: tunConfig.enabled, level: tunConfig.enabled ? 'warn' : 'ok', message: tunConfig.enabled ? 'TUN 配置处于启用状态' : 'TUN 配置未启用' });
  checks.push({ name: 'tun_auto_start', ok: tunConfig.autoStart === true, value: tunConfig.autoStart, level: tunConfig.autoStart ? 'warn' : 'ok', message: tunConfig.autoStart ? 'TUN 设置为随应用自动启动' : 'TUN 不会随应用自动启动' });
  checks.push({ name: 'dev_net_tun', ok: devTun, value: devTun, level: devTun ? 'ok' : 'bad', message: devTun ? '/dev/net/tun 存在' : '/dev/net/tun 不存在' });
  checks.push({ name: 'tun_device', ok: devExists, value: tunConfig.name || 'tun0', level: devExists ? 'warn' : 'ok', message: devExists ? '发现 TUN 设备，可能正在运行或有残留' : '未发现配置中的 TUN 设备' });
  const route = await run('/sbin/ip', ['route', 'show']);
  const link = await run('/sbin/ip', ['link', 'show']);
  const iptables = await run('/usr/sbin/iptables', ['-S']);
  const ps = await run('/bin/ps', ['-ef']);
  const hasXrayChain = /\bXRAY\b/.test(iptables.stdout || '');
  const hasTunRoute = new RegExp('\\b' + esc(tunConfig.name || 'tun0') + '\\b').test(route.stdout || '');
  checks.push({ name: 'xray_iptables_chain', ok: hasXrayChain, value: hasXrayChain, level: hasXrayChain ? 'warn' : 'ok', message: hasXrayChain ? 'iptables 中发现 XRAY 链' : 'iptables 未发现 XRAY 链' });
  checks.push({ name: 'tun_route', ok: hasTunRoute, value: hasTunRoute, level: hasTunRoute ? 'warn' : 'ok', message: hasTunRoute ? '路由表中发现 TUN 设备路由' : '路由表未发现 TUN 设备路由' });
  const bad = checks.filter(c => c.level === 'bad').length;
  const warn = checks.filter(c => c.level === 'warn').length;
  res.json({ ok: true, ts: Date.now(), config: tunConfig, xray: { running: xrayStatus.running, pid: xrayStatus.pid }, summary: { bad, warn, safe: bad === 0 && warn === 0 }, checks, commands: { route, link, iptables, process: { cmd: ps.cmd, ok: ps.ok, stdout: (ps.stdout || '').split('\n').filter(l => /xray|xray-proxy-native|node server\.js/.test(l)).join('\n'), stderr: ps.stderr } }, advice: ['默认建议保持 TUN 关闭，优先使用 SOCKS/HTTP。', '启用 TUN 前确认已保存网络备份。', '发现 XRAY 链或 TUN 路由残留时，再手动点击清理残留。'] });
}));

// GET /api/tun/diagnostic-package - 一键导出诊断包（只读采集）
router.get('/diagnostic-package', wrap(async (req, res) => {
  const execFile = require('child_process').execFile;
  const run = (cmd, args, timeout) => new Promise((resolve) => {
    execFile(cmd, args || [], { timeout: timeout || 2500 }, (err, stdout, stderr) => {
      resolve({ cmd: [cmd].concat(args || []).join(' '), ok: !err, code: err && typeof err.code !== 'undefined' ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
  const pkg = {
    app: 'xray-proxy-native',
    version: process.env.TRIM_APPVER || '1.23.3',
    exportedAt: new Date().toISOString(),
    note: '只读诊断包：不包含 auth token、不包含节点密钥明文、不执行清理/启用操作',
    status: xray.getStatus(),
    tunConfig: config.getTunConfig(),
    tunDeviceExists: checkTunDevice(config.getTunConfig().name),
    commands: {
      ipAddr: await run('/sbin/ip', ['addr', 'show']),
      ipRoute: await run('/sbin/ip', ['route', 'show']),
      ipRule: await run('/sbin/ip', ['rule', 'show']),
      iptables: await run('/usr/sbin/iptables', ['-S']),
      ps: await run('/bin/ps', ['-ef'])
    }
  };
  const raw = JSON.stringify(pkg, null, 2)
    .replace(/("token"\s*:\s*")[^"]+/ig, '$1***')
    .replace(/("password"\s*:\s*")[^"]+/ig, '$1***')
    .replace(/("password_hash"\s*:\s*")[^"]+/ig, '$1***')
    .replace(/("id"\s*:\s*")[0-9a-f-]{20,}/ig, '$1***');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="xray-proxy-native-diagnostic-1.20.0.json"');
  res.send(raw);
}));

// GET /api/tun/backup - 返 backup_network.sh 路径 + 手动恢复指南
router.get('/backup', wrap(async (req, res) => {
  // 触发一次备份（确保最新）
  const backup = config.backupNetworkConfig();
  res.json({
    ok: backup.ok,
    backup: backup,
    instructions: [
      '【TUN 模式手动恢复指南】',
      '1. 停用应用：fnOS 应用中心 → xray-proxy-native → 停用',
      '2. 完全卸载：fnOS 应用中心 → xray-proxy-native → 卸载',
      '3. 如仍断网，SSH 登录后执行：',
      '   sudo bash ' + path.join(DATA_DIR, 'backup_network.sh'),
      '4. 验证：ping -c 3 8.8.8.8',
      '',
      '【为什么要做这个】',
      'TUN 模式会接管全部网络流量 + 改路由表 + 加 iptables 规则',
      '异常情况下（如 xray 崩溃、卸载不干净），可能断网',
      '该脚本会：删 tun 设备 + 清路由表 + 清 iptables + 杀残留 xray',
      '',
      '【Socks 模式不会动路由表】',
      '如不需要"全局代理"，推荐用 socks 模式（不修改系统路由）'
    ]
  });
}));

// POST /api/tun/cleanup - 强制清理 TUN 残留（不依赖 xray 状态）
// 用于：xray 崩溃、UI 卡住、用户主动恢复
router.post('/cleanup', wrap(async (req, res) => {
  logToInfo('[tun] manual cleanup triggered');
  const tunConfig = config.getTunConfig();
  const cleanup = config.cleanupTun(tunConfig.name);
  res.json({
    ok: cleanup.ok,
    cleanup: cleanup,
    message: cleanup.ok ? 'TUN 残留已清理' : '部分清理失败，请查看 cleanup.results'
  });
}));

module.exports = router;
