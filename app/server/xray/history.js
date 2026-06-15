// 节点延迟历史（v1.13.0+，v1.14.0 重构为 NDJSON 增量写）
// 功能：
//   1. 环形 buffer：每节点最多 MAX_RECORDS 条（默认 2000 = 7d × 24h × 12 次/h，5min 检查一次）
//   2. 持久化：v1.14.0+ NDJSON 增量写（替代 v1.13.0 全量重写）
//      - DATA_DIR/history.ndjson：每行一个 {tag, t, ms, ok} JSON
//      - append 一行 = 5-50 字节写盘（v1.13.0 是 80KB 全量重写）
//   3. 集成点：health.js checkAll（5min 自动）+ nodes.js testNode（手动测速）
//   4. API：getHistory(tag, hours) / getAll() / recordHistory(tag, ms, ok)
//   5. 内存 + 文件双层：避免每次读文件
//   6. v1.14.0+ 启动时迁移 v1.13.0 node_history.json (JSON object) → history.ndjson (NDJSON)

const fs = require('fs');
const path = require('path');
const { logToInfo } = require('./utils');

const DATA_DIR = process.env.TRIM_PKGVAR || '/tmp/xray-proxy-native';
// v1.14.0+ NDJSON 增量写
const HISTORY_FILE = path.join(DATA_DIR, 'history.ndjson');
// v1.13.0 旧文件（启动时一次性迁移，迁移后删除）
const LEGACY_HISTORY_FILE = path.join(DATA_DIR, 'node_history.json');
const MAX_RECORDS = 2000;  // 每节点最多保留 2000 条（5min 间隔约 7 天）
const TRUNCATE_THRESHOLD = 2500;  // 超过此行数才截断（避免频繁 IO）

// 内存：{ [tag]: [{t, ms, ok}, ...] }，每节点按 t 升序
let _history = {};
let _loaded = false;
let _migrated = false;

// v1.14.0+ 启动时迁移 v1.13.0 node_history.json
// 旧格式：{ tag1: [{t, ms, ok}, ...], tag2: [...], _auto_select: {...} }
// 新格式：history.ndjson 每行 {tag, t, ms, ok}
// 注意：_auto_select 字段由 auto_select.js 单独处理（auto_select.json），本函数不感知
function migrateFromLegacy() {
  if (_migrated) return;
  _migrated = true;
  if (!fs.existsSync(LEGACY_HISTORY_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(LEGACY_HISTORY_FILE, 'utf-8'));
    if (typeof data !== 'object' || Array.isArray(data)) {
      // 不是预期格式，直接删
      fs.unlinkSync(LEGACY_HISTORY_FILE);
      logToInfo('[history] v1.13.0 node_history.json 格式异常，已删除');
      return;
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    let totalEntries = 0;
    let nodeCount = 0;
    const lines = [];
    for (const key of Object.keys(data)) {
      if (key === '_auto_select') continue;  // 剥离 autoSelect（由 auto_select.js 处理）
      const list = data[key];
      if (!Array.isArray(list) || list.length === 0) continue;
      // 截到 MAX_RECORDS（保留最新）
      const keep = list.slice(-MAX_RECORDS);
      for (const e of keep) {
        if (!e || typeof e.t !== 'number') continue;
        lines.push(JSON.stringify({ tag: key, t: e.t, ms: e.ms == null ? null : e.ms, ok: !!e.ok }));
        totalEntries++;
      }
      nodeCount++;
    }
    if (lines.length > 0) {
      fs.writeFileSync(HISTORY_FILE, lines.join('\n') + '\n');
    }
    // v1.14.0+ 保留老文件不删（auto_select.js 启动时兜底读 _auto_select 字段）
    // 老文件几 KB，留在磁盘上无影响；auto_select 读完会写新文件，下次启动走新文件
    logToInfo(`[history] v1.13.0 → v1.14.0 迁移完成: ${nodeCount} 节点 / ${totalEntries} 条 → ${HISTORY_FILE}（保留老文件 ${LEGACY_HISTORY_FILE}）`);
  } catch (e) {
    logToInfo('[history] 迁移失败: ' + e.message);
  }
}

function loadHistory() {
  if (_loaded) return;
  // 先尝试迁移老文件
  migrateFromLegacy();
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      _history = {};
      _loaded = true;
      return;
    }
    const content = fs.readFileSync(HISTORY_FILE, 'utf-8');
    if (!content) { _history = {}; _loaded = true; return; }
    const lines = content.split('\n');
    _history = {};
    for (const line of lines) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (!e || !e.tag || typeof e.t !== 'number') continue;
        if (!_history[e.tag]) _history[e.tag] = [];
        _history[e.tag].push({ t: e.t, ms: e.ms, ok: !!e.ok });
      } catch (_) { /* skip malformed line */ }
    }
    // 环形 buffer 截断（迁移后或新增超限）
    for (const tag of Object.keys(_history)) {
      if (_history[tag].length > MAX_RECORDS) {
        _history[tag] = _history[tag].slice(-MAX_RECORDS);
      }
    }
  } catch (e) {
    _history = {};
    logToInfo('[history] 读取失败: ' + e.message);
  }
  _loaded = true;
}

