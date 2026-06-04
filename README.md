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
- **命令行代理工具 with-proxy**：LD_PRELOAD 注入 `libproxychains4.so` 的进程级代理包裹器
  - **不动系统**：不修改 `LD_LIBRARY_PATH` / `/etc/ld.so.conf` / 任何环境变量，100% 用户态
  - **100% 可回滚**：删除 `bin/` 目录即可完全恢复（无系统级副作用）
  - **用法**：`with-proxy curl https://www.google.com` / `with-proxy ./deploy.sh` / `with-proxy npm install`
  - **详见**下方 [使用说明](#使用说明) 段的 `with-proxy` 章节

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

### 命令行代理

```bash
# 包裹任意命令走代理
with-proxy curl https://www.google.com

# 包裹脚本
with-proxy ./deploy.sh
```
底层用 `LD_PRELOAD` 注入 `libproxychains4.so`，**不修改**系统配置，**不污染** `LD_LIBRARY_PATH` 环境。100% 可回滚。

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
