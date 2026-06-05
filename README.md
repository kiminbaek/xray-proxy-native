# xray-proxy-native

> 轻量级 Xray 代理管理面板，为飞牛 fnOS 量身打造。

**⚠️ 本应用是 xray 客户端 GUI，需自备代理节点**（机场订阅链接 / 自建 VPS）。**不含任何免费/出厂节点**。新用户请点首次使用向导，或阅读应用内"使用教程"。

---

## 项目介绍

`xray-proxy-native` 是一个面向飞牛 fnOS 桌面应用平台的 Xray 代理管理面板。它把 Xray-core 的功能封装成一个 Web 控制台，让你在浏览器里完成节点的增删改查、批量测速、自动切换、流量统计、延迟历史追踪等日常操作，无需手动编辑 JSON 配置文件或重启服务。

**本项目不提供任何免费/付费代理节点** —— 它的角色是**客户端 GUI**，你需要自备节点来源（机场订阅链接、自己的 VPS 等）。本项目内置了订阅解析、节点健康检查、智能调度等能力，让节点管理工作流顺畅稳定。

适合人群：已经在用 Xray/V2Ray 链路、但不想每次都 SSH 进 NAS 改 JSON 文件的飞牛用户。

---

## 核心能力

### 🌐 TUN 模式（透明代理）· v1.17.0 重点