// 记录一条历史（v1.14.0+ 增量 append NDJSON，替代 v1.13.0 全量重写）
function recordHistory(tag, ms, ok) {
  if (!tag) return;
  loadHistory();
  const t = Date.now();
  const entry = { t, ms: ms == null ? null : Math.round(ms), ok: !!ok };
  if (!_history[tag]) _history[tag] = [];
  _history[tag].push(entry);
  // 环形 buffer：超出 MAX_RECORDS 截掉最旧的（内存）
  if (_history[tag].length > MAX_RECORDS) {
    _history[tag] = _history[tag].slice(-MAX_RECORDS);
  }
  // v1.14.0+ 增量 append（替代 v1.13.0 全量重写：80KB → 50B）
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const line = JSON.stringify({ tag, t: entry.t, ms: entry.ms, ok: entry.ok }) + '\n';
    fs.appendFileSync(HISTORY_FILE, line);
  } catch (e) {
    logToInfo('[history] 追加失败: ' + e.message);
  }
}

// v1.14.0+ 后台截断：> 2500 行才截到 2000，避免频繁 IO
// 由调用方周期性触发（如 health.js checkAll 末尾）
function truncateIfNeeded() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    const content = fs.readFileSync(HISTORY_FILE, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length <= TRUNCATE_THRESHOLD) return;
    // 按 tag 分组截断（每节点独立 2000 条）
    const byTag = {};
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (!e || !e.tag) continue;
        if (!byTag[e.tag]) byTag[e.tag] = [];
        byTag[e.tag].push(line);
      } catch (_) { /* skip */ }
    }
    const kept = [];
    for (const tag of Object.keys(byTag)) {
      const list = byTag[tag];
      if (list.length > MAX_RECORDS) {
        // 保留最后 MAX_RECORDS 行
        kept.push(...list.slice(-MAX_RECORDS));
        // 同步内存
        if (_history[tag]) _history[tag] = _history[tag].slice(-MAX_RECORDS);
      } else {
        kept.push(...list);
      }
    }
    if (kept.length < lines.length) {
      fs.writeFileSync(HISTORY_FILE, kept.join('\n') + '\n');
      logToInfo(`[history] truncate: ${lines.length} → ${kept.length} 行`);
    }
  } catch (e) {
    logToInfo('[history] truncate 失败: ' + e.message);
  }
}

// 获取某节点的历史
//   hours: 多少小时内（默认 168 = 7d）
//   返回：[{t, ms, ok}, ...]（按 t 升序）
function getHistory(tag, hours) {
  loadHistory();
  const list = _history[tag] || [];
  if (!hours || hours <= 0) return list;
  const since = Date.now() - hours * 3600 * 1000;
  // 二分查找：找到第一个 t >= since 的位置
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].t < since) lo = mid + 1;
    else hi = mid;
  }
  return list.slice(lo);
}

// 获取所有节点的历史（聚合）
//   hours: 多少小时内
//   返回：{ [tag]: [{t, ms, ok}, ...] }
function getAllHistory(hours) {
  loadHistory();
  const result = {};
  for (const tag of Object.keys(_history)) {
    result[tag] = getHistory(tag, hours);
  }
  return result;
}

// 清理某节点历史
function clearNode(tag) {
  loadHistory();
  if (_history[tag]) {
    delete _history[tag];
    // v1.14.0+ 重写整个文件（删 tag 的所有行）
    rewriteFile();
  }
}

// 清理所有历史
function clearAll() {
  _history = {};
  try { fs.unlinkSync(HISTORY_FILE); } catch (_) {}
}

// 内部：删了 tag 后全量重写（删除场景不频繁，OK 用全量）
function rewriteFile() {
  try {
    const lines = [];
    for (const tag of Object.keys(_history)) {
      for (const e of _history[tag]) {
        lines.push(JSON.stringify({ tag, t: e.t, ms: e.ms, ok: e.ok }));
      }
    }
    if (lines.length > 0) {
      fs.writeFileSync(HISTORY_FILE, lines.join('\n') + '\n');
    } else {
      try { fs.unlinkSync(HISTORY_FILE); } catch (_) {}
    }
  } catch (e) {
    logToInfo('[history] rewrite 失败: ' + e.message);
  }
}

module.exports = {
  getHistory,
  getAllHistory,
  recordHistory,
  truncateIfNeeded,
  clearNode,
  clearAll,
  HISTORY_FILE
};
