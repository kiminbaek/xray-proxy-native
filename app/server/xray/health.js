// 节点健康检查（v1.10.0+）
// 功能：
//   1. 定时 ping 所有用户节点（TCP 握手，3 次平均）
//   2. 失败计数：连续失败 ≥ FAIL_THRESHOLD 次 → 标记 _health_disabled = true
//   3. 持久化：node_health.json
//   4. API：GET /api/health, POST /api/health/check, POST /api/health/reset
//   5. 自动恢复：成功一次清零失败计数

const fs = require('fs');
const path = require('path');
const net = require('net');
const { getConfig, setConfig } = require('./config');
const { logToInfo, pLimit } = require('./utils');
const { isSystemNode } = require('./nodes');
// v1.13.0+ 延迟历史集成
const { recordHistory } = require('./history');
// v1.13.0+ 自动选最优
const autoSelect = require('./auto_select');
// v1.16.0+ 通知
const notify = require('../notify');

const DATA_DIR = process.env.TRIM_PKGVAR || '/tmp/xray-proxy-native';
const HEALTH_FILE = path.join(DATA_DIR, 'node_health.json');

const CHECK_INTERVAL = 5 * 60 * 1000;     // 5 分钟
const FAIL_THRESHOLD = 3;                  // 连续失败 3 次自动禁用
const PING_TIMEOUT = 5000;                 // 单次 TCP 握手超时
const PING_TRIES = 3;                      // 每次 ping 3 次取平均

// 内存中的健康状态：{ tag: { failCount, lastCheck, lastLatency, disabled } }
let _health = {};
let _timer = null;

function loadHealth() {
  try {
    _health = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf-8'));
  } catch (_) {
    _health = {};
  }
}
function saveHealth() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(_health, null, 2));
  } catch (e) {
    logToInfo('[health] 写入失败: ' + e.message);
  }
}

// 单个节点 ping（TCP 握手）
function pingNode(node) {
  return new Promise((resolve) => {
    const settings = node.settings || {};
    const vnext = settings.vnext || [];
    const servers = settings.servers || [];
    let addr, port;
    if (vnext[0]) { addr = vnext[0].address; port = vnext[0].port; }
    else if (servers[0]) { addr = servers[0].address; port = servers[0].port; }
    else if (node.address) { addr = node.address; port = node.port; }
    if (!addr || !port) return resolve({ ok: false, error: '无地址' });

    const tries = [];
    let done = 0;
    for (let i = 0; i < PING_TRIES; i++) {
      const start = Date.now();
      const sock = new net.Socket();
      let resolved = false;
      sock.setTimeout(PING_TIMEOUT);
      sock.once('connect', () => {
        if (!resolved) {
          resolved = true;
          tries.push(Date.now() - start);
          sock.destroy();
          if (++done === PING_TRIES) finish();
        }
      });
      sock.once('timeout', () => { if (!resolved) { resolved = true; sock.destroy(); if (++done === PING_TRIES) finish(); } });
      sock.once('error', () => { if (!resolved) { resolved = true; sock.destroy(); if (++done === PING_TRIES) finish(); } });
      sock.connect(port, addr);
    }
    function finish() {
      if (tries.length === 0) return resolve({ ok: false, error: '超时' });
      const avg = Math.round(tries.reduce((a, b) => a + b, 0) / tries.length);
      resolve({ ok: true, ms: avg, tries: tries.length });
    }
  });
}

