// 自动选择最优节点（v1.13.0+）
// 功能：
//   1. 每次 health check 后调 tick()，决策是否切换到最优节点
//   2. 抖动保护：连续 stableCount 次候选不同才切换（默认 3 次）
//   3. 最小间隔：距上次切换 < minIntervalMs 不再切换（默认 30s）
//   4. 切换实现：复用 reorderNodes()（v1.6.0 SIGUSR2 热加载 0 断流）
//   5. 状态持久化：v1.14.0+ 拆到独立 auto_select.json（v1.13.0 与 history 同文件 node_history.json）
//      启动时 history.js 迁移 node_history.json → history.ndjson 时，剥离 _auto_select 字段
//      → 写本文件

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config');
const { getHistory } = require('./history');
const { isSystemNode, reorderNodes } = require('./nodes');
const { reloadConfig } = require('./process');
const { logToInfo } = require('./utils');

const DATA_DIR = process.env.TRIM_PKGVAR || '/tmp/xray-proxy-native';
// v1.14.0+ 独立文件（v1.13.0 与 history 共用 node_history.json）
const AUTO_SELECT_FILE = path.join(DATA_DIR, 'auto_select.json');
// v1.13.0 旧文件（启动时一次性兜底读取，读取后不再写入）
const LEGACY_HISTORY_FILE = path.join(DATA_DIR, 'node_history.json');

const DEFAULT_CONFIG = {
  enabled: false,           // 默认关闭（避免误操作，用户主动开）
  stableCount: 3,           // 连续 N 次候选不同才切换
  minIntervalMs: 30000,     // 距上次切换最小间隔（30s）
  avgWindow: 5,             // 计算平均延迟用最近 N 条历史
  maxLatency: 5000,         // 超过这个延迟视为不可用（不参与最优）
  lastSwitchAt: 0,          // 上次切换时间戳
  stableCounter: 0,         // 当前候选稳定计数
  lastCandidate: null       // 上一次的候选
};

let _config = { ...DEFAULT_CONFIG };

function loadConfig() {
  // v1.14.0+ 优先读独立文件
  try {
    const raw = JSON.parse(fs.readFileSync(AUTO_SELECT_FILE, 'utf-8'));
    if (raw && typeof raw === 'object') {
      _config = { ...DEFAULT_CONFIG, ...raw };
      return;
    }
  } catch (_) { /* 文件不存在 fallback 到 v1.13.0 旧文件 */ }
  // v1.13.0 旧文件兜底（v1.14.0 首次升级时，history.js 迁移 node_history.json 后保留此文件）
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_HISTORY_FILE, 'utf-8'));
    if (legacy && legacy._auto_select && typeof legacy._auto_select === 'object') {
      _config = { ...DEFAULT_CONFIG, ...legacy._auto_select };
      // 顺手写到新文件，下次启动直接走新文件
      saveConfig();
      logToInfo('[auto-select] 从 v1.13.0 node_history.json 迁移 _auto_select 字段 → ' + AUTO_SELECT_FILE);
    }
  } catch (_) { /* 文件不存在用默认 */ }
}

function saveConfig() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(AUTO_SELECT_FILE, JSON.stringify(_config, null, 2));
  } catch (e) {
    logToInfo('[auto-select] 配置保存失败: ' + e.message);
  }
}

function getConfig_public() {
  return { ..._config };
}

function setConfig_public(patch) {
  const allowed = ['enabled', 'stableCount', 'minIntervalMs', 'avgWindow', 'maxLatency'];
  for (const k of allowed) {
    if (k in patch) _config[k] = patch[k];
  }
  // 验证
  _config.stableCount = Math.max(1, Math.min(10, parseInt(_config.stableCount) || 3));
  _config.minIntervalMs = Math.max(0, Math.min(600000, parseInt(_config.minIntervalMs) || 30000));
  _config.avgWindow = Math.max(1, Math.min(50, parseInt(_config.avgWindow) || 5));
  _config.maxLatency = Math.max(100, Math.min(30000, parseInt(_config.maxLatency) || 5000));
  _config.enabled = !!_config.enabled;
  saveConfig();
  return getConfig_public();
}

// 计算某节点最近 N 条平均延迟
function avgLatency(tag, n) {
  const list = getHistory(tag, 24 * 7);  // 看 7d
  if (!list.length) return null;
  const recent = list.slice(-n);
  const valid = recent.filter(r => r.ok && r.ms != null);
  if (!valid.length) return null;
  const sum = valid.reduce((a, r) => a + r.ms, 0);
  return sum / valid.length;
}

