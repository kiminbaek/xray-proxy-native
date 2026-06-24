// xray 进程管理模块（v1.6.0+）
// 启动、停止、重启、热加载、守护

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const {
  ensureDir,
  logToInfo,
  atomicWriteFile,
  DATA_DIR,
  CONFIG_DIR,
  CONFIG_FILE,
  LOG_FILE,
  PID_FILE
} = require('./utils');
const { findXray, clearBinaryCache } = require('./binary');
const { getConfig, setConfig, isEmptyConfig, validateConfig, getTunConfig, setTunConfig, cleanupTun } = require('./config');
const notify = require('../notify');  // v1.16.0+ 通知模块

// ====== 状态 ======
let xrayProcess = null;
let xrayStartAt = null;   // xray 实际启动时间戳（用于准确 uptime）

// ====== v1.4.0+ 守护进程状态 ======
// autoRestartEnabled: 用户开关（默认开启）
// restartHistory: 滑动窗口 1 小时内的重启时间戳数组
// restartTimer: 当前待执行的重启 setTimeout 句柄（避免重复调度）
// userInitiatedStop: 标记本次 stop 是用户主动（stopXray 触发）还是意外退出
let autoRestartEnabled = true;
let restartHistory = [];
let restartTimer = null;
let userInitiatedStop = false;
// 自动重启相关常量
const AUTO_RESTART_DELAY_MS = 5000;        // 退出后 5 秒重启
const AUTO_RESTART_MAX_PER_HOUR = 3;       // 1 小时最多 3 次
const AUTO_RESTART_WINDOW_MS = 3600000;    // 1 小时窗口

// ====== 进程清理 ======
// 启动前先杀掉可能残留的 xray 进程（端口冲突）
// v1.14.0+ 安全杀残留 + 同步等待进程真退出再返回
// 修 v1.13.0 风险：
//   1) pkill -f 'xray run' pattern 过宽 → 误杀用户 SSH 手动跑的 xray
//   2) SIGTERM 后立即返回 → spawn 新 xray 时端口冲突
// 设计（同步版，startXray 不需改）：
//   1) PID_FILE 优雅 SIGTERM
//   2) pkill -x xray 兜底（精确匹配 comm name，不误杀 SSH 命令）
//   3) 同步轮询 pidof 等所有 xray 退出（最多 3s）
//   4) 还活着 → pkill -KILL -x xray 强杀
function killExistingXray() {
  // Step 1: PID_FILE 优雅 SIGTERM
  try {
    const pidRaw = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const pid = parseInt(pidRaw);
    if (pid > 0) {
      try { process.kill(pid, 'SIGTERM'); } catch (_) {}
    }
  } catch (_) {}

  // Step 2: 按本应用 xray 二进制路径精确杀（避免误杀系统其他 xray）
  const xrayBinPattern = `${DATA_DIR}/xray-bin/xray run`;
  try {
    execSync(`sh -c 'pkill -TERM -f "${xrayBinPattern}" 2>/dev/null; true'`, { timeout: 3000 });
  } catch (_) {}

  // Step 3: 同步轮询等本应用 xray 退出（最多 3s = 15 * 200ms）
  for (let i = 0; i < 15; i++) {
    let stillRunning = false;
    try {
      execSync(`sh -c 'pgrep -f "${xrayBinPattern}" >/dev/null 2>&1'`, { timeout: 1000, stdio: 'pipe' });
      stillRunning = true;  // pgrep exit 0 = 还有本应用 xray
    } catch (_) {
      stillRunning = false;  // pgrep exit 1 = 本应用 xray 全退
    }
    if (!stillRunning) return;
    try { execSync('sleep 0.2', { timeout: 1000 }); } catch (_) {}  // sleep 200ms
  }

  // Step 4: 3s 还没退，SIGKILL 强杀
  try {
    execSync(`sh -c 'pkill -KILL -f "${xrayBinPattern}" 2>/dev/null; true'`, { timeout: 3000 });
  } catch (_) {}
}


// v1.18.0-r2: TUN 默认不自动恢复。
// 真实问题不是 default autoStart，而是旧 config.json 里可能残留 tag=tun-in 的 inbound。
// 应用启动 xray 前，如果 tun.json.autoStart !== true，就移除残留 tun-in，并把 tun.enabled 写回 false。
function disableTunAutoStartIfNeeded(config) {
  let tunCfg = null;
  try { tunCfg = getTunConfig(); } catch (_) { tunCfg = null; }
  if (tunCfg && tunCfg.autoStart === true) return { changed: false, reason: 'autoStart=true' };

  let changed = false;
  if (Array.isArray(config.inbounds)) {
    const before = config.inbounds.length;
    config.inbounds = config.inbounds.filter(inb => inb && inb.tag !== 'tun-in');
    changed = config.inbounds.length !== before;
  }

  try {
    setTunConfig({ ...(tunCfg || {}), enabled: false, autoStart: false });
  } catch (e) {
    logToInfo('[TUN] 写入默认手动状态失败: ' + e.message);
  }

  if (changed) logToInfo('[TUN] autoStart=false，启动前已移除 config.json 残留 tun-in，避免自动恢复 TUN');
  return { changed, reason: 'autoStart=false' };
}