// 检查所有用户节点，更新健康状态
async function checkAll() {
  const cfg = getConfig();
  if (!cfg || !Array.isArray(cfg.outbounds)) return;
  const userNodes = cfg.outbounds.filter(n => !isSystemNode(n.tag));

  // v1.14.0+ 并发限流（p-limit 10）：20 节点从 8N 秒串行 → 最多 2s 内全部开始 ping
  // 修 v1.13.0 风险：N 节点 × 3 次尝试 × 5s 超时 = 最坏 8N 秒（20 节点 = 2.7min）
  const CHECK_CONCURRENCY = 10;
  const limit = pLimit(CHECK_CONCURRENCY);

  // 并发 ping + 收集结果（v1.14.0+ 修：原 for await 串行 → Promise.all 并发）
  const results = await Promise.all(userNodes.map((node) => limit(async () => {
    const r = await pingNode(node);
    const prev = _health[node.tag] || { failCount: 0 };
    let shouldDisable = false;
    let newCount = 0;
    if (r.ok) {
      _health[node.tag] = {
        failCount: 0,
        lastCheck: Date.now(),
        lastLatency: r.ms,
        lastSuccess: Date.now(),
        disabled: prev.disabled || false
      };
    } else {
      newCount = (prev.failCount || 0) + 1;
      shouldDisable = newCount >= FAIL_THRESHOLD && !prev.disabled;
      _health[node.tag] = {
        failCount: newCount,
        lastCheck: Date.now(),
        lastError: r.error,
        disabled: shouldDisable || prev.disabled || false
      };
    }
    // v1.13.0+ 记录延迟历史
    recordHistory(node.tag, r.ok ? r.ms : null, r.ok);
    return { node, shouldDisable, newCount };
  })));

  // v1.14.0+ 修：失败禁用节点统一一次 setConfig（避免 5 个失败触发 5 次 reload）
  // 修 v1.13.0 风险：5 个节点同时失败 → 5 次 setConfig → 5 次 SIGUSR2 reloadConfig
  const toDisable = results.filter(r => r.shouldDisable);
  if (toDisable.length > 0) {
    const disabledTags = [];
    for (const { node, newCount } of toDisable) {
      const idx = cfg.outbounds.findIndex(o => o.tag === node.tag);
      if (idx >= 0) {
        cfg.outbounds[idx]._disabled = true;
        cfg.outbounds[idx]._health_disabled = true;
        disabledTags.push(`${node.tag} (连续失败 ${newCount} 次)`);
        logToInfo(`[health] 节点 ${node.tag} 连续失败 ${newCount} 次，自动禁用`);
      }
    }
    setConfig(cfg);  // 一次 reload（批量禁用）
    // v1.16.0+ 通知：节点自动禁用（合并多条为一次通知，避免刷屏）
    if (disabledTags.length > 0) {
      notify.send('node_disabled', {
        title: disabledTags.length === 1 ? '节点自动禁用' : `${disabledTags.length} 个节点自动禁用`,
        message: disabledTags.join('\n')
      }).catch(() => {});
    }
  }

  // v1.16.0+ 节点失效率统计（禁用比例）
  const allUserNodes = cfg.outbounds.filter(o => !isSystemNode(o));
  const userNodeTags = allUserNodes.map(o => o.tag);
  const disabledCount = userNodeTags.filter(t => _health[t] && _health[t].disabled).length;
  if (userNodeTags.length >= 3) {  // 至少 3 个节点才统计（避免误报）
    const failRate = disabledCount / userNodeTags.length;
    if (failRate >= 0.8) {
      notify.send('node_health_low', {
        title: '节点健康率低',
        message: `${disabledCount}/${userNodeTags.length} 节点被禁用（${Math.round(failRate * 100)}%）\n请检查网络或节点质量`
      }).catch(() => {});
    }
  }

  saveHealth();
  // v1.14.0+ history 截断（> 2500 行才截，避免频繁 IO；5min 跑一次足够）
  try { recordHistory && require('./history').truncateIfNeeded && require('./history').truncateIfNeeded(); } catch (_) {}
  // v1.13.0+ 自动选最优节点（开启时跑 tick）
  try { autoSelect.tick(); } catch (e) { logToInfo('[health] auto-select tick 异常: ' + e.message); }
  return _health;
}

// 重置某个节点（重新启用 + 清零失败计数）
function resetNode(tag) {
  _health[tag] = { failCount: 0, lastCheck: Date.now(), disabled: false, lastReset: Date.now() };
  saveHealth();
  // 取消 _disabled
  const cfg = getConfig();
  if (cfg && Array.isArray(cfg.outbounds)) {
    const idx = cfg.outbounds.findIndex(o => o.tag === tag);
    if (idx >= 0) {
      delete cfg.outbounds[idx]._health_disabled;
      // 不主动 _disabled=false，让用户自己手动启用
      setConfig(cfg);
    }
  }
  logToInfo(`[health] 节点 ${tag} 健康状态已重置`);
  return _health[tag];
}

function startScheduler() {
  if (_timer) return;
  loadHealth();
  // 启动 30s 后做第一次检查（让应用先稳定）
  setTimeout(() => {
    logToInfo('[health] 启动节点健康检查（每 5 分钟）');
    checkAll().catch(e => logToInfo('[health] 检查异常: ' + e.message));
    _timer = setInterval(() => {
      checkAll().catch(e => logToInfo('[health] 检查异常: ' + e.message));
    }, CHECK_INTERVAL);
  }, 30 * 1000);
}

function stopScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

function getHealth() {
  return _health;
}

module.exports = {
  startScheduler,
  stopScheduler,
  checkAll,
  resetNode,
  getHealth,
  loadHealth,
  saveHealth,
  pingNode,
  FAIL_THRESHOLD,
  CHECK_INTERVAL
};
