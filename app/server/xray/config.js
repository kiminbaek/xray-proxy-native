// xray 配置模块（v1.6.0+）
// 默认配置生成、读写、校验、空白检测

const fs = require('fs');
const path = require('path');  // v1.17.0+ TUN 模式需要
const {
  ensureDir,
  readFileSafe,
  atomicWriteFile,
  DATA_DIR,
  CONFIG_DIR,
  CONFIG_FILE,
  BACKUP_FILE
} = require('./utils');

// 用户后续可自行添加/删除/启用
function defaultSeedNodes() {
  // 这里不放任何默认节点，避免推送任何作者专属节点
  // 用户首次启动时从 xray_client 目录导入（如有）
  return [];
}

function defaultConfig() {
  // 基础模板：写死"国内直连 + 国外代理"规则
  const base = {
    log: { loglevel: 'warning' },
    // v1.5.0+ 启用统计模块（流量统计 P1-3 用）
    stats: {},
    // v1.7.2+ 修复：必须显式声明 api 块，否则 xray 不会注册 StatsService
    // v1.7.1 这里漏了，migrateConfig 的 cfg.api = base.api 拿到 undefined
    // → JSON.stringify 不写 api 键 → 老用户配置永远补不上 → 10085 stats API 起不来
    api: { tag: 'api', services: ['StatsService'] },
    policy: {
      system: {
        statsInboundUplink: true,
        statsInboundDownlink: true,
        statsOutboundUplink: true,
        statsOutboundDownlink: true
      }
    },
    inbounds: [
      { tag: 'socks-in', port: 10808, protocol: 'socks', listen: '127.0.0.1', settings: { udp: true, auth: 'noauth' }, sniffing: { enabled: true, destOverride: ['http', 'tls'] } },
      { tag: 'http-in',  port: 10809, protocol: 'http',  listen: '127.0.0.1', settings: {}, sniffing: { enabled: true, destOverride: ['http', 'tls'] } },
      // v1.5.0+ Stats API inbound：只绑 127.0.0.1，外部不可访问
      { tag: 'api', port: 10085, protocol: 'dokodemo-door', listen: '127.0.0.1', settings: { address: '127.0.0.1' } }
    ],
    outbounds: [
      { tag: 'proxy',  protocol: 'freedom', settings: { domainStrategy: 'UseIPv4' } },  // 占位：真实代理节点由用户/seed 注入
      { tag: 'direct', protocol: 'freedom', settings: { domainStrategy: 'UseIPv4' } },
      { tag: 'block',  protocol: 'blackhole' },
      // v1.5.0+ API 出站（dokodemo-door 反射回 127.0.0.1 实际接住）
      { tag: 'api', protocol: 'blackhole' }
    ],
    // DNS：国内走阿里 + dnspod，国外走 Cloudflare/Quad9
    dns: {
      servers: [
        'https+local://dns.alidns.com/dns-query',         // 阿里 DoH（国内）
        'https+local://dns.pub/dns-query',                 // 腾讯 DoH（备用国内）
        { address: 'localhost', skipFallback: true }       // 内置 dns 解析
      ],
      queryStrategy: 'UseIP'
    },
    // 路由规则：国内域名 → direct；国内 IP → direct；私有 IP → direct；其余 → proxy
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: [
        // v1.5.0+ Stats API 流量走专用 api 出站（必须最前，否则会被其他规则覆盖）
        { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
        { type: 'field', outboundTag: 'direct', domain: ['geosite:cn'] },
        { type: 'field', outboundTag: 'direct', ip: ['geoip:cn', 'geoip:private'] },
        { type: 'field', outboundTag: 'block',  port: '25' },       // 屏蔽 SMTP 出站
        { type: 'field', outboundTag: 'proxy',  network: 'tcp,udp' }
      ]
    }
  };

  // 注入种子节点（v1.12.0+ 简化：只从 defaultSeedNodes 静态列表）
  // 之前从 importFromXrayClient() 拿节点，但该函数实际返回的是 xray 二进制路径字符串，
  // 不是节点数组（Array.isArray 永远 false），逻辑死代码
  // 真正的种子节点来源：用户在 UI 添加，或导入订阅
  // v1.12.1+ 只在第一次加载时打日志，避免 getConfig/migrateConfig 重复调用刷屏
  const seedNodes = defaultSeedNodes();
  const proxyNodes = seedNodes.filter(n => n.tag !== 'direct' && n.tag !== 'block');
  if (proxyNodes.length > 0) {
    base.outbounds[0] = proxyNodes[0];
    for (let i = 1; i < proxyNodes.length; i++) {
      base.outbounds.push(proxyNodes[i]);
    }
    if (!defaultConfig._logged) { console.log(`[xray] Default config: ${proxyNodes.length} proxy node(s) loaded`); defaultConfig._logged = true; }
  } else {
    if (!defaultConfig._logged) { console.log('[xray] Default config: no proxy nodes — user must add via UI'); defaultConfig._logged = true; }
  }

  return base;
}

