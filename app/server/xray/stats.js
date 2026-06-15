// xray 流量统计模块（v1.5.0+）
// 拉取 xray stats API + 持久化累计流量
// v1.6.0+ 抽离为独立模块
// v1.7.3+ 改用 gRPC（xray 的 api inbound 走 gRPC 协议，不是 HTTP）
// 依赖：@grpc/grpc-js + @grpc/proto-loader

const path = require('path');
const protoLoader = require('@grpc/proto-loader');
const grpc = require('@grpc/grpc-js');
const {
  readFileSafe,
  atomicWriteFile,
  TRAFFIC_STATE_FILE
} = require('./utils');

// gRPC 客户端单例（懒加载，避免启动慢）
let _grpcClient = null;
let _grpcInitErr = null;

function getGrpcClient() {
  if (_grpcClient) return _grpcClient;
  if (_grpcInitErr) return null;

  // .proto 写在 server/xray/ 目录，npm install 时不会动它
  const protoPath = path.join(__dirname, 'stats.proto');
  const packageDef = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true
  });
  const proto = grpc.loadPackageDefinition(packageDef);
  const StatsService = proto.v2ray.core.app.stats.command.StatsService;
  _grpcClient = new StatsService('127.0.0.1:10085', grpc.credentials.createInsecure());
  return _grpcClient;
}

// 调 gRPC QueryStats(pattern="") 拿所有 stat 条目
// 3 秒超时（用 Promise.race 强制超时）
function fetchStats() {
  return new Promise((resolve) => {
    const client = getGrpcClient();
    if (!client) {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(null), 3000);

    client.QueryStats({ pattern: '', reset: false }, (err, response) => {
      clearTimeout(timer);
      if (err || !response) {
        // gRPC 错误：可能是 client 未初始化（下次重试）
        if (err && err.code === grpc.status.UNAVAILABLE) {
          _grpcClient = null;  // 重置，下次重建
        }
        finish(null);
      } else {
        finish({ stat: response.stat || [] });
      }
    });
  });
}

function readTrafficState() {
  const raw = readFileSafe(TRAFFIC_STATE_FILE);
  if (!raw) return { last_pid: null, session_stat: null, total: {}, history: [] };
  try {
    const s = JSON.parse(raw);
    if (!Array.isArray(s.history)) s.history = [];
    return s;
  } catch (_) {
    return { last_pid: null, session_stat: null, total: {}, history: [] };
  }
}