// ====== 启动 ======
function startXray(customBinary) {
  return new Promise((resolve, reject) => {
    if (xrayProcess && xrayProcess.exitCode === null) {
      return resolve({ ok: true, msg: '已在运行中', pid: xrayProcess.pid });
    }

    ensureDir(DATA_DIR);
    ensureDir(CONFIG_DIR);

    let config;
    try { config = getConfig(); } catch (e) {
      return reject(new Error('配置读取失败: ' + e.message));
    }

    // v1.3.0+ 空白配置检测（先于 xray 检测，空配置时给用户最清晰提示）
    if (isEmptyConfig(config)) {
      return reject(new Error('配置为空：请先在 Web 面板添加至少一个代理节点（vless/vmess/trojan/shadowsocks）后再启动 xray'));
    }

    const bin = customBinary || findXray();
    if (!bin) {
      return reject(new Error('未找到 xray 可执行文件，请先在系统上安装 xray'));
    }

    // v1.18.0-r2: TUN 默认手动。校验前清理残留 tun-in，避免上次手动开启后下次自动恢复。
    disableTunAutoStartIfNeeded(config);

    // 启动前校验：proxy 出口必须是真实代理协议
    const errs = validateConfig(config);
    if (errs.length > 0) {
      return reject(new Error('配置无效：' + errs.join('；') + '。请在面板添加代理节点（vless/vmess/trojan/shadowsocks）'));
    }

    // 确保有 log 字段
    if (!config.log) config.log = {};
    if (!config.log.loglevel) config.log.loglevel = 'warning';

    try { setConfig(config); } catch (e) {
      return reject(new Error('配置写入失败: ' + e.message));
    }

    // 启动前先清理可能残留的 xray
    killExistingXray();

    let proc;
    try {
      proc = spawn(bin, ['run', '-config', CONFIG_FILE], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
      });
    } catch (e) {
      return reject(new Error('spawn 失败: ' + e.message));
    }

    xrayProcess = proc;
    xrayStartAt = Date.now();
    let resolved = false;
    let stderrBuf = '';

    proc.stdout.on('data', (d) => {
      try { fs.appendFileSync(LOG_FILE, d); } catch (_) {}
    });
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderrBuf += s;
      try { fs.appendFileSync(LOG_FILE, d); } catch (_) {}
    });

    proc.on('error', (err) => {
      xrayProcess = null;
      if (!resolved) {
        resolved = true;
        reject(new Error('启动失败: ' + err.message));
      }
    });

    proc.on('exit', (code, signal) => {
      xrayProcess = null;
      // v1.4.0+ 守护逻辑：
      // 1) 用户主动 stop → 不重启
      // 2) 启动未成功 (!resolved) → 不重启（避免配错导致疯狂重启）
      // 3) 运行中意外退出 → 调度 5 秒后自动重启（受 1 小时 3 次限频）
      if (userInitiatedStop) {
        userInitiatedStop = false;
        if (!resolved) {
          resolved = true;
          reject(new Error('xray 已被用户停止'));
        }
        try { fs.unlinkSync(PID_FILE); } catch (_) {}
        return;
      }
      if (!resolved) {
        resolved = true;
        // 启动后立即退出 = 启动失败（不触发守护，避免配错时疯狂重启）
        const tail = stderrBuf.split('\n').filter(Boolean).slice(-3).join('\n');
        logToInfo(`[守护] xray 启动后立即退出 (code=${code}, signal=${signal})，跳过自动重启。stderr: ${tail || '(空)'}`);
        reject(new Error(`xray 启动后立即退出 (code=${code}, signal=${signal})\n${tail}`));
        try { fs.unlinkSync(PID_FILE); } catch (_) {}
        // v1.16.0+ 通知：xray 启动失败
        notify.send('xray_crashed', {
          title: 'xray 启动失败',
          message: `code=${code}, signal=${signal}\n${tail || '(无错误输出)'}`
        }).catch(() => {});
        return;
      }
      // 清理可能残留的待执行定时器（不重复调度）
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      // v1.17.0+ TUN 模式崩溃防御：xray 死了 + TUN 启用中 = 立即清理 TUN 残留
      // 防止 xray 死后 tun 设备 + 路由表残留导致断网
      try {
        const tunCfg = getTunConfig();
        if (tunCfg && tunCfg.enabled) {
          logToInfo('[守护] TUN 模式启用中，xray 意外退出 → 立即清理 TUN 残留防断网');
          const cleanupResult = cleanupTun(tunCfg.name);
          logToInfo(`[守护] TUN 清理完成: ok=${cleanupResult.ok}`);
          // v1.17.0 v9+ 修 M50：清临**时**路**由**（**tun.js start 端点加的 default dev tun0 metric 50 等 3 条）
          // 防止 tun 设备删除后临**时**路**由**还**指**向**不**存**在**的** tun0 = 断**网**
          try {
            const { execSync } = require('child_process');
            const delCmds = [
              `ip route del default dev ${tunCfg.name} metric 50`,
              `ip route del 0.0.0.0/1 dev ${tunCfg.name} metric 50`,
              `ip route del 128.0.0.0/1 dev ${tunCfg.name} metric 50`
            ];
            for (const cmd of delCmds) {
              try { execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) {}
            }
            logToInfo(`[守护] 临**时**路**由**已清**理**（避**免**断**网**）`);
          } catch (e) {
            logToInfo(`[守护] 临**时**路**由**清**理**失**败**: ${e.message}`);
          }
          // 通知用户 TUN 已自动清理（避免断网）
          notify.send('xray_tun_crashed', {
            title: 'TUN 模式自动清理',
            message: 'xray 意外退出，已自动清理 TUN 设备 + 路由表 + iptables + 临时路由。\n5 秒后守护会重启 xray，可重新启用 TUN。\n如仍断网：sudo bash ${DATA_DIR}/backup_network.sh'
          }).catch(() => {});
        }
      } catch (e) {
        logToInfo(`[守护] TUN 清理失败: ${e.message}`);
      }
      // 调度自动重启
      scheduleAutoRestart(code, signal);
      // v1.16.0+ 通知：xray 意外退出（守护会重启）
      notify.send('xray_crashed', {
        title: 'xray 意外退出',
        message: `code=${code}, signal=${signal}\n将在 ${AUTO_RESTART_DELAY_MS / 1000} 秒后自动重启`
      }).catch(() => {});
      // 清理 PID 文件
      try { fs.unlinkSync(PID_FILE); } catch (_) {}
    });

    // 写入 xray PID 文件
    try {
      atomicWriteFile(PID_FILE, String(proc.pid));
    } catch (_) {}

    // 验证 xray 真的起来了：检查进程存活
    setTimeout(() => {
      if (resolved) return;
      try {
        process.kill(proc.pid, 0);
        // 进程还活着，启动成功
        resolved = true;
        resolve({ ok: true, pid: proc.pid, binary: bin });
      } catch (_) {
        // 进程已死，等 exit 事件处理
        if (!resolved) {
          resolved = true;
          const tail = stderrBuf.split('\n').filter(Boolean).slice(-3).join('\n');
          reject(new Error(`xray 启动失败（已退出）\n${tail || '(无错误输出)'}`));
        }
      }
    }, 1000);
  });
}

