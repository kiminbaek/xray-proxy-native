// xray 二进制查找模块（v1.6.0+）
// 负责在系统上定位 xray 可执行文件
// 缓存查找结果，避免每次都 execSync('which xray')

const { execSync } = require('child_process');
const { fileExists, logToInfo } = require('./utils');

// xray 搜索路径（v1.12.0+ 清理：只保留通用路径，不带开发环境硬编码）
// 1) TRIM_PKGVAR 透传（cmd/main 在 PKGVAR/xray-bin/ 拷一份）
// 2) 系统常见路径
// 之前 v1.6.0 留了一个开发路径 …/workspaces/001/xray_client/xray，移植性差
const XRAY_PATHS = (() => {
  const list = [];
  if (process.env.TRIM_PKGVAR) {
    list.push(`${process.env.TRIM_PKGVAR}/xray-bin/xray`);
  }
  list.push(
    '/usr/local/bin/xray',
    '/usr/bin/xray',
    '/opt/xray/xray',
    '/var/apps/xray/target/bin/xray'
  );
  return list;
})();

let xrayBinary = null;

// 在系统上查找 xray 二进制
// 优先级：customPath > 缓存 > XRAY_PATHS > which
function findXray(customPath) {
  if (customPath) {
    if (fileExists(customPath)) return customPath;
    return null;
  }
  if (xrayBinary && fileExists(xrayBinary)) return xrayBinary;

  for (const p of XRAY_PATHS) {
    if (fileExists(p)) {
      xrayBinary = p;
      logToInfo(`[binary] xray 找到: ${p}`);
      return p;
    }
  }
  // 最后用 which 兜底
  try {
    const out = execSync('which xray', { encoding: 'utf-8', timeout: 3000 }).trim();
    if (out && fileExists(out)) {
      xrayBinary = out;
      logToInfo(`[binary] xray 通过 which 找到: ${out}`);
      return out;
    }
  } catch (_) {}

  return null;
}

function clearBinaryCache() {
  xrayBinary = null;
}

// v1.12.0+ 删 dead code importFromXrayClient：
//   - 之前 v1.6.0+ 想用它从 fpk 导入 xray 二进制
//   - 但实际 cmd/main 用 cp 手动拷贝，不用这个函数
//   - 默认配置 defaultConfig 也曾调用它想拿种子节点，但 importFromXrayClient 实际返回的是
//     二进制路径字符串，不是节点数组（Array.isArray 永远 false）→ 死代码
//   - 现删除

module.exports = {
  findXray,
  clearBinaryCache,
  XRAY_PATHS
};