function writeTrafficState(state) {
  try {
    atomicWriteFile(TRAFFIC_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (_) {}
}

// v1.10.0+ 每小时记录一个数据点，保留 24h
// v1.12.0+ 优化：perNode 是新生成的 {tag: {up, down}} 对象，不需要深拷贝
function recordHistory(state, totalUp, totalDown, perNode) {
  if (!Array.isArray(state.history)) state.history = [];
  const now = Date.now();
  const last = state.history[state.history.length - 1];
  // 一小时内只更新最后一个数据点
  if (last && (now - last.t) < 3600 * 1000) {
    last.up = totalUp;
    last.down = totalDown;
    last.nodes = perNode;
  } else {
    state.history.push({ t: now, up: totalUp, down: totalDown, nodes: perNode });
  }
  // 只保留 24 个数据点（24h）
  if (state.history.length > 24) state.history = state.history.slice(-24);
}

function getHistory() {
  const state = readTrafficState();
  return state.history || [];
}

// 获取累计流量（按 outbound tag 分组）
// 检测 xray 重启（pid 变化）→ 新会话基线 → 累加差值
async function getTraffic(xrayProcess) {
  if (!xrayProcess || xrayProcess.exitCode !== null) {
    return { ok: false, error: 'xray 未运行', running: false, traffic: {}, inbound: {}, total: { up: 0, down: 0 } };
  }
  const pid = xrayProcess.pid;
  const data = await fetchStats();
  if (!data || !Array.isArray(data.stat)) {
    return { ok: false, error: 'stats API 无响应', running: true, traffic: {}, inbound: {}, total: { up: 0, down: 0 } };
  }
  // v1.7.0+ 分类解析：outbound 与 inbound
  // outbound>>>tag>>>traffic>>>bytes_in/out  = 转发出站流量
  // inbound>>>tag>>>traffic>>>uplink/downlink = 用户实际消费
  const currentOut = {};
  const currentIn = {};
  for (const s of data.stat) {
    let m = s.name.match(/^outbound>>>([^>]+)>>>traffic>>>(bytes_in|bytes_out)$/);
    if (m) {
      const tag = m[1];
      if (!currentOut[tag]) currentOut[tag] = { up: 0, down: 0 };
      if (m[2] === 'bytes_in') currentOut[tag].up += s.value;
      else currentOut[tag].down += s.value;
      continue;
    }
    m = s.name.match(/^inbound>>>([^>]+)>>>traffic>>>(uplink|downlink)$/);
    if (m) {
      const tag = m[1];
      if (!currentIn[tag]) currentIn[tag] = { up: 0, down: 0 };
      if (m[2] === 'uplink') currentIn[tag].up += s.value;
      else currentIn[tag].down += s.value;
    }
  }
  // 加载持久化状态
  const state = readTrafficState();
  // 检测 xray 重启（pid 变了 → 新会话）
  if (state.last_pid !== pid) {
    state.session_out = currentOut;
    state.session_in = currentIn;
    state.last_pid = pid;
  } else if (!state.session_out) {
    state.session_out = currentOut;
    state.session_in = currentIn;
  }
  // 累计 outbound = (current - session) + 旧 total
  const result = {};
  for (const tag of Object.keys(currentOut)) {
    const sess = (state.session_out && state.session_out[tag]) || { up: 0, down: 0 };
    const prev = (state.total_out && state.total_out[tag]) || { up: 0, down: 0 };
    const du = Math.max(0, currentOut[tag].up - sess.up);
    const dd = Math.max(0, currentOut[tag].down - sess.down);
    result[tag] = { up: prev.up + du, down: prev.down + dd };
  }
  // 累计 inbound
  const resultIn = {};
  for (const tag of Object.keys(currentIn)) {
    const sess = (state.session_in && state.session_in[tag]) || { up: 0, down: 0 };
    const prev = (state.total_in && state.total_in[tag]) || { up: 0, down: 0 };
    const du = Math.max(0, currentIn[tag].up - sess.up);
    const dd = Math.max(0, currentIn[tag].down - sess.down);
    resultIn[tag] = { up: prev.up + du, down: prev.down + dd };
  }
  state.total_out = result;
  state.total_in = resultIn;
  // 合计（outbound）—— v1.10.0+ 必须先算好 totalUp/Down 再传给 recordHistory
  let totalUp = 0, totalDown = 0;
  for (const tag of Object.keys(result)) {
    totalUp += result[tag].up;
    totalDown += result[tag].down;
  }
  // v1.10.0+ 24h 历史：每小时记一个数据点
  recordHistory(state, totalUp, totalDown, result);
  writeTrafficState(state);
  // v1.7.0+ 按流量降序排序（用户最关心哪些节点用得多）
  const sorted = Object.keys(result)
    .map(tag => ({ tag, ...result[tag], total: result[tag].up + result[tag].down }))
    .sort((a, b) => b.total - a.total);
  return {
    ok: true,
    running: true,
    traffic: result,         // 兼容旧版（按 tag key 索引）
    traffic_sorted: sorted,  // v1.7.0+ 按流量降序
    inbound: resultIn,       // v1.7.0+ 用户实际消费流量
    total: { up: totalUp, down: totalDown, total: totalUp + totalDown }
  };
}

module.exports = {
  fetchStats,
  readTrafficState,
  writeTrafficState,
  getTraffic,
  getHistory
};
