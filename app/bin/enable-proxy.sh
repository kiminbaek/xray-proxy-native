# enable-proxy.sh v1.11.0+
# 在 shell 里 source 这个文件，整个 shell 后续所有命令都走代理
# 用法：
#   source /vol3/@appcenter/xray-proxy-native/bin/enable-proxy.sh
#   # 之后所有命令走代理，退出 shell 或 unset 自动恢复
#
# 取消：
#   unset LD_PRELOAD PROXYCHAINS_QUIET_MODE PROXYCHAINS_CONF_FILE
#   # 或直接关闭 shell
#
# 重要：本脚本不写 /etc/environment、不改 /etc/profile、不动 PAM
#       停用 xray-proxy-native 后，本脚本立即失效（连不上 10808）

# 自动找到 bin 目录（兼容 source 方式）
if [ -z "$_ENABLE_PROXY_DIR" ]; then
    _ENABLE_PROXY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
fi

# 注入代理
export LD_PRELOAD="$_ENABLE_PROXY_DIR/libproxychains4.so:${LD_PRELOAD}"
export PROXYCHAINS_QUIET_MODE=1
export PROXYCHAINS_CONF_FILE="$_ENABLE_PROXY_DIR/proxychains.conf"
export _ENABLE_PROXY_DIR

# 提示
if [ -n "$PS1" ]; then
    echo "[with-proxy] ✅ 已激活，当前 shell 所有命令走 xray 代理"
    echo "[with-proxy]    关闭 shell 或执行 'disable-proxy' 退出"
fi
