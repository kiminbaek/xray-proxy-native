// xray-proxy-native 入口服务（v1.6.0+ 重构版）
// v1.15.1 集成 xray 二进制：fpk 内置 xray + geo 数据，无需外网下载
// v1.15.0 账号密码登录：首次设置密码 + Access/Refresh Token 双层鉴权
// 负责：注册路由 + 启动 HTTP 服务 + 优雅退出
// 业务实现拆分到 routers/ 和 xray/ 子模块

const express = require('express');
const path = require('path');
const xray = require('./xray');
const auth = require('./auth');
const errorStats = require('./error_stats');
const xrayConfig = require('./xray/config');
const { logToInfo, closeLogStreams } = require('./xray/utils');

const app = express();
const PORT = parseInt(process.env.PORT) || 2088;

app.use(express.json({ limit: '1mb' }));

// 请求日志（v1.7.0+ 过滤高频轮询路径，避免日志被刷屏）
// 借鉴 QwenPaw 亮点 17（SuppressPathAccessLogFilter 思想）
// v1.12.0+ 补全 v1.10.0 加的 /api/health（30s 轮询）+ /api/traffic/history（30 分钟轮询）
const QUIET_PATHS = new Set([
  '/api/status',             // 5 秒轮询
  '/api/traffic',            // 5 秒轮询
  '/api/logs',               // 10 秒轮询
  '/api/health',             // 30 秒轮询
  '/api/traffic/history'     // 30 分钟轮询
]);
app.use((req, res, next) => {
  if (!QUIET_PATHS.has(req.path)) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] ${req.method} ${req.url}`);
  }
  next();
});

// ====== 鉴权中间件：保护 /api/* ======
app.use('/api', auth.authMiddleware);
// 鉴权路由（无需 token）单独挂载，不走 authMiddleware
app.use('/api/auth', require('./routers/auth'));

// ====== 业务路由 ======
app.use('/api/status', require('./routers/status'));
app.use('/api/config', require('./routers/config'));
app.use('/api/nodes', require('./routers/nodes'));
app.use('/api', require('./routers/lifecycle'));        // /api/start, /api/stop, /api/restart
app.use('/api/auto-restart', require('./routers/auto-restart'));
app.use('/api/traffic', require('./routers/traffic'));
app.use('/api/logs', require('./routers/logs'));
app.use('/api/detect', require('./routers/detect'));
app.use('/api/system', require('./routers/system'));
app.use('/api/backup', require('./routers/backup'));     // v1.9.0+ 配置导入/导出/重置
app.use('/api/health', require('./routers/health'));     // v1.10.0+ 节点健康检查
app.use('/api', require('./routers/history'));           // v1.13.0+ 节点延迟历史 (GET /api/history, /api/nodes/:tag/history)
app.use('/api/auto-select', require('./routers/auto-select'));  // v1.13.0+ 自动选最优
app.use('/api/notify', require('./routers/notify'));            // v1.16.0+ 通知配置/测试/历史
app.use('/api/tun', require('./routers/tun'));                  // v1.17.0+ TUN 模式（透明代理）
app.use('/api/ext', require('./routers/ext'));                  // v1.24.0+ 节点标签 / 订阅 / 配额 / 路由 / Geo

// ====== 静态文件 ======
app.use(express.static(path.join(__dirname, '..', 'ui')));

// ====== 错误处理 ======
app.use((err, req, res, next) => {
  console.error('Unhandled:', err);
  logToInfo(`[error] ${req.method} ${req.originalUrl} - ${err.message || 'Internal Server Error'}`);
  errorStats.record(err, req, res);
  res.status(500).json({ ok: false, error: err.message || 'Internal Server Error' });
});

// 404 也要统计
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    errorStats.record(new Error(`404: ${req.originalUrl}`), req, res);
    return res.status(404).json({ ok: false, error: 'Not Found' });
  }
  next();
});

// ====== 启动 ======
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${new Date().toISOString()}] 代理管理面板已启动: http://0.0.0.0:${PORT}`);
  console.log(`  - TRIM_PKGVAR: ${process.env.TRIM_PKGVAR || '(未设置)'}`);
  console.log(`  - xray: ${xray.findXray() || '❌ 未找到'}`);
  // v1.10.0+ 启动节点健康检查调度
  const health = require('./xray/health');
  health.startScheduler();
});

function cleanupTunForShutdown() {
  try {
    const tunCfg = xrayConfig.getTunConfig();
    if (tunCfg && tunCfg.enabled) {
      logToInfo(`[tun] server shutdown: cleanup TUN residue (${tunCfg.name})`);
      xrayConfig.applyTunToConfig(false, tunCfg);
      xrayConfig.cleanupTun(tunCfg.name);
    }
  } catch (e) {
    logToInfo('[tun] server shutdown cleanup failed: ' + (e && e.message));
  }
}

// 优雅退出
function shutdown(signal) {
  console.log(`收到 ${signal}，正在清理...`);
  cleanupTunForShutdown();
  xray.cleanup();
  closeLogStreams();
  server.close(() => {
    console.log('HTTP 服务已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// v1.14.0+ 兜底退出：Node.js 文档明确 uncaughtException 后进程状态不可信
// 仅 console.error 不退出 → 内存 corruption 继续服务 → 用户拿到坏数据
// 退出后依赖 cmd/main 守护（暂无，TODO: 后续加心跳） + fnOS install 重启
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  logToInfo('[FATAL] uncaughtException: ' + (err && err.message) + ' — 进程退出');
  cleanupTunForShutdown();
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
  logToInfo('[FATAL] unhandledRejection: ' + (reason && reason.message) + ' — 进程退出');
  cleanupTunForShutdown();
  process.exit(1);
});
