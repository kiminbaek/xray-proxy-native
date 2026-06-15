// xray 节点管理模块（v1.6.0+）
// 节点增删改查、延迟测试
// 不负责触发进程重启/热加载（由主入口 xray.js 统一调度）

const net = require('net');
const { getConfig, setConfig, isEmptyConfig } = require('./config');
const { logToInfo } = require('./utils');

// ====== v1.7.4+ 系统节点保护 ======
// 这些节点是 xray 配置必须的（routing 规则会引用），不能删除
// - proxy:  用户代理节点（删除会导致所有出站流量断网）
// - direct: 国内直连（routing rules outboundTag=direct）
// - block:  广告/危险拦截（routing rules outboundTag=block）
// - api:    xray 内部 gRPC stats API 出口
// UI 会用 isSystemNode(tag) 显示 🔒 标识
const SYSTEM_NODES = ['proxy', 'direct', 'block', 'api'];
function isSystemNode(tag) { return SYSTEM_NODES.includes(tag); }

// ====== 节点延迟测试（v1.3.0+ P0-3）======
// 从节点配置提取 address:port，TCP 握手测 RTT（3 次平均）
// 不需要 xray 跑起来就能测
function testNode(node) {
  return new Promise((resolve) => {
    if (!node) return resolve({ ok: false, error: '节点不存在' });

    // 提取 address + port（支持多种协议）
    let address, port;
    try {
      if (node.settings && node.settings.vnext && node.settings.vnext[0]) {
        // vless / vmess
        address = node.settings.vnext[0].address;
        port = parseInt(node.settings.vnext[0].port);
      } else if (node.settings && node.settings.servers && node.settings.servers[0]) {
        // trojan / shadowsocks
        address = node.settings.servers[0].address;
        port = parseInt(node.settings.servers[0].port);
      } else if (node.settings && (node.settings.address || node.settings.port)) {
        // socks / http
        address = node.settings.address;
        port = parseInt(node.settings.port);
      } else {
        return resolve({ ok: false, error: '无法提取 address/port' });
      }
    } catch (e) {
      return resolve({ ok: false, error: '解析失败: ' + e.message });
    }

    if (!address || !port) return resolve({ ok: false, error: 'address/port 缺失' });

    // TCP 握手 3 次取平均（v1.7.1+ 返回 tcp_ms/tcp_min/tcp_max）
    const trials = 3;
    const times = [];          // v1.7.1+ 每次成功的 ms
    let lastErr = null;
    const start = Date.now();
    const TIMEOUT = 5000;

    const tryOnce = () => {
      const s = net.createConnection({ host: address, port, family: 4 });
      const t0 = Date.now();
      let finished = false;
      s.setTimeout(TIMEOUT);
      s.once('connect', () => {
        if (finished) return;
        finished = true;
        times.push(Date.now() - t0);
        s.destroy();
      });
      s.once('error', (e) => {
        if (finished) return;
        finished = true;
        lastErr = e.message;
        try { s.destroy(); } catch (_) {}
      });
      s.once('timeout', () => {
        if (finished) return;
        finished = true;
        lastErr = 'timeout';
        try { s.destroy(); } catch (_) {}
      });
    };

    for (let i = 0; i < trials; i++) tryOnce();

    // 等待所有连接结束（用 timer 而不是事件，简单）
    const waitMs = TIMEOUT + 200;
    setTimeout(() => {
      const elapsed = Date.now() - start;
      if (times.length === 0) {
        return resolve({ ok: false, error: lastErr || '连接失败', ms: elapsed });
      }
      const sum = times.reduce((a, b) => a + b, 0);
      const avg = Math.round(sum / times.length);
      const mn = Math.min(...times);
      const mx = Math.max(...times);
      // v1.7.1+ 字段名与 UI 期望一致（tcp_ms/min/max）
      resolve({ ok: true, tcp_ms: avg, tcp_min: mn, tcp_max: mx, ms: avg, success: times.length, total: trials });
    }, waitMs);
  });
}

// ====== 节点 CRUD ======

// v1.12.3+ 真实代理协议集合（用于 isEmptyConfig 和 addNode 智能重命名）
const REAL_PROXY_PROTOCOLS = new Set(['vless', 'vmess', 'trojan', 'shadowsocks']);