// ====== 停止 ======
function stopXray() {
  return new Promise((resolve) => {
    if (!xrayProcess || xrayProcess.exitCode !== null) {
      xrayProcess = null;
      xrayStartAt = null;
      return resolve({ ok: true, msg: '未在运行' });
    }

    // v1.4.0+ 标记：本次 stop 是用户主动，exit 事件不应触发自动重启
    userInitiatedStop = true;
    // 取消任何待执行的重启定时器
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }

    const proc = xrayProcess;
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
    }, 5000);

    proc.on('exit', () => {
      clearTimeout(timer);
      xrayProcess = null;
      xrayStartAt = null;
      try { fs.unlinkSync(PID_FILE); } catch (_) {}
      resolve({ ok: true });
    });

    try { proc.kill('SIGTERM'); } catch (e) {
      clearTimeout(timer);
      xrayProcess = null;
      try { fs.unlinkSync(PID_FILE); } catch (_) {}
      resolve({ ok: true, msg: '已停止（信号发送失败）' });
    }
  });
}

// ====== 重启 ======
async function restartXray() {
  await stopXray();
  return await startXray();
}

// ====== v1.6.0+ 热加载（修 v1.5.1 bug：节点增删改不生效）======
// 用 SIGUSR2 信号让 xray 重新读取配置文件（xray-core 官方支持）
// 失败时回退到 restartXray（保险）
function reloadConfig() {
  if (!xrayProcess || xrayProcess.exitCode !== null) {
    logToInfo('[热加载] xray 未运行，跳过');
    return Promise.resolve({ ok: false, error: 'xray 未运行', method: 'skipped' });
  }
  const pid = xrayProcess.pid;
  try {
    process.kill(pid, 'SIGUSR2');
    logToInfo(`[热加载] 发送 SIGUSR2 给 xray (pid=${pid})`);
    return Promise.resolve({ ok: true, pid, method: 'hot-reload' });
  } catch (e) {
    // 信号失败（xray 旧版本可能不支持），回退到 restart
    logToInfo(`[热加载] SIGUSR2 失败 (${e.message})，回退到 restartXray`);
    return restartXray().then((r) => ({ ...r, method: 'fallback-restart' }));
  }
}

