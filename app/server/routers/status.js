// 状态路由
const express = require('express');
const router = express.Router();
const xray = require('../xray');

// v1.5.0+ starting 状态：用于 UI 显示"启动中"
let startingUp = false;
function setStartingUp(v) { startingUp = !!v; }
function isStartingUp() { return startingUp; }

router.get('/', (req, res) => {
  const s = xray.getStatus();
  s.starting = startingUp;
  s.auto_restart = xray.getAutoRestartStatus();
  res.json(s);
});

module.exports = router;
module.exports.setStartingUp = setStartingUp;
module.exports.isStartingUp = isStartingUp;