// 校验：proxy 出口必须是真实代理协议（vless/vmess/trojan/shadowsocks）
// 不允许是 freedom（否则路由规则等于失效，国内外都走 direct）
function validateConfig(config) {
  const errors = [];
  const outbounds = config.outbounds || [];

  // 找 tag=proxy 的出口
  const proxyOut = outbounds.find(o => o.tag === 'proxy');
  if (!proxyOut) {
    errors.push('outbound tag="proxy" 不存在');
  } else if (!['vless', 'vmess', 'trojan', 'shadowsocks', 'socks', 'http'].includes(proxyOut.protocol)) {
    errors.push(`outbound tag="proxy" 是 ${proxyOut.protocol}，不是真实代理节点（需 vless/vmess/trojan/shadowsocks/socks/http）`);
  }

  // 找 tag=direct 的出口
  const directOut = outbounds.find(o => o.tag === 'direct');
  if (!directOut) {
    errors.push('outbound tag="direct" 不存在');
  }

  return errors;
}

// v1.3.0+ 判断配置是否"空白"（无真实代理节点）
// 用于 UI 引导用户添加第一个节点 + 阻止空配置启动 xray
// v1.12.3+ 规则修正：检查是否存在任何 vless/vmess/trojan/shadowsocks 节点
// 旧规则（proxy tag=freedom → 空白）有 bug：当用户用"导入链接"或
// "添加节点" 自定义 tag（如 cc-real）时，proxy 占位仍在 → 误判空白
const REAL_PROXY_PROTOCOLS = new Set(['vless', 'vmess', 'trojan', 'shadowsocks']);
function isEmptyConfig(config) {
  if (!config || !Array.isArray(config.outbounds)) return true;
  // 只要有任一真实代理协议节点，就不是空白
  return !config.outbounds.some(o => REAL_PROXY_PROTOCOLS.has(o.protocol));
}

function getConfig() {
  ensureDir(CONFIG_DIR);
  const raw = readFileSafe(CONFIG_FILE);
  if (raw) {
    try {
      const cfg = JSON.parse(raw);
      // v1.7.1+ 配置自动迁移：老配置（v1.5.0 之前生成）没有 api 块
      // 自动补全 stats API 所需的 api/policy/stats/routing 规则
      // v1.14.0+ 修：getConfig 不再自动写盘（修复并发 getConfig → 多 setConfig 竞争写盘）
      // 迁移改在 setConfig 入口主动执行（v1.14.0+）
      const migrated = migrateConfig(cfg);
      return migrated.config;
    } catch (_) {
      // 配置文件损坏，尝试用备份
      const bak = readFileSafe(BACKUP_FILE);
      if (bak) {
        try { return JSON.parse(bak); } catch (_) {}
      }
    }
  }
  return defaultConfig();
}