让**本机所有进程**的流量自动走 xray，无需配置客户端代理（QQ/浏览器/CLI/容器全部自动走分流）。详见 [TUN 模式章节](#tun-模式透明代理v1170-重点)。

### 协议与加密
- **多协议支持**：VLESS / VMess / Trojan / Shadowsocks
- **现代加密**：VLESS + XHTTP + REALITY
- **内置 xray 26.6.1**

### 节点管理
- **健康检查**：自动 ping 检测 + 失败 3 次自动禁用 + 🟢🟡🔒 健康度
- **批量测速**：并发测速所有节点，颜色编码延迟
- **智能调度**：批量测速 + 自动切换最优（3 次稳定抖动保护 + 30s 最小间隔）
- **7 天延迟历史**：环形 buffer 每节点 2000 条 + Chart.js 折线图

### 流量统计
- **按节点排序 / 入站消费**：gRPC 实时拉取 xray stats API
- **24h 流量图表**
- **实时日志**：SSE 推送（不轮询，秒级响应）

### 体验
- **响应式布局**：手机 / 桌面自适应
- **暗色模式**：3 态切换
- **拖拽排序**：长按 200ms + 触觉反馈（移动端）
- **搜索过滤 / 分组标签 / 批量启停**
- **订阅导入**：自动解析 V2Ray/SS 订阅链接
- **首次使用 3 步向导**

### 安全与运维
- **Token 鉴权**：内置 auth.js，首次启动生成
- **加密压缩导入导出**：AES-256-GCM + PBKDF2-SHA256(100k) + gzip
- **崩溃守护**：进程异常 5s 自动重启
- **命令行代理 with-proxy**：LD_PRELOAD 注入（`apt` / `git` / `curl` / `npm` / `pip` 等），详见 [with-proxy 章节](#命令行代理-with-proxy)
- **登录安全**：5 次失败锁定 5 分钟 + scrypt N=131072

---

## 安装

### 系统要求

- **飞牛 fnOS**（v1.0+）
- **x86_64** 架构
- **root 权限**（fnOS 应用中心自动获取）
- **已装 Node.js 套件**（v18+），本应用运行时检测

### 安装步骤

1. 在 fnOS 应用中心 → 右上角"手动安装" → 选择 `xray-proxy-native.fpk`
2. 等应用中心解包并启动 daemon（首次启动约 30 秒）
3. 打开应用 → 设置首次密码（界面引导）
4. 添加节点（订阅链接 / 单节点 VLESS 链接）
5. 启用 TUN 模式（如需"全局代理"）

### 升级步骤

- 走 fnOS 应用中心 → 找 `xray-proxy-native` → **更新**（in-place）
- ⚠️ **不要**用"卸载→重装"（会丢公网访问配置）

---

## 配置

### 端口

| 用途 | 端口 | 监听 |
|:-----|:-----|:-----|
| Web UI | `2087` | 0.0.0.0（可走公网访问） |
| xray SOCKS5 inbound | `10808` | 127.0.0.1（仅本机） |
| xray HTTP inbound | `10809` | 127.0.0.1（仅本机） |
| xray API | `10085` | 127.0.0.1（仅本机） |

### 鉴权 Token

- 首次启动自动生成，写入 `${TRIM_PKGVAR}/auth.json`
- Token + refresh_token 双 token 设计，1h 自动续期
- 登录失败 5 次锁定 5 分钟（可配置）

### 节点导入

- 订阅链接（V2Ray / SS 格式）
- 单节点 VLESS / VMess / Trojan / SS 链接
- 加密压缩备份文件（v1.13.0+ AES-256-GCM 格式）

### 配置文件位置

- **应用数据**：`/vol3/@appdata/xray-proxy-native/`
- **应用日志**：`/vol3/@appdata/xray-proxy-native/xray.log`
- **TUN 配置**：`/vol3/@appdata/xray-proxy-native/tun.json`
- **网络备份**：`/vol3/@appdata/xray-proxy-native/network_backup.conf`

---

## 使用说明

### 节点管理

- 添加 / 编辑 / 删除节点
- 拖拽排序（长按 200ms）
- 启用 / 禁用节点（手动）
- 健康度显示（🟢 正常 / 🟡 偶尔失败 / 🔒 已禁用）

### 批量测速

- 点击"批量测速"按钮
- 并发测试所有启用节点
- 颜色编码延迟（< 200ms 绿，< 500ms 黄，> 500ms 红）

### 自动切换最优

- 开启"自动选择最优"开关
- 后端定期测速（默认 60s）
- 切换决策：3 次稳定 + 30s 最小间隔（防抖动）
- 切换通过 SIGUSR2 热加载，零停机

### 流量统计

- 按节点排序，显示总上行 / 下行
- 24h 流量图表（Chart.js）
- 实时刷新（gRPC stats API）

### 延迟历史

- 点击节点"历史"按钮
- 显示 7 天延迟折线图
- 环形 buffer 每节点 2000 条

### 加密导入导出

- 导出：明文 / 压缩（gzip） / 加密压缩（PBKDF2-SHA256(100k) + AES-256-GCM）
- 导入：自动检测格式，密码错 5 次锁定

---

## TUN 模式（透明代理）· v1.17.0 重点

### 什么是 TUN 模式？

TUN（Transparent Network）是 Linux 内核的虚拟网卡设备。本应用通过 xray-core 26.6.1 创建 `tun0` 设备 + 自动注入 3 条临时路由，让**本机所有进程**的流量**自动**经过 xray 分流（国内直连 / 国外代理）。

**与 Socks 模式对比**：

| | Socks 模式（默认）| TUN 模式（v1.17.0+）|
|:--|:--|:--|
| 配置客户端 | 每个应用要配 `127.0.0.1:10808` | 无需配（"透明"）|
| 覆盖范围 | 仅配置的应用 | **所有**应用（含 Go/Electron/容器）|
| 路由表 | 不动 | 加 3 条临时路由（可回滚）|
| 适用 | 日常使用 | 容器 / CLI / Go 应用代理 |

### 工作原理

```
[本机任意进程] (QQ/浏览器/CLI/容器)
   ↓
[OS 路由表] default dev tun0 metric 50 (临时路由)
   ↓
[tun0 虚拟网卡] ← gvisor 用户态网络栈
   ↓
[xray inbound tun-in] (透明代理 inbound)
   ↓ 按路由规则
   ↓ 国内域名/IP → direct 出站
   ↓ 国外域名/IP → proxy (vless 节点)
   ↓
[外网节点] → 目标网站
```

**关键点**：
- **临时路由**（`default + 0.0.0.0/1 + 128.0.0.0/1` dev tun0 metric 50）是本应用**自动**注入的，卸载/停用/崩溃时**自动**清理
- **不修改**系统主路由表（只加临时路由）
- **不修改** DNS 配置（保留 `192.168.2.2` 网关 DNS）
- **不修改** iptables 永久规则（只加 xray 自管 XRAY 链，清理时一并删）

### 6 重安全保护

启用 TUN 时，本应用启动 6 重安全网：

| # | 触发时机 | 保护内容 |
|:-:|:---------|:---------|
| ① | **安装时** | 自动备份原始 `default route` + DNS 到 `network_backup.conf` |
| ② | **卸载时** | `cmd/uninstall_callback` 删 tun 设备 + 清临时路由 + 清路由表 + 清 iptables |
| ③ | **升级时** | `cmd/upgrade_callback` 先清旧残留再装新版本（防叠加） |
| ④ | **xray 崩溃时** | 守护进程检测到 + TUN 启用中 → 立即清临时路由 + 通知用户 |
| ⑤ | **UI 强制清理** | TUN 设置区有"🧹 强制清理残留"按钮，不依赖 xray 状态 |
| ⑥ | **手动恢复脚本** | `sudo bash /vol3/@appdata/xray-proxy-native/backup_network.sh` 清理一切 |

**`backup_network.sh` 步骤**（v1.17.0 v9+）：
1. 删 tun 设备（tun0 / tun1）
2. 清 fwmark rule（table 100/101）
3. 清独立路由表（table 100/101）
4. 杀残留 xray 进程
5. **清临时路由**（v9 新增：default + 0.0.0.0/1 + 128.0.0.0/1 dev tun0）
6. 验证网络

### 怎么启用？

1. 打开应用 → 设置弹窗
2. 找"🌐 TUN 模式（透明代理）"区
3. 滑开"启用 TUN"开关
4. 等后端 `restartXray` 完成（约 5 秒）
5. 验证：`ip route show` 应有 `default dev tun0 metric 50`
6. 验证：`curl -4 https://ifconfig.me` 应显示代理出口 IP

### 怎么停用？

1. 设置弹窗 → 关闭"启用 TUN"开关
2. 后端自动清临时路由 + 删 tun 设备（无需重启）
3. 验证：`ip route show` 应无 `tun0` 路由
4. 验证：`curl -4 https://ifconfig.me` 应显示 ISP IP

### ⚠️ 实验性功能风险提示

- TUN 接管**本机全部** TCP/UDP 流量（不只浏览器）
- 路由器 / 网桥 / 容器宿主机等场景**慎用**（可能与现有网络栈冲突）
- 启用前会自动清理可能的旧残留，**不影响**系统主路由表
- 万一断网：停用应用 → 卸载应用 → 还断网执行手动恢复脚本

### 7 个新 API

- `GET/POST /api/tun/config`：读写 TUN 配置（name/MTU/gateway/DNS/autoOutboundsInterface）
- `POST /api/tun/start`：启用 TUN（`restartXray` + 自动加 3 条临时路由）
- `POST /api/tun/stop`：关闭 TUN（自动清 3 条临时路由）
- `GET /api/tun/status`：实际状态（xray 运行 + tun 设备存在 + 启用标志）
- `GET /api/tun/backup`：返回恢复脚本路径 + 手动恢复指南
- `POST /api/tun/cleanup`：强制清理 TUN 残留（不依赖 xray 状态）

---

## 命令行代理 with-proxy

### 为什么需要 with-proxy？

`with-proxy` 通过 `LD_PRELOAD` 注入 `libproxychains4.so`，劫持 `connect()` 系统调用，让被包裹命令的所有 TCP 流量自动走 xray SOCKS5（`127.0.0.1:10808`）。**适用场景**：CLI 工具（apt / git / curl / npm / pip / ssh 等）需要走代理，但应用层无法配 Socks 代理的情况。

> 💡 **TUN 模式（v1.17.0+）可完全替代 with-proxy**——TUN 是"透明代理"，无需手动 `with-proxy` 包裹命令。with-proxy 仍保留作为**不动路由表**的备选方案。

### 支持的命令

| 类别 | 命令 |
|:-----|:-----|
| 下载 | `curl` / `wget` |
| Git | `git` / `svn` |
| 包管理 | `apt` / `apt-get` / `pip` / `npm` / `yarn` / `cargo` |
| 网络 | `ncat` / `socat` / `ssh` / `scp` / `rsync` |
| 下载器 | `qBittorrent(noxvfb)` / `Aria2` |

### 不支持的场景

| 场景 | 原因 |
|:-----|:-----|
| **Docker 守护进程** | Go runtime 忽略 LD_PRELOAD |
| **飞牛官方套件** | 大多 Go 实现 |
| **Chromium / Firefox / Electron** | 浏览器自带网络栈 |
| **UDP 流量** | LD_PRELOAD 只劫持 `connect()` |
| **IPv6 流量** | proxychains-ng v4.x IPv6 支持不完整 |

### 安全机制

- **不动 iptables** / **不动 /etc** / **不动 systemd**
- **不污染 LD_LIBRARY_PATH**（用完即弃）
- **停用本应用 = with-proxy 立即失效**（xray 不跑 → 10808 没人监听）
- **100% 可回滚**（卸载后所有组件一并删除）

### 使用示例

```bash
# 简单包裹
with-proxy curl https://api.ipify.org
with-proxy git clone https://github.com/xxx/yyy.git
with-proxy apt update

# 整个脚本走代理
with-proxy bash deploy.sh

# 其他用户
sudo -u xray_proxy -E with-proxy <cmd>
```

---

## xray 依赖说明

本应用**内置** xray 26.6.1 二进制 + geoip.dat + geosite.dat（fpk 约 20MB）。首次启动时自动从 fpk 解压到 `${TRIM_PKGVAR}/xray-bin/`。

### xray 二进制
- 来源：[XTLS/Xray-core](https://github.com/XTLS/Xray-core) v26.6.1
- 架构：x86_64（fnOS amd64 平台）
- 路径：`/vol3/@appdata/xray-proxy-native/xray-bin/xray`

### geo 数据
- `geoip.dat`：约 19MB（全球 IP 段）
- `geosite.dat`：约 10MB（域名分类）

---

## 项目结构

```
xray-proxy-native/
├── manifest              # fnOS 应用清单（应用介绍、版本、端口）
├── ICON.PNG / ICON_256.PNG
├── cmd/                  # fnOS callback 脚本
│   ├── main              # daemon 主进程
│   ├── install_callback  # 安装时执行（含 backup_network.sh 生成）
│   ├── upgrade_callback  # 升级时执行（先清残留再装）
│   ├── uninstall_callback  # 卸载时执行
│   ├── install_init
│   ├── uninstall_init
│   ├── config_callback
│   └── config_init
├── config/
│   ├── privilege         # fnOS run-as 配置（"run-as": "root"）
│   └── resource
└── app/                  # 打 app.tgz
    ├── server/           # Node.js 后端
    │   ├── server.js
    │   ├── auth.js
    │   ├── routers/      # 17 个路由文件
    │   ├── xray/         # xray 进程管理 + 配置
    │   └── ...
    ├── xray/             # xray 二进制 + geo 数据
    │   ├── xray
    │   ├── geoip.dat
    │   └── geosite.dat
    └── ui/               # 前端（单页 Web）
        ├── index.html    # ~3000 行（含 TUN 设置区）
        ├── lib/          # Chart.js 等本地化 JS
        └── images/
```

---

## 开发

### 本地运行

```bash
cd app
node server.js
# 默认监听 2087
# 数据目录：./data/（自动创建）
```

### 打包 fpk

```bash
# 进入源码工作区
cd xray-v1.17.0-source

# 打 app.tgz（app 内子目录：server xray ui）
tar -czf app.tgz -C app server xray ui

# 打 fpk（顶层 6 个：ICON + manifest + cmd/ + config/ + app.tgz）
tar -czf xray-proxy-native.fpk \
    ICON.PNG ICON_256.PNG manifest cmd/ config/ app.tgz

# 验证
tar -tzf xray-proxy-native.fpk | head
```

---

## 贡献

欢迎 PR！本项目自用为主，优先级：

1. **稳定性**：崩溃恢复 + 网络安全 + 6 重保护
2. **功能性**：节点管理 + 智能调度 + TUN 模式
3. **体验**：UI 响应式 + 暗色模式 + 移动端

不接受的 PR：
- 引入新的依赖（除非必要）
- 改 fnOS 内部行为（如 callback hook 顺序）
- 加广告 / 节点推广 / 任何盈利功能

---

## License

MIT
