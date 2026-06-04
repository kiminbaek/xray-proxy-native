// 节点路由
const express = require('express');
const router = express.Router();
const xray = require('../xray');
const { wrap } = require('./_utils');

// 节点列表（v1.12.1+ 给系统节点加 system:true 标记，前端不依赖硬编码）
const SYSTEM_TAGS = ['proxy', 'direct', 'block', 'api'];
router.get('/', (req, res) => {
  const config = xray.getConfig();
  const nodes = (config.outbounds || []).map(o => ({
    ...o,
    system: SYSTEM_TAGS.includes(o.tag)
  }));
  res.json({ ok: true, nodes });
});

// 添加节点
router.post('/', wrap(async (req, res) => {
  const tag = xray.addNode(req.body);
  res.json({ ok: true, tag });
}));

// 更新节点
router.put('/:tag', wrap(async (req, res) => {
  const node = xray.updateNode(req.params.tag, req.body);
  if (!node) return res.status(404).json({ ok: false, error: '节点不存在' });
  res.json({ ok: true, node });
}));

// 删除节点
router.delete('/:tag', wrap(async (req, res) => {
  const result = xray.deleteNode(req.params.tag);
  // v1.7.4+ 系统节点保护：返回 {ok: false, error}
  if (result && result.ok === false) {
    return res.status(400).json(result);
  }
  if (!result) return res.status(404).json({ ok: false, error: '节点不存在' });
  res.json({ ok: true });
}));

// 启用/禁用节点
router.post('/:tag/toggle', wrap(async (req, res) => {
  const { enabled } = req.body;
  const node = xray.toggleNode(req.params.tag, !!enabled);
  if (!node) return res.status(404).json({ ok: false, error: '节点不存在' });
  res.json({ ok: true, node });
}));

// 测试节点延迟
router.post('/:tag/test', wrap(async (req, res) => {
  const cfg = xray.getConfig();
  const node = (cfg.outbounds || []).find(o => o.tag === req.params.tag);
  if (!node) return res.status(404).json({ ok: false, error: '节点不存在' });
  const result = await xray.testNode(node);
  // v1.13.0+ 手动测速也写历史（环形 buffer 自动去重 <2s）
  if (xray.history) {
    xray.history.recordHistory(req.params.tag, result.ok ? result.ms : null, result.ok);
  }
  res.json(result);
}));

// 重排序
router.post('/reorder', wrap(async (req, res) => {
  const { tags } = req.body;
  if (!Array.isArray(tags)) return res.status(400).json({ ok: false, error: 'tags 必须为数组' });
  xray.reorderNodes(tags);
  res.json({ ok: true });
}));

// 批量测速（v1.13.0+）
// POST /api/nodes/test-all  body: { tags?: string[] }  // 不传 tags = 所有用户节点
// 返回每节点的 {tag, ok, ms, error}，并写入 history
router.post('/test-all', wrap(async (req, res) => {
  const cfg = xray.getConfig();
  let targets = (cfg.outbounds || []).filter(o => !['proxy', 'direct', 'block', 'api'].includes(o.tag));
  if (Array.isArray(req.body && req.body.tags) && req.body.tags.length > 0) {
    const tagSet = new Set(req.body.tags);
    targets = targets.filter(o => tagSet.has(o.tag));
  }
  if (targets.length === 0) return res.json({ ok: true, results: [] });

  // 并发测速（不串行）
  const results = await Promise.all(targets.map(async (node) => {
    const r = await xray.testNode(node);
    if (xray.history) xray.history.recordHistory(node.tag, r.ok ? r.ms : null, r.ok);
    return { tag: node.tag, ...r };
  }));
  // 按延迟升序（失败的排最后）
  results.sort((a, b) => {
    if (a.ok && b.ok) return a.ms - b.ms;
    if (a.ok) return -1;
    if (b.ok) return 1;
    return 0;
  });
  res.json({ ok: true, count: results.length, results });
}));

// 批量操作（v1.10.0+）：action = 'enable' | 'disable' | 'delete' | 'group' | 'test'
// v1.12.1+ 加白名单 + tags 数量上限：避免误传 action 或大数组导致 DoS
// v1.13.0+ 加 'test'（批量测速）
const BATCH_ACTIONS = ['enable', 'disable', 'delete', 'group', 'test'];
const BATCH_MAX_TAGS = 100;
router.post('/batch', wrap(async (req, res) => {
  const { action, tags, group } = req.body || {};
  if (!action || !BATCH_ACTIONS.includes(action)) {
    return res.status(400).json({ ok: false, error: 'action 必须为: ' + BATCH_ACTIONS.join('/') });
  }
  if (!Array.isArray(tags) || tags.length === 0) {
    return res.status(400).json({ ok: false, error: 'tags 必须为非空数组' });
  }
  if (tags.length > BATCH_MAX_TAGS) {
    return res.status(400).json({ ok: false, error: 'tags 数量超过上限 ' + BATCH_MAX_TAGS + '（当前 ' + tags.length + '）' });
  }
  // v1.12.1+ tag 必须是字符串
  for (const t of tags) {
    if (typeof t !== 'string' || !t) {
      return res.status(400).json({ ok: false, error: 'tags 元素必须为非空字符串' });
    }
  }
  const results = [];
  for (const tag of tags) {
    if (action === 'enable') {
      const r = xray.toggleNode(tag, true);
      results.push({ tag, ok: !!r });
    } else if (action === 'disable') {
      const r = xray.toggleNode(tag, false);
      results.push({ tag, ok: !!r });
    } else if (action === 'delete') {
      const r = xray.deleteNode(tag);
      // 系统节点返 { ok: false, error }
      if (r && r.ok === false) results.push({ tag, ok: false, error: r.error });
      else results.push({ tag, ok: !!r });
    } else if (action === 'group') {
      const r = xray.updateNode(tag, { group: group || '' });
      results.push({ tag, ok: !!r });
    }
  }
  const failed = results.filter(r => !r.ok);
  res.json({ ok: failed.length === 0, total: tags.length, success: tags.length - failed.length, failed: failed.length, results });
}));

// 解析分享链接
router.post('/parse-link', wrap(async (req, res) => {
  const { link } = req.body;
  const result = xray.parseShareLink(link);
  if (result && result.error) return res.status(400).json({ ok: false, error: result.error });
  res.json({ ok: true, node: result });
}));

module.exports = router;
