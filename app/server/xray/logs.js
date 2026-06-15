// xray 日志模块（v1.6.0+）
// 读取 xray 实时日志 + 手动轮转
// logToInfo 写 info.log 的功能在 utils.js（被 cmd/main + process.js 复用）

const fs = require('fs');
const path = require('path');
const { logToInfo, LOG_FILE } = require('./utils');

// 读取 xray.log 最后 N 行
function getLogs(lines = 50) {
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf-8');
    const all = raw.split('\n');
    return all.slice(-lines).join('\n');
  } catch (_) {
    return '';
  }
}

// 手动轮转日志：把当前 log 改名为 log.1，新建空 log
function rotateLogs() {
  const backup = LOG_FILE + '.1';
  try {
    if (fs.existsSync(LOG_FILE)) {
      try { fs.unlinkSync(backup); } catch (_) {}
      fs.renameSync(LOG_FILE, backup);
    }
    logToInfo('[logs] 日志已轮转');
    return { ok: true, msg: '已轮转' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// v1.10.0+ SSE 实时日志推送
// 监听文件大小变化，新行立即推送给客户端
function tailSSE(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let lastSize = 0;
  let buffer = '';
  // 首次发送历史（最近 50 行）
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf-8');
    const all = raw.split('\n');
    const initial = all.slice(-50).join('\n');
    res.write('data: ' + JSON.stringify({ type: 'history', content: initial }) + '\n\n');
    lastSize = raw.length;
  } catch (_) {
    res.write('data: ' + JSON.stringify({ type: 'history', content: '' }) + '\n\n');
  }

  const interval = setInterval(() => {
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size < lastSize) {
        // 日志被轮转了
        lastSize = 0;
        res.write('data: ' + JSON.stringify({ type: 'rotated' }) + '\n\n');
      }
      if (stat.size > lastSize) {
        const fd = fs.openSync(LOG_FILE, 'r');
        const len = stat.size - lastSize;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, lastSize);
        fs.closeSync(fd);
        const newContent = buf.toString('utf-8');
        lastSize = stat.size;
        res.write('data: ' + JSON.stringify({ type: 'append', content: newContent }) + '\n\n');
      }
    } catch (e) {
      // v1.12.0+ res.write 失败（client 突然断）会抛 ERR_STREAM_DESTROYED → 立即停止
      if (e.code === 'ERR_STREAM_DESTROYED' || e.message?.includes('write after end')) {
        clearInterval(interval);
        return;
      }
    }
  }, 1000);

  // 客户端断开（双重保护）
  const cleanup = () => { clearInterval(interval); };
  req.on('close', cleanup);
  res.on('error', cleanup);  // v1.12.0+ 加这个：捕获 write 失败的另一种触发
  res.on('close', cleanup);
}

module.exports = {
  getLogs,
  rotateLogs,
  tailSSE
};