// v1.7.1+ 自动迁移：老配置（v1.5.0 之前）没有 stats API 配置
// 补全 stats / policy / api inbound / api outbound / routing 规则
function migrateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return { config: cfg, changed: false };
  let changed = false;
  const base = defaultConfig();

  // 1. stats 块
  if (!cfg.stats) { cfg.stats = base.stats; changed = true; }

  // 2. policy.system 开统计
  // v1.12.0+ 修：只补 undefined 字段，不覆盖用户显式的 false（用户禁用就尊重）
  if (!cfg.policy) { cfg.policy = base.policy; changed = true; }
  else if (!cfg.policy.system) {
    cfg.policy.system = base.policy.system; changed = true;
  } else {
    const ps = cfg.policy.system;
    if (ps.statsInboundUplink    === undefined) { ps.statsInboundUplink    = true; changed = true; }
    if (ps.statsInboundDownlink  === undefined) { ps.statsInboundDownlink  = true; changed = true; }
    if (ps.statsOutboundUplink   === undefined) { ps.statsOutboundUplink   = true; changed = true; }
    if (ps.statsOutboundDownlink === undefined) { ps.statsOutboundDownlink = true; changed = true; }
  }

  // 3. api 块
  if (!cfg.api) { cfg.api = base.api; changed = true; }

  // 4. api 入站（dokodemo-door 10085）
  if (!Array.isArray(cfg.inbounds)) cfg.inbounds = [];
  if (!cfg.inbounds.some(i => i.tag === 'api')) {
    cfg.inbounds.push(base.inbounds.find(i => i.tag === 'api'));
    changed = true;
  }

  // 5. api 出站（blackhole）
  if (!Array.isArray(cfg.outbounds)) cfg.outbounds = [];
  if (!cfg.outbounds.some(o => o.tag === 'api')) {
    cfg.outbounds.push({ tag: 'api', protocol: 'blackhole' });
    changed = true;
  }

  // 6. routing 规则：api 入口必须最前
  if (!cfg.routing) { cfg.routing = base.routing; changed = true; }
  else {
    if (!Array.isArray(cfg.routing.rules)) cfg.routing.rules = [];
    const hasApiRule = cfg.routing.rules.some(r => Array.isArray(r.inboundTag) && r.inboundTag.includes('api') && r.outboundTag === 'api');
    if (!hasApiRule) {
      cfg.routing.rules.unshift({ type: 'field', inboundTag: ['api'], outboundTag: 'api' });
      changed = true;
    }
  }

  return { config: cfg, changed };
}

