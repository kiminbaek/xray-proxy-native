// routers 共用工具

// 包装异步路由：自动捕获异常返回 500
function wrap(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    console.error('API error:', e);
    res.status(500).json({ ok: false, error: e.message });
  });
}

module.exports = { wrap };