function addNode(node) {
  const cfg = getConfig();
  if (!Array.isArray(cfg.outbounds)) cfg.outbounds = [];

  // v1.12.3+ 智能 tag：用户添加第一个真实代理节点时，
  //   如果当前 proxy 是 freedom 占位，自动替换占位（让 tag=proxy 指向真实节点）
  //   避免 isEmptyConfig（旧规则）和 routing 规则出现 tag 错乱
  let tag = node.tag || 'node-' + Date.now();
  if (REAL_PROXY_PROTOCOLS.has(node.protocol)) {
    const existingReal = cfg.outbounds.find(o => REAL_PROXY_PROTOCOLS.has(o.protocol));
    if (!existingReal) {
      // 没有真实代理节点 → 删 freedom 占位，让新节点占据 'proxy' tag
      cfg.outbounds = cfg.outbounds.filter(o => !(o.tag === 'proxy' && o.protocol === 'freedom'));
      tag = 'proxy';
    }
  }

  // 唯一 tag 兜底（用户自定义 tag 重复时加 -1）
  while (cfg.outbounds.some(o => o.tag === tag)) {
    tag = tag + '-1';
  }
  const newNode = { ...node, tag };
  cfg.outbounds.push(newNode);
  setConfig(cfg);
  logToInfo(`[nodes] 节点已添加: ${tag}`);
  return tag;
}

function deleteNode(tag) {
  // v1.7.4+ 系统节点保护：proxy/direct/block/api 不能删除
  if (isSystemNode(tag)) {
    logToInfo(`[nodes] 拒绝删除系统节点: ${tag}`);
    return { ok: false, error: `系统节点 "${tag}" 不能删除（用于路由规则、xray 内部 API 等）` };
  }
  const cfg = getConfig();
  if (!Array.isArray(cfg.outbounds)) return false;
  const idx = cfg.outbounds.findIndex(o => o.tag === tag);
  if (idx < 0) return false;
  cfg.outbounds.splice(idx, 1);
  setConfig(cfg);
  logToInfo(`[nodes] 节点已删除: ${tag}`);
  return true;
}

function updateNode(tag, patch) {
  // v1.7.4+ 系统节点保护：禁止改 tag（其它字段允许改）
  if (patch && patch.tag && patch.tag !== tag && isSystemNode(tag)) {
    return null;
  }
  const cfg = getConfig();
  if (!Array.isArray(cfg.outbounds)) return null;
  const idx = cfg.outbounds.findIndex(o => o.tag === tag);
  if (idx < 0) return null;
  cfg.outbounds[idx] = { ...cfg.outbounds[idx], ...patch, tag }; // tag 不允许改
  setConfig(cfg);
  logToInfo(`[nodes] 节点已更新: ${tag}`);
  return cfg.outbounds[idx];
}

function toggleNode(tag, enabled) {
  const cfg = getConfig();
  if (!Array.isArray(cfg.outbounds)) return null;
  const node = cfg.outbounds.find(o => o.tag === tag);
  if (!node) return null;
  // 关闭：标记为"disabled"（用 streamSettings.proxyProtocol hack？暂时用 settings._disabled 标记）
  if (enabled === false) {
    node._disabled = true;
  } else {
    delete node._disabled;
  }
  setConfig(cfg);
  logToInfo(`[nodes] 节点 ${tag} ${enabled ? '已启用' : '已禁用'}`);
  return node;
}

function reorderNodes(tags) {
  const cfg = getConfig();
  if (!Array.isArray(cfg.outbounds)) return;
  const map = new Map(cfg.outbounds.map(o => [o.tag, o]));
  const newList = [];
  for (const t of tags) {
    if (map.has(t)) {
      newList.push(map.get(t));
      map.delete(t);
    }
  }
  // 追加剩余的（防止用户漏传）
  for (const o of map.values()) newList.push(o);
  cfg.outbounds = newList;
  setConfig(cfg);
  logToInfo('[nodes] 节点已重排序');
}

module.exports = {
  testNode,
  addNode,
  deleteNode,
  updateNode,
  toggleNode,
  reorderNodes,
  // v1.7.4+ 系统节点保护
  isSystemNode,
  SYSTEM_NODES
};