function setConfig(config) {
  ensureDir(CONFIG_DIR);
  // v1.14.0+ 主动迁移：setConfig 入口跑 migrateConfig（替代原来 getConfig 内 setConfig 副作用）
  // 解决：并发 getConfig 触发多个 setConfig 竞争写盘
  const migrated = migrateConfig(config);
  config = migrated.config;
  // 备份当前配置（如果存在）
  if (fs.existsSync(CONFIG_FILE)) {
    try { fs.copyFileSync(CONFIG_FILE, BACKUP_FILE); } catch (_) {}
  }
  atomicWriteFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// 安全过滤：routing 和 dns 写死，不接受外部覆盖
// 防止用户改坏路由导致国内流量走代理
function sanitizeConfig(input) {
  const base = defaultConfig();
  const safe = {
    log: input.log || base.log,
    inbounds: Array.isArray(input.inbounds) && input.inbounds.length > 0 ? input.inbounds : base.inbounds,
    outbounds: Array.isArray(input.outbounds) && input.outbounds.length > 0 ? input.outbounds : base.outbounds,
    // 强制写死 routing 和 dns
    routing: base.routing,
    dns: base.dns
  };
  return safe;
}

// ====== v1.17.0+ TUN 模式配置管理 ======
// TUN 模式：通过 xray 的 tun protocol inbound 创建 TUN 设备（/dev/net/tun）
// 让本机所有进程的流量都走 xray（透明代理）
// 二进制 cap 由 cmd/install_callback 注入（cap_net_admin + cap_net_raw）
// 配置文件持久化在 ${DATA_DIR}/tun.json（独立于 config.json，避免污染路由规则）
const TUN_CONFIG_FILE = path.join(DATA_DIR, 'tun.json');

function defaultTunConfig() {
  // xray-core 26.6.1 TUN 配置格式（来自 proxy/tun/config.go）
  // Go json tag 决定 JSON 字段名（小写 mtu/dns，驼峰 userLevel/autoSystemRoutingTable/autoOutboundsInterface）
  return {
    enabled: false,                          // 是否启用（持久化状态，UI 控制）
    name: 'tun0',                            // TUN 设备名（/sys/devices/virtual/net/tun0）
    MTU: 1500,                               // TUN 设备 MTU（注意：JSON 写入用小写 mtu）
    gateway: ['172.19.0.1'],                 // TUN 网关 IP（数组形式，避免与局域网冲突）
    DNS: ['8.8.8.8', '1.1.1.1'],             // TUN DNS（JSON 写入用小写 dns）
    userLevel: 0,                            // 用户级别（0 = 全部用户）
    autoSystemRoutingTable: ['0.0.0.0/0'],   // 自动配路由表（v1.17.0+ 默**认** 0.0.0.0/0 = 注入默认路由让所有应用走 TUN，空数组 = 不注入 = 应用不自动走 TUN）
    autoOutboundsInterface: '',              // 出站网卡名（空字符串 = 启动时自动检测）
    autoStart: false                         // 应用启动时是否自动启用 TUN
  };
}

function getTunConfig() {
  ensureDir(DATA_DIR);
  const raw = readFileSafe(TUN_CONFIG_FILE);
  if (raw) {
    try {
      const cfg = JSON.parse(raw);
      // 合并默认值（新增字段向后兼容）
      const merged = { ...defaultTunConfig(), ...cfg };
      // v1.17.0 v8 迁移：旧版本 tun.json 中 autoSystemRoutingTable=[]，导致 xray 创**建** tun0 但不**注**入**路**由**。
      // 升级到 v8 后自动迁移到 ['0.0.0.0/0']（**让**所有**应**用**自**动**走** TUN **分**流**）。如**果**用**户**明**确**想**要**空**数**组**，可**以**在** UI **改**回** []。
      if (Array.isArray(merged.autoSystemRoutingTable) && merged.autoSystemRoutingTable.length === 0) {
        merged.autoSystemRoutingTable = ['0.0.0.0/0'];
        atomicWriteFile(TUN_CONFIG_FILE, JSON.stringify(merged, null, 2));   // 持久化迁移结果
      }
      return merged;
    } catch (_) {}
  }
  return defaultTunConfig();
}

function setTunConfig(tunConfig) {
  ensureDir(DATA_DIR);
  const safe = { ...defaultTunConfig(), ...tunConfig };
  atomicWriteFile(TUN_CONFIG_FILE, JSON.stringify(safe, null, 2));
  return safe;
}

// 构造 TUN inbound 对象（注入到 xray config.inbounds）
// xray-core 26.6.1 TUN inbound 配置（来自 proxy/tun/config.go）
// 必填：name（设备名）、gateway（IP 数组）、MTU
// 可选：DNS、userLevel、autoSystemRoutingTable、autoOutboundsInterface
// ⚠️ Go json tag 与 proto 字段名不一致：proto 大写 MTU/DNS，go tag 小写 mtu/dns
// 写入 JSON 用 Go tag（mtu/dns），读 config.proto 用 MTU/DNS
function buildTunInbound(tunConfig) {
  const cfg = { ...defaultTunConfig(), ...tunConfig };
  // 自动检测出站网卡（如未填）
  let outIface = cfg.autoOutboundsInterface;
  if (!outIface) {
    try {
      const { execSync } = require('child_process');
      const out = execSync("ip route | grep '^default' | awk '{print $5}' | head -1", { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      outIface = out || 'eth0';
    } catch (_) {
      outIface = 'eth0';
    }
  }
  return {
    tag: 'tun-in',
    port: 0,                                 // TUN 模式不需要 port
    protocol: 'tun',
    settings: {
      name: cfg.name,                        // 设备名 tun0
      mtu: cfg.MTU,                          // Go json tag 小写
      gateway: cfg.gateway,                  // 数组
      dns: cfg.DNS,                          // Go json tag 小写
      userLevel: cfg.userLevel,
      autoSystemRoutingTable: cfg.autoSystemRoutingTable,   // 数组（空数组 = 启用 auto route）
      autoOutboundsInterface: outIface                       // 出站网卡
    },
    sniffing: { enabled: true, destOverride: ['http', 'tls'] }
  };
}

// 动态修改 xray config.json，添加/删除 TUN inbound
// enabled=true: 在 inbounds 末尾追加 TUN inbound
// enabled=false: 从 inbounds 中删除 tag='tun-in'
// 返回：{ ok, enabled, inbounds, message }
function applyTunToConfig(enabled, tunConfig) {
  const cfg = getConfig();
  const inbounds = Array.isArray(cfg.inbounds) ? cfg.inbounds : [];
  // 先清除已有的 TUN inbound（保证 idempotent）
  const filtered = inbounds.filter(i => i.tag !== 'tun-in');
  if (enabled) {
    const tun = buildTunInbound(tunConfig || getTunConfig());
    filtered.push(tun);
    cfg.inbounds = filtered;
    setConfig(cfg);
    // 同步更新 tun.json 持久化状态
    setTunConfig({ ...(tunConfig || getTunConfig()), enabled: true });
    return { ok: true, enabled: true, inbounds: filtered.length, message: 'TUN inbound added, please reload xray' };
  } else {
    cfg.inbounds = filtered;
    setConfig(cfg);
    setTunConfig({ ...(tunConfig || getTunConfig()), enabled: false });
    return { ok: true, enabled: false, inbounds: filtered.length, message: 'TUN inbound removed, please reload xray' };
  }
}

// ====== v1.17.0+ TUN 安全清理函数（层级 2+4+6）======
// 应用启动失败 / 关闭 TUN / xray 崩溃 / 卸载 时调用
// 清理：tun 设备 + 路由表 + iptables mangle/nat chain + 残留 xray 进程
// 注意：不修改 default route（即便 xray 改过也只删 xray 加的 fwmark rule + 独立 table）
function cleanupTun() {
  const { execSync } = require('child_process');
  const { logToInfo } = require('./utils');
  const cmds = [
    // 1. 删 TUN 设备
    'ip link delete tun0 2>/dev/null || true',
    'ip link delete tun1 2>/dev/null || true',
    // 2. 清路由表（不删 default route，只删 xray 加的 fwmark rule + 独立 table）
    'ip rule del fwmark 0x1/0x1 table 100 2>/dev/null || true',
    'ip rule del fwmark 0x1/0x1 table 101 2>/dev/null || true',
    'ip route flush table 100 2>/dev/null || true',
    'ip route flush table 101 2>/dev/null || true',
    'ip -6 rule del fwmark 0x1/0x1 table 100 2>/dev/null || true',
    'ip -6 rule del fwmark 0x1/0x1 table 101 2>/dev/null || true',
    'ip -6 route flush table 100 2>/dev/null || true',
    'ip -6 route flush table 101 2>/dev/null || true',
    // 3. 清 iptables mangle chain（不碰系统链，只清 XRAY 命名的）
    'iptables -t mangle -F XRAY 2>/dev/null || true',
    'iptables -t mangle -X XRAY 2>/dev/null || true',
    'ip6tables -t mangle -F XRAY 2>/dev/null || true',
    'ip6tables -t mangle -X XRAY 2>/dev/null || true',
    // 4. 清 iptables nat chain（OUTPUT 转发给 socks/http 的）
    'iptables -t nat -F XRAY 2>/dev/null || true',
    'iptables -t nat -X XRAY 2>/dev/null || true',
    'ip6tables -t nat -F XRAY 2>/dev/null || true',
    'ip6tables -t nat -X XRAY 2>/dev/null || true'
  ];
  const results = [];
  let allOk = true;
  for (const cmd of cmds) {
    try {
      execSync(cmd, { stdio: 'ignore' });
      results.push({ cmd, ok: true });
    } catch (e) {
      results.push({ cmd, ok: false, error: e.message });
      allOk = false;
    }
  }
  logToInfo('cleanupTun executed:', results.filter(r => !r.ok).length, 'failed of', cmds.length);
  return { ok: allOk, results, count: cmds.length };
}

// ====== v1.17.0+ 网络备份（层级 1+6）======
// 安装时调用，保存原始 default route + DNS 到 DATA_DIR/network_backup.conf
// 同时生成可执行的恢复脚本 DATA_DIR/backup_network.sh（用户手动恢复用）
function backupNetworkConfig() {
  const { execSync } = require('child_process');
  const fs = require('fs');
  const { logToInfo } = require('./utils');
  try {
    ensureDir(DATA_DIR);
    // 读 default route（"default via 192.168.2.2 dev enp3s0 ..."）
    let defaultRoute = '';
    try {
      defaultRoute = execSync("ip route | grep '^default' | head -1", { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch (_) {}
    // 解析：parts = ['default', 'via', '192.168.2.2', 'dev', 'enp3s0', ...]
    const parts = defaultRoute.split(/\s+/);
    const gw = parts[2] || 'unknown';
    const iface = parts[4] || 'unknown';
    // 读 DNS
    let dns = '8.8.8.8 1.1.1.1';
    try {
      dns = execSync("grep '^nameserver' /etc/resolv.conf 2>/dev/null | awk '{print $2}'", { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().replace(/\n/g, ' ');
      if (!dns) dns = '8.8.8.8 1.1.1.1';
    } catch (_) {}
    // 写 .conf 文件
    const confPath = path.join(DATA_DIR, 'network_backup.conf');
    const confContent = [
      '# v1.17.0+ TUN 模式网络备份（自动生成）',
      `# 备份时间：${new Date().toISOString()}`,
      `DEFAULT_GW="${gw}"`,
      `DEFAULT_IFACE="${iface}"`,
      `ORIGINAL_DNS="${dns}"`,
      ''
    ].join('\n');
    atomicWriteFile(confPath, confContent);
    // 写 .sh 恢复脚本
    const shPath = path.join(DATA_DIR, 'backup_network.sh');
    const shContent = `#!/bin/bash
# v1.17.0+ TUN 模式手动恢复脚本（自动生成）
# 用法：sudo bash ${shPath}
# 场景：TUN 模式出问题 / 卸载不干净 / 断网
set +e  # 不因个别错误退出
echo "[1/5] 删 TUN 设备..."
ip link delete tun0 2>/dev/null
ip link delete tun1 2>/dev/null
echo "[2/5] 清路由表（xray 加的 fwmark rule + 独立 table）..."
ip rule del fwmark 0x1/0x1 table 100 2>/dev/null
ip rule del fwmark 0x1/0x1 table 101 2>/dev/null
ip -6 rule del fwmark 0x1/0x1 table 100 2>/dev/null
ip -6 rule del fwmark 0x1/0x1 table 101 2>/dev/null
ip route flush table 100 2>/dev/null
ip route flush table 101 2>/dev/null
ip -6 route flush table 100 2>/dev/null
ip -6 route flush table 101 2>/dev/null
echo "[3/5] 清 iptables..."
iptables -t mangle -F XRAY 2>/dev/null
iptables -t mangle -X XRAY 2>/dev/null
iptables -t nat -F XRAY 2>/dev/null
iptables -t nat -X XRAY 2>/dev/null
ip6tables -t mangle -F XRAY 2>/dev/null
ip6tables -t mangle -X XRAY 2>/dev/null
ip6tables -t nat -F XRAY 2>/dev/null
ip6tables -t nat -X XRAY 2>/dev/null
echo "[4/5] 杀残留 xray 进程..."
pkill -9 -f "xray run" 2>/dev/null
echo "[5/5] 验证网络..."
echo "请执行: ping -c 3 8.8.8.8 验证网络"
echo "✅ 清理完成"
`;
    atomicWriteFile(shPath, shContent);
    try { fs.chmodSync(shPath, 0o755); } catch (_) {}
    logToInfo('Network backup generated:', { conf: confPath, sh: shPath, gw, iface });
    return { ok: true, conf: confPath, sh: shPath, gw, iface, dns };
  } catch (e) {
    log.error('backupNetworkConfig failed:', e);
    return { ok: false, error: e.message };
  }
}

module.exports = {
  defaultConfig,
  defaultSeedNodes,
  validateConfig,
  isEmptyConfig,
  getConfig,
  setConfig,
  sanitizeConfig,
  // v1.17.0+ TUN
  TUN_CONFIG_FILE,
  defaultTunConfig,
  getTunConfig,
  setTunConfig,
  buildTunInbound,
  applyTunToConfig,
  // v1.17.0+ TUN 安全网（层级 1+2+4+6）
  cleanupTun,
  backupNetworkConfig
};
