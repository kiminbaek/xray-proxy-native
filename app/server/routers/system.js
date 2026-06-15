// 系统信息 / 健康检查路由
const express = require('express');
const router = express.Router();
const os = require('os');
const errorStats = require('../error_stats');

router.get('/', (req, res) => {
  res.json({
    ok: true,
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    memory: { total: os.totalmem(), free: os.freemem() },
    nodeVersion: process.version,
    uptime: process.uptime()
  });
});

router.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// v1.7.0+ 异常请求统计
router.get('/errors', (req, res) => {
  res.json({ ok: true, ...errorStats.getStats() });
});

router.post('/errors/reset', (req, res) => {
  errorStats.reset();
  res.json({ ok: true, message: '错误计数已重置' });
});

module.exports = router;
