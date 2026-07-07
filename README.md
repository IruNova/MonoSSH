# MonoSSH

MonoSSH 是一个轻量级桌面 SSH 客户端示例，使用 **Go + Electron + xterm.js** 构建。界面参考 FinalShell 的核心工作流：左侧主机管理、上方多标签终端、下方远程文件管理，同时保持黑白极简现代 UI。

## 功能

- SSH 连接管理：新增、编辑、删除、分组、搜索。
- 认证方式：密码、私钥路径或 PEM 内容、私钥口令。
- 代理连接：每个 SSH 连接可单独配置 `SOCKS5` 或 `HTTP CONNECT` 代理。
- 多标签终端：xterm.js 终端，支持窗口大小同步。
- 远程文件管理：SFTP 列目录、进入目录、上传、下载、创建文件夹、重命名、删除；上传/下载带进度条，文件操作后自动刷新。
- 系统信息面板：通过 SSH 直观展示 CPU 百分比、内存、磁盘、负载、运行时间和 CPU Top 进程。
- 数据本地保存：默认保存到系统用户配置目录下的 `monossh/connections.json`。

> 注意：当前版本为了便于开发使用 `ssh.InsecureIgnoreHostKey()`，生产环境建议改为 known_hosts 校验。

## 目录结构

```text
ssh/
├── cmd/server/          # Go 后端入口，HTTP/WebSocket/SFTP API
├── internal/model/      # 数据模型
├── internal/sshclient/  # SSH、SFTP、SOCKS5/HTTP 代理拨号
├── internal/store/      # 本地连接配置存储
├── renderer/            # Electron 渲染进程 UI
├── main.js              # Electron 主进程，启动 Go 后端
├── preload.js
├── package.json
└── go.mod
```

## 开发运行

环境要求：Go 1.24+、Node.js 20+、npm。

```bash
cd ssh
npm install
npm run dev
```

如果只想运行后端：

```bash
go build -o bin/ssh-backend ./cmd/server
./bin/ssh-backend -addr 127.0.0.1:0
```

## 打包

```bash
cd ssh
npm install
npm run dist

# Windows portable exe，本地 Linux/macOS 交叉打包
npm run dist:win

# Windows runner / PowerShell 环境
npm run dist:win:ps
```

打包配置在 `package.json` 的 `build` 字段中，Go 后端会作为 Electron extraResources 一起分发。

## 连接配置说明

新建连接时可填写：

- 名称、分组、主机、端口、用户名
- 密码，或私钥路径/PEM 内容
- 代理类型：
  - 不使用代理
  - SOCKS5
  - HTTP（使用 CONNECT 隧道）
- 代理主机、端口、用户名、密码

## GitHub Actions

已配置 `.github/workflows/build.yml`：

- Ubuntu runner 执行 Go 测试和 JS 语法检查。
- Windows runner 编译 Go 后端并通过 electron-builder 生成 Windows x64 portable exe。
- 构建产物会上传到 Actions artifacts。

## 已验证

- `go test ./...`
- `go build -o bin/ssh-backend ./cmd/server`
- `node --check main.js preload.js renderer/app.js`
- 后端 `/health` 接口启动检查
