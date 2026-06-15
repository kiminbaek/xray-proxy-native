// xray 共享工具模块（v1.6.0+）
// 路径常量、文件操作小工具、写 info.log
// 所有 xray/* 子模块都依赖此文件

const fs = require('fs');
const os = require('os');
const path = require('path');

// ====== 路径配置 ======
// TRIM_PKGVAR 必须在启动时由 cmd/main 注入
// 硬编码 /tmp fallback 仅作为最后兜底（开发模式用）
const DATA_DIR = process.env.TRIM_PKGVAR || path.join(os.tmpdir(), 'xray-proxy-native');
const CONFIG_DIR = path.join(DATA_DIR, 'xray');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const BACKUP_FILE = path.join(CONFIG_DIR, 'config.json.bak');
const LOG_FILE = path.join(DATA_DIR, 'xray.log');
const PID_FILE = path.join(DATA_DIR, 'xray.pid');
// v1.4.0+ 守护进程 / 鉴权 等运维信息日志（与 cmd/main 的 log_msg 共享同一文件）
const INFO_LOG_FILE = path.join(DATA_DIR, 'info.log');

// xray 启动后探测 URL（用于检查是否真正起来）
const XRAY_STATS_API = 'http://127.0.0.1:10085/stats';
// v1.5.0+ 流量状态持久化文件（xray 重启后不丢失累计）
const TRAFFIC_STATE_FILE = path.join(DATA_DIR, 'traffic_state.json');

// 写 info.log（v1.4.0+ 守护等运维信息用），格式与 cmd/main 的 log_msg 一致
// v1.7.0+ 改用流式写入（避免每条日志都同步阻塞）
let _infoStream = null;
function _getInfoStream() {
  if (_infoStream && !_infoStream.destroyed) return _infoStream;
  try {
    ensureDir(path.dirname(INFO_LOG_FILE));
    _infoStream = fs.createWriteStream(INFO_LOG_FILE, { flags: 'a' });
    _infoStream.on('error', () => { _infoStream = null; });
    return _infoStream;
  } catch (_) {
    return null;
  }
}
function logToInfo(msg) {
  try {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const line = `${ts} - ${msg}\n`;
    const s = _getInfoStream();
    if (s) s.write(line);
    else fs.appendFileSync(INFO_LOG_FILE, line); // 兜底
  } catch (_) {}
}

// v1.7.0+ 进程退出时关闭 info.log 流
function closeLogStreams() {
  if (_infoStream && !_infoStream.destroyed) {
    try { _infoStream.end(); } catch (_) {}
    _infoStream = null;
  }
}

// ====== 工具函数 ======
function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function fileExists(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (_) { return false; }
}

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf-8'); } catch (_) { return null; }
}

// 原子写入：先写 .tmp，再 rename（避免半写状态）
function atomicWriteFile(target, content) {
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}

// v1.14.0+ 并发限流器（p-limit 简化版，零依赖）
// 用于：批量测速（test-all）/ 健康检查（checkAll）/ 历史批量查询
// 修 v1.13.0 风险：N 个节点 Promise.all 全部并发 → 100 节点触发目标节点限流/IP 黑名单
// 用法：
//   const limit = pLimit(10);
//   await Promise.all(arr.map(item => limit(() => doWork(item))));
function pLimit(concurrency) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('pLimit: concurrency must be a positive integer');
  }
  const queue = [];
  let active = 0;

  function next() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(
      (v) => { resolve(v); },
      (e) => { reject(e); }
    ).finally(() => {
      active--;
      next();
    });
  }

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

module.exports = {
  // 路径
  DATA_DIR,
  CONFIG_DIR,
  CONFIG_FILE,
  BACKUP_FILE,
  LOG_FILE,
  PID_FILE,
  INFO_LOG_FILE,
  XRAY_STATS_API,
  TRAFFIC_STATE_FILE,
  // 工具
  logToInfo,
  closeLogStreams,
  ensureDir,
  fileExists,
  readFileSafe,
  atomicWriteFile,
  pLimit
};
