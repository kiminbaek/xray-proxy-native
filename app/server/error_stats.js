// v1.7.0+ 异常请求统计
// 记录最近的错误（最多 100 条）和分类计数
// 用于：诊断 + 简单的监控面板

const MAX_ERRORS = 100;

const errors = [];          // 最近错误环形缓冲
const counters = {          // 按 status code 计数
  '4xx': 0,
  '5xx': 0,
  'unhandled': 0,
  'auth_fail': 0
};

function record(err, req, res) {
  const entry = {
    ts: new Date().toISOString(),
    method: req ? req.method : '-',
    path: req ? req.originalUrl : '-',
    status: res ? res.statusCode : 500,
    error: err && err.message ? err.message : String(err),
    stack: err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : ''
  };
  errors.push(entry);
  if (errors.length > MAX_ERRORS) errors.shift();

  const code = entry.status;
  if (code >= 500) counters['5xx']++;
  else if (code >= 400) counters['4xx']++;
  else counters['unhandled']++;
}

function recordAuthFail(path) {
  counters['auth_fail']++;
  errors.push({
    ts: new Date().toISOString(),
    method: '-',
    path: path || '-',
    status: 401,
    error: '鉴权失败（Bearer Token 错误）',
    stack: ''
  });
  if (errors.length > MAX_ERRORS) errors.shift();
}

function getStats() {
  return {
    counters: { ...counters },
    recent: errors.slice(-20).reverse(),  // 最新在前
    total: errors.length
  };
}

function reset() {
  errors.length = 0;
  counters['4xx'] = 0;
  counters['5xx'] = 0;
  counters['unhandled'] = 0;
  counters['auth_fail'] = 0;
}

module.exports = { record, recordAuthFail, getStats, reset };
