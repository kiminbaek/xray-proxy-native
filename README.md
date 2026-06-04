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
- **🎯 核心：命令行代理 with-proxy**：让所有命令行工具（apt / git / curl / npm / pip / ssh / scp 等）走面板代理。**Web UI 跑通 ≠ 命令行能上网**——本应用正是为解决这一痛点而设计。LD_PRELOAD 注入 + 不动系统 + 100% 可回滚。详见下方 [`with-proxy` 章节](#命令行代理-with-proxy本应用核心)

---

## 安装

### 系统要求

- **飞牛 fnOS ≥ 0.9.27**（`x86_64` 平台）
- **依赖应用**：Node.js v22（应用中心自动安装）
- **存储空间**：约 80MB（含 xray 二进制 + geoip/geosite 数据库）

### 安装步骤

1. 打开飞牛 fnOS **应用中心**
2. 右上角点击 **本地安装** 按钮
3. 选择下载的 `.fpk` 安装包（如 `xray-proxy-native.fpk`）
4. 等待安装完成（应用中心会自动安装 Node.js v22 依赖）
5. 桌面点击 **代理管理** 图标启动应用

> 💡 提示：`.fpk` 打包产物请从 [Releases 页面](https://github.com/kiminbaek/xray-proxy-native/releases) 下载，**本仓库只包含源码**。

### 安装 xray 依赖

应用首次启动时会**自动**从以下官方源下载并放置到 `xray/` 目录：

| 文件 | 来源 | 用途 |
|:-----|:-----|:----|
| `xray` | [XTLS/Xray-core](https://github.com/XTLS/Xray-core/releases) | Xray 主程序 |
| `geoip.dat` | [Loyalsoldier/v2ray-rules-dat](https://github.com/Loyalsoldier/v2ray-rules-dat/releases) | IP 数据库 |
| `geosite.dat` | [Loyalsoldier/v2ray-rules-dat](https://github.com/Loyalsoldier/v2ray-rules-dat/releases) | 域名数据库 |

---

## 配置

### 端口

- **Web UI 端口**：`2087`（manifest `service_port`）
- **SOCKS 入站**：`127.0.0.1:10808`
- **HTTP 入站**：`127.0.0.1:10809`
- **xray API**：`127.0.0.1:10085`（仅本机，gRPC）

### 鉴权 Token

首次启动时，应用会在 `/var/apps/xray-proxy-native/cmd/` 生成 `auth.json`：
```json
{ "token": "随机 64 位字符串" }
```
**Token 仅在请求 `X-Auth-Token` Header 时校验**。请勿提交到 Git 仓库。

### 节点导入

3 种方式添加节点：

1. **手动添加**：Web UI → 节点管理 → 添加节点 → 选择协议 + 填参数
2. **订阅导入**：Web UI → 节点管理 → 订阅 URL → 粘贴 V2Ray/SS 订阅链接
3. **加密导入**：Web UI → 备份恢复 → 选择 `.bak` 文件（可选密码解压）

### 配置文件位置

- **应用配置**：`/vol3/@appdata/xray-proxy-native/config.json`
- **xray 配置**：`/vol3/@appdata/xray-proxy-native/xray_config.json`
- **节点历史**：`/vol3/@appdata/xray-proxy-native/node_history.json`
- **Auth Token**：`/var/apps/xray-proxy-native/cmd/auth.json`（**勿提交**）

---

## 使用说明

### 节点管理

- **拖拽排序**：长按节点行 200ms 后拖动（移动端有触觉反馈）
- **批量启停**：勾选多个节点 → 批量启用/禁用
- **搜索过滤**：按名称、tag、地址模糊匹配
- **分组标签**：自定义颜色标签分类管理

### 批量测速

Web UI → 节点管理 → **批量测速** 按钮：
- 并发测速所有节点（默认 TCP ping）
- 颜色编码：`< 200ms` 绿 / `200-500ms` 黄 / `> 500ms` 红
- 测速结果自动写入 `node_history.json`

### 自动切换最优

Web UI → 智能调度 → 开启：
- 每 30s 检测一次（**最小间隔抖动保护**）
- 当最优节点连续 **3 次** 稳定优于当前节点时切换
- 切换走 `reorderNodes` → `SIGUSR2` 热重载 xray，**不**中断连接

### 流量统计

Web UI → 流量统计：
- **总览**：今日上传/下载、按节点排序
- **实时**：gRPC 拉取 xray stats API（`StatsService.QueryStats`）
- **24h 图表**：每小时聚合

### 延迟历史

Web UI → 延迟历史：
- **7 天**滚动窗口
- 每节点环形 buffer 2000 条
- Chart.js 折线图

### 加密导入导出

Web UI → 备份恢复：
- **导出明文**：仅 `config.json`
- **导出压缩**：`?compress=true` → gzip（适合纯备份）
- **导出加密压缩**：`?password=xxx&compress=true` → AES-256-GCM + PBKDF2-SHA256(100k 轮) + gzip
- **导入**：拖入文件 → 选密码（加密文件）→ 自动识别格式

> 💡 加密文件**向后兼容**：v1.12.0 之前的明文/压缩格式仍可导入。

### 命令行代理 with-proxy（本应用核心）

**为什么这是核心？**

xray-proxy-native 在 Web UI 跑通后，只解决了"面板能开"的问题。但 fnOS 上跑的命令行工具（`apt`、`git`、`curl`、`npm`、`pip`、`wget`、`apt-get update` 等）**默认不走面板代理**——它们各自发起 TCP 连接，绕过 xray。

不使用 `with-proxy` 的话：
- Web UI 看着一切正常（面板是好的）
- 但 `curl https://www.google.com` 仍然连接超时
- `apt update` 仍然连不上源
- `git clone https://github.com/xxx` 仍然被墙
- 整个应用对命令行场景**形同虚设**

`with-proxy` 是一个**进程级代理包裹器**：通过 `LD_PRELOAD` 注入 48KB 的 `libproxychains4.so`，**劫持** `connect()` / `getaddrinfo()` 系统调用，让被包裹命令的所有 TCP 流量**自动**走 xray SOCKS5（`127.0.0.1:10808`）。

#### 支持的命令（一切尊重 LD_PRELOAD 的 C/C++ 程序）

| 类别 | 命令 | 典型场景 |
|:-----|:-----|:--------|
| 下载工具 | `curl` / `wget` / `aria2c` / `axel` | 拉取外网文件、镜像 |
| Git/版本控制 | `git` / `svn` / `hg` | clone 仓库、pull 提交 |
| 包管理器 | `apt` / `apt-get` / `pip` / `pip3` / `npm` / `yarn` / `pnpm` / `gem` / `cargo` / `go` | 装外网包 |
| 网络工具 | `ncat` / `netcat` / `socat` / `ssh` / `scp` / `rsync` / `telnet` | 端口测试、远程同步 |
| 下载器 | `qBittorrent`（noxvfb）/ `Aria2` / `Transmission` / `Vuze` | BT/PT 下载 |
| 其他 | 任何用 glibc 的二进制 | 自编译工具、内置命令 |

**使用示例**：

```bash
# 下载工具
with-proxy curl https://api.ipify.org        # 看出口 IP（应显示海外）
with-proxy wget https://github.com/xxx.tar.gz

# Git
with-proxy git clone https://github.com/xxx/yyy.git
with-proxy git pull origin main

# 包管理器
with-proxy apt update && with-proxy apt install xxx
with-proxy pip install --user xxx
with-proxy npm install -g xxx

# 综合：整个脚本都走代理
with-proxy bash deploy.sh
```

#### 不支持的场景（务必了解）

| 场景 | 原因 |
|:-----|:-----|
| **Docker 守护进程** | Docker 用 Go 写，Go runtime 忽略 LD_PRELOAD（用 nsenter + iptables） |
| **飞牛官方应用**（套件中心装的） | 大多 Go 实现，LD_PRELOAD 注入无效 |
| **Chromium / Firefox / Chrome** | 浏览器有自己的网络栈，不走 `connect()` |
| **Electron 应用** | 内部用 Node.js，DNS 走 mDNS / DoH，绕过系统调用 |
| **UDP 流量** | LD_PRELOAD 只劫持 `connect()`，不劫持 `sendto()` |
| **原始 IP 连接** | `connect(2)` 走 IP 而非域名，proxychains 无法识别 |
| **IPv6 流量** | proxychains-ng v4.x 对 IPv6 支持不完整 |

#### 网络与权限要求

- **xray 必须在跑**（装上应用后默认自动启动 xray + 至少 1 个可用节点）
- **SOCKS5 端口**：`127.0.0.1:10808`（仅本机回环，不对外暴露）
- **DNS**：proxychains 默认在**远端**解析（`proxy_dns`），防 DNS 污染
- **用户权限**：
  - `xray_proxy` 用户：直接 `with-proxy <cmd>` 即可
  - 其他用户：`sudo -u xray_proxy -E with-proxy <cmd>`（`-E` 保留环境变量）
- **localnet 排除**：`127.0.0.0/8` / `10.0.0.0/8` / `172.16.0.0/12` / `192.168.0.0/16` 自动不走代理

#### 安全机制（核心承诺）

- **不动 iptables**：不修改系统防火墙规则
- **不动 /etc**：不写系统配置
- **不动 systemd**：不注册服务
- **不污染 LD_LIBRARY_PATH**：用完即弃
- **停用本应用 = with-proxy 立即失效**：xray 不跑 → 10808 没人监听 → 命令直接连接失败（不会"假阳性"误判为成功）
- **100% 可回滚**：卸载本应用后，所有 with-proxy 组件（`bin/with-proxy`、`libproxychains4.so` 等）一并删除，系统回到装之前

#### 原理

```
[被 with-proxy 包裹的命令]
   ↓ LD_PRELOAD=libproxychains4.so
   ↓ 劫持 connect() / getaddrinfo()
   ↓ 把"目标 IP:Port"改成"socks5 127.0.0.1:10808 + 原始目标"
   ↓
[xray SOCKS5 inbound (tag: socks-in)]
   ↓ 按路由规则
   ↓ 国内域名/IP → direct
   ↓ 国外域名/IP → proxy (vless node)
   ↓
[外网节点] → 目标网站
```

#### 常见问题

| 问题 | 原因 + 解决 |
|:-----|:-----------|
| `with-proxy curl https://google.com` 报 `connection refused` | xray 没启动。Web UI 启动 xray 后重试 |
| `with-proxy` 后命令卡住无输出 | xray 节点失效。Web UI 测速换节点 |
| `with-proxy` 不生效，命令直接走外网 | LD_PRELOAD 被 Go runtime 或容器逃逸跳过。Go 应用别用 with-proxy |
| `with-proxy apt update` 仍然超时 | apt 子进程（apt-get / dpkg）也需包裹。脚本统一 `with-proxy bash` 包 |
| 想**全局**注入 LD_PRELOAD | `source /var/apps/xray-proxy-native/bin/enable-proxy.sh`（仅当前 shell 临时生效） |

#### enable-proxy.sh（高级）

如果你想在**当前 shell 会话**临时全局注入 LD_PRELOAD（所有命令都走 xray）：

```bash
source /var/apps/xray-proxy-native/bin/enable-proxy.sh
# 该会话内所有命令自动走 xray
# 关闭 shell 或新开会话自动失效
```

> ⚠️ **警告**：不要 `export LD_PRELOAD=...` 写到 `~/.bashrc` —— 这会导致 xray 卸载后所有命令崩溃。

---

## xray 依赖说明

本仓库**不**包含 xray 二进制和 geo 数据文件（体积约 60MB），需要单独下载：

### xray 二进制

```bash
# 从官方下载（示例：v26.6.1）
wget https://github.com/XTLS/Xray-core/releases/download/v26.6.1/Xray-linux-64.zip
unzip Xray-linux-64.zip
chmod +x xray
```

### geo 数据

```bash
# 从 Loyalsoldier 下载
wget https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat
wget https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat
```

放置到应用目录的 `xray/` 子目录后重启应用即可。

---

## 项目结构

```
xray-proxy-native/
├── server/           # Node.js 后端（Express + gRPC）
│   ├── server.js     # 主入口
│   ├── auth.js       # Token 鉴权中间件
│   ├── xray.js       # xray 进程管理 + 配置生成
│   ├── xray/         # xray 辅助模块（health/history/auto_select/...）
│   ├── routers/      # API 路由
│   ├── middleware/
│   ├── seed.json     # 默认 xray 配置模板
│   └── package.json  # 依赖：express + @grpc/grpc-js
├── ui/               # 前端单页应用
│   ├── index.html    # SPA（无构建步骤，原生 JS）
│   ├── config        # fnOS 启动配置
│   └── images/       # 静态资源
└── bin/              # 辅助工具
    ├── with-proxy    # LD_PRELOAD 包裹脚本
    ├── proxychains4  # proxychains-ng 二进制
    ├── libproxychains4.so
    ├── proxychains.conf
    └── enable-proxy.sh
```

---

## 开发

### 本地运行

```bash
# 1. 安装 Node.js 22 依赖
cd server
npm install

# 2. 启动后端（默认监听 2087）
node server.js

# 3. 浏览器打开
open http://localhost:2087
```

### 打包 fpk

打包流程见 [xray-proxy-native 开发文档](https://github.com/kiminbaek/xray-proxy-native/wiki)（如有）。

---

## 贡献

欢迎 PR 和 Issue！但请注意：

- **不**提交 `auth.json` / `*.fpk` / `app.tgz` / `xray/` 二进制
- **不**提交任何含 token / 节点链接的 `seed.json` 变体
- 新功能请先开 Issue 讨论

---

## License

[MIT](LICENSE) © 2026 kiminbaek & 小米虾