// 找最优节点（不修改 _config）
function findOptimal() {
  const cfg = getConfig();
  if (!cfg || !Array.isArray(cfg.outbounds)) return null;
  const candidates = cfg.outbounds.filter(o =>
    !isSystemNode(o.tag) && !o._health_disabled && !o._disabled
  );
  if (candidates.length === 0) return null;
  // 计算 avg 延迟并排序
  const ranked = candidates
    .map(o => ({ tag: o.tag, avg: avgLatency(o.tag, _config.avgWindow) }))
    .filter(c => c.avg != null && c.avg <= _config.maxLatency)
    .sort((a, b) => a.avg - b.avg);
  return ranked.length > 0 ? ranked[0].tag : null;
}

// 获取当前代理第一节点（proxy tag 或第一个真实代理）
function getCurrentPrimary() {
  const cfg = getConfig();
  if (!cfg || !Array.isArray(cfg.outbounds)) return null;
  // 找 'proxy' tag（如果存在）或第一个非系统节点
  const proxy = cfg.outbounds.find(o => o.tag === 'proxy');
  if (proxy) return proxy.tag;
  const first = cfg.outbounds.find(o => !isSystemNode(o.tag));
  return first ? first.tag : null;
}

// tick：每次 health check 后调一次
// 决策：
//   1. 找候选最优
//   2. 跟当前第一比
//   3. 不同 → stableCounter++
//   4. 相同 → stableCounter = 0
//   5. stableCounter >= stableCount AND 距上次切换 > minIntervalMs → 切换
function tick() {
  if (!_config.enabled) return { skipped: 'disabled' };

  const candidate = findOptimal();
  const current = getCurrentPrimary();
  if (!candidate || !current) return { skipped: 'no-candidate', candidate, current };
  if (candidate === current) {
    if (_config.stableCounter !== 0) {
      _config.stableCounter = 0;
      saveConfig();
    }
    return { skipped: 'same', candidate, current, stableCounter: 0 };
  }

  // 候选不同
  if (_config.lastCandidate !== candidate) {
    _config.stableCounter = 1;
    _config.lastCandidate = candidate;
  } else {
    _config.stableCounter++;
  }
  saveConfig();

  if (_config.stableCounter < _config.stableCount) {
    return { waiting: true, candidate, current, stableCounter: _config.stableCounter, needed: _config.stableCount };
  }

  // 距上次切换太近，跳过
  const now = Date.now();
  if (now - _config.lastSwitchAt < _config.minIntervalMs) {
    return { waiting: 'min-interval', candidate, current, sinceLastSwitchMs: now - _config.lastSwitchAt };
  }

  // 执行切换
  const switched = switchTo(candidate);
  if (switched.ok) {
    _config.lastSwitchAt = now;
    _config.stableCounter = 0;
    _config.lastCandidate = null;
    saveConfig();
    logToInfo(`[auto-select] 已切换到最优节点: ${current} → ${candidate} (avg=${switched.avg}ms)`);
  }
  return { switched, candidate, current };
}

// 立即切换到指定节点（不走抖动保护）
function switchTo(tag) {
  const cfg = getConfig();
  if (!cfg || !Array.isArray(cfg.outbounds)) return { ok: false, error: '无配置' };
  const target = cfg.outbounds.find(o => o.tag === tag);
  if (!target) return { ok: false, error: '节点不存在: ' + tag };
  if (isSystemNode(tag)) return { ok: false, error: '不能切换到系统节点' };

  // 重组 outbounds：target 放第一个，其他保持原顺序
  const rest = cfg.outbounds.filter(o => o.tag !== tag);
  const newOrder = [target, ...rest];
  const newTags = newOrder.map(o => o.tag);

  // 走 reorderNodes + reloadConfig 统一路径（v1.6.0+ SIGUSR2 热加载 0 断流）
  reorderNodes(newTags);
  reloadConfig().catch((e) => logToInfo('[auto-select] reload 失败: ' + e.message));

  // 重置 stableCounter
  _config.stableCounter = 0;
  _config.lastSwitchAt = Date.now();
  _config.lastCandidate = null;
  saveConfig();

  return { ok: true, tag, avg: avgLatency(tag, _config.avgWindow), newOrder: newTags };
}

module.exports = {
  loadConfig,
  saveConfig,
  getConfig: getConfig_public,
  setConfig: setConfig_public,
  avgLatency,
  findOptimal,
  getCurrentPrimary,
  tick,
  switchTo,
  DEFAULT_CONFIG
};
