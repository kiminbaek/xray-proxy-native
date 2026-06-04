// xray 业务模块（v1.6.0+ 重构版）
// 入口文件：re-export 所有子模块接口 + 统一调度 reloadConfig
// 内部实现拆分为 xray/ 子目录：binary / config / process / parsers / nodes / stats / logs / utils

const { findXray, clearBinaryCache } = require('./xray/binary');
const {
  defaultConfig, defaultSeedNodes, validateConfig, isEmptyConfig,
  getConfig, setConfig, sanitizeConfig
} = require('./xray/config');
const {
  startXray, stopXray, restartXray, reloadConfig,
  killExistingXray, getStatus, cleanup,
  scheduleAutoRestart, getAutoRestartStatus, setAutoRestart
} = require('./xray/process');
const { parseShareLink, parseVmess, parseVless, parseTrojan, parseSs } = require('./xray/parsers');
const { getTraffic, fetchStats, readTrafficState, writeTrafficState, getHistory } = require('./xray/stats');
const { getLogs, rotateLogs, tailSSE } = require('./xray/logs');
// v1.13.0+ 节点延迟历史
const history = require('./xray/history');
// v1.13.0+ 自动选择最优节点
const autoSelect = require('./xray/auto_select');
const {
  addNode: _addNode, deleteNode: _deleteNode, updateNode: _updateNode,
  toggleNode: _toggleNode, reorderNodes: _reorderNodes, testNode
} = require('./xray/nodes');

// ====== v1.6.0+ 统一调度：B - 配置变更自动热加载（修 v1.5.1 bug）======
// 节点增删改后，xray 不会自动重新读取配置 → 用户修改的节点不生效
// 这里在每个变更操作后自动调 reloadConfig（SIGUSR2）
// reloadConfig 内部会检查 xrayProcess 是否在跑，xray 未运行则跳过
// 失败时回退到 restartXray（process.js 内已做）
function tryReload() {
  return reloadConfig().catch((e) => ({ ok: false, error: e.message }));
}

function addNode(node) {
  const tag = _addNode(node);
  tryReload();
  return tag;
}

function deleteNode(tag) {
  const ok = _deleteNode(tag);
  if (ok) tryReload();
  return ok;
}

function updateNode(tag, patch) {
  const node = _updateNode(tag, patch);
  if (node) tryReload();
  return node;
}

function toggleNode(tag, enabled) {
  const node = _toggleNode(tag, enabled);
  if (node) tryReload();
  return node;
}

function reorderNodes(tags) {
  _reorderNodes(tags);
  tryReload();
}

// 完整配置替换（v1.5.0 已有 setConfig 接口）
// 包装为支持热加载
function setConfigHotReload(config) {
  setConfig(config);
  tryReload();
}

// getTraffic 包装（process.js 的 xrayProcess 暴露给 stats.js）
async function getTrafficWithProcess() {
  return getTraffic(require('./xray/process').xrayProcess);
}

module.exports = {
  // xray 二进制
  findXray,
  clearBinaryCache,
  // 配置
  defaultConfig,
  defaultSeedNodes,
  validateConfig,
  isEmptyConfig,
  getConfig,
  setConfig: setConfigHotReload,    // 用热加载版本
  sanitizeConfig,
  // 进程
  startXray,
  stopXray,
  restartXray,
  reloadConfig,                      // B: 暴露供外部调用
  killExistingXray,
  getStatus,
  cleanup,
  // 守护
  scheduleAutoRestart,
  getAutoRestartStatus,
  setAutoRestart,
  // 节点
  addNode,
  deleteNode,
  updateNode,
  toggleNode,
  reorderNodes,
  testNode,
  // 解析
  parseShareLink,
  parseVmess,
  parseVless,
  parseTrojan,
  parseSs,
  // 流量
  getTraffic: getTrafficWithProcess,
  getHistory,
  fetchStats,
  readTrafficState,
  writeTrafficState,
  // 日志
  getLogs,
  rotateLogs,
  tailSSE,
  // v1.13.0+ 节点延迟历史
  history,
  // v1.13.0+ 自动选择最优节点
  autoSelect
};