// ====== 状态 ======
function getStatus() {
  let pid = null;
  if (xrayProcess && xrayProcess.exitCode === null) pid = xrayProcess.pid;
  return {
    running: pid !== null,
    pid,
    uptime: pid && xrayStartAt ? Math.floor((Date.now() - xrayStartAt) / 1000) : 0,
    // v1.7.1+ 暴露 xray 二进制路径给 UI（之前 UI 显示 "未找到"）
    binary: findXray() || null
  };
}

// ====== 守护逻辑 ======
// 调度 5 秒后自动重启（滑动窗口 1 小时最多 3 次）
function scheduleAutoRestart(code, signal) {
  if (!autoRestartEnabled) {
    logToInfo(`[守护] 自动重启已禁用（用户开关关闭），跳过重启 (code=${code}, signal=${signal})`);
    return;
  }
  const now = Date.now();
  // 滑动窗口：清理 1 小时外的记录
  restartHistory = restartHistory.filter(t => t > now - AUTO_RESTART_WINDOW_MS);
  if (restartHistory.length >= AUTO_RESTART_MAX_PER_HOUR) {
    logToInfo(`[守护] 1 小时内已重启 ${restartHistory.length} 次，达到上限 ${AUTO_RESTART_MAX_PER_HOUR}，停止自动重启。请检查配置或网络后手动启动。`);
    // v1.16.0+ 通知：自动重启失败
    notify.send('xray_restart_failed', {
      title: 'xray 自动重启失败',
      message: `1 小时内已重启 ${restartHistory.length} 次（上限 ${AUTO_RESTART_MAX_PER_HOUR}），已停止自动重启。请检查配置或网络后手动启动。`
    }).catch(() => {});
    return;
  }
  restartHistory.push(now);
  logToInfo(`[守护] xray 意外退出 (code=${code}, signal=${signal})，${AUTO_RESTART_DELAY_MS / 1000} 秒后自动重启（1 小时内第 ${restartHistory.length}/${AUTO_RESTART_MAX_PER_HOUR} 次）`);
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    try {
      const r = await startXray();
      if (r && r.ok) {
        logToInfo(`[守护] 自动重启成功，pid=${r.pid}`);
      } else {
        logToInfo(`[守护] 自动重启失败: ${(r && r.msg) || '未知错误'}`);
      }
    } catch (e) {
      logToInfo(`[守护] 自动重启失败: ${e.message}`);
    }
  }, AUTO_RESTART_DELAY_MS);
}

// 获取守护状态（API 用）
function getAutoRestartStatus() {
  const now = Date.now();
  // 清理窗口外记录
  restartHistory = restartHistory.filter(t => t > now - AUTO_RESTART_WINDOW_MS);
  return {
    enabled: autoRestartEnabled,
    recentRestarts: restartHistory.length,
    maxPerHour: AUTO_RESTART_MAX_PER_HOUR,
    delayMs: AUTO_RESTART_DELAY_MS,
    lastRestartAt: restartHistory.length > 0 ? restartHistory[restartHistory.length - 1] : null,
    pendingRestart: restartTimer !== null
  };
}

// 设置守护开关（API 用）
function setAutoRestart(enabled) {
  const prev = autoRestartEnabled;
  autoRestartEnabled = !!enabled;
  if (prev !== autoRestartEnabled) {
    logToInfo(`[守护] 自动重启开关变更: ${prev ? '开启' : '关闭'} -> ${autoRestartEnabled ? '开启' : '关闭'}`);
  }
  // 关闭时取消待执行的重启
  if (!autoRestartEnabled && restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
    logToInfo('[守护] 已取消待执行的重启定时器');
  }
  return { ok: true, enabled: autoRestartEnabled };
}

// 清理资源（被 server.js 在 shutdown 时调用）
function cleanup() {
  if (xrayProcess && xrayProcess.exitCode === null) {
    try { xrayProcess.kill('SIGTERM'); } catch (_) {}
  }
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
}

module.exports = {
  startXray,
  stopXray,
  restartXray,
  reloadConfig,
  killExistingXray,
  getStatus,
  scheduleAutoRestart,
  getAutoRestartStatus,
  setAutoRestart,
  cleanup,
  // 暴露 xrayProcess 给 stats 模块用
  get xrayProcess() { return xrayProcess; }
};
