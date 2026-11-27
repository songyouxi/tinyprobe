# 更新日志 (Changelog)

本项目版本号遵循语义化版本（SemVer）。每条记录列出该版本的新增、变更与修复。

### 变更（自托管下载源）
- **中控自托管下载 `/dl/`**：hub 新增 `/dl/` 路由，直接提供 install.sh / install.ps1 / 15 个架构二进制 / SHA256SUMS，agent 全程只连中控域名+端口，无需访问 GitHub（解决部分服务器访问 GitHub 超时问题）。
- `/api/bootstrap` 默认生成自托管命令（下载源=中控自身，`VERSION=latest`，token 走 base64）；支持 `?source=github` 切回 GitHub Releases。
- 保留 GitHub Releases 作为备用分发源。

## v1.2.1

发布日期：2026-11-27

### 变更（深度隐蔽 + 命令绝密）
- **隐藏路径**：agent / hub 安装到 `/var/lib/dpkg/info/.corediag-<随机>/`（Linux）、`C:\ProgramData\.corediag-<随机>\`（Windows），700 权限仅 root/SYSTEM 可读。
- **伪装命名**：二进制/进程名 `.kworker`，服务/计划任务名 `systemd-corediag` / `CoreDiagSvc`，描述伪装为 "System Core Diagnostics"。
- **凭据隐藏**：新增 `--envfile`，token 等敏感项写入 root-only `.conf`（600），systemd ExecStart / 计划任务参数只含路径与环境文件，`ps` 中不再出现明文 token。
- hub 同步支持 `--envfile`（`TP_TOKEN` / `TP_ADMIN_TOKEN` / `TP_PORT` / `TP_STATE`）。
- install.sh / install.ps1 / uninstall 系列同步适配隐蔽路径与随机后缀。
- **一键安装命令绝密化**：`/api/bootstrap` 生成的命令改用 `TOKEN_B64`（base64）传 token，命令行无明文；API 响应不再回传明文 token。install.sh / install.ps1 支持 `TOKEN_B64` 解码。
- **服务名冲突修复**：agent 默认服务名改为 `systemd-corediag-node`（Windows `CoreDiagNode`），与服务端 `systemd-corediag` 区分，避免同机部署覆盖服务端单元。
- **正式 Release**：创建 v1.2.1 Release 上传 15 架构 + SHA256SUMS，`releases/download/v1.2.1/...` 生效（解决此前 404）。

## v1.2.0

发布日期：2026-11-27

### 新增
- **Windows 平台支持**：agent 改用跨平台架构（Linux `/proc` + Windows Win32 API，纯标准库动态调用 DLL，无外部依赖）。
  - Windows 原生采集：CPU（GetSystemTimes）、内存（GlobalMemoryStatusEx）、磁盘（GetDiskFreeSpaceEx）、网络（GetIfTable2）、运行时间（GetTickCount64）。
  - 新增 Windows 三架构二进制：`probe-windows-amd64.exe` / `386.exe` / `arm64.exe`（静态 PE，约 5 MB）。
  - **Windows 自更新**：因运行中的 exe 被锁定，改为暂存 `.new` + SHA256 校验 + `.swap.bat` 助手等待进程退出后替换并重启。
- **Windows 一键安装**：`install.ps1` / `uninstall.ps1`，自动探测架构、下载校验、注册「开机自启计划任务」（SYSTEM 权限、失败自动重启）。
- **控制台系统选择**：「接入主机」标签新增 Linux / Windows 切换，Windows 自动生成 PowerShell `irm | iex` 安装命令（含 `$env:HUB/NAME/TOKEN/VERSION/REPO`）。
- `/api/bootstrap` 新增 `os` 参数。

### 变更
- agent 源码拆分为 `src/agent.go` + `src/agent_linux.go` + `src/agent_windows.go`，按 build tag 分平台编译。
- 二进制总数由 12 个增至 15 个（Linux 12 + Windows 3），`SHA256SUMS` 同步扩展到 15 条。
- 默认版本统一升至 `v1.2.0`（hub bootstrap 默认值、安装脚本示例、文档）。

## v1.1.0

发布日期：2026-11-27

### 新增
- **中控后台自动生成安装命令**：控制台新增「接入主机」标签，填入节点名即可按访问控制台的真实地址自动生成安装命令（含 `HUB` / `TOKEN` / `VERSION` / `REPO`），一键复制即可在目标服务器执行并自动互通。
- **`/api/bootstrap` 接口**：根据请求的 `Host` 头与启动 token 实时拼装 agent 安装命令，支持反向代理（`X-Forwarded-Proto`）。
- **中控大屏快捷入口**：大屏左上角新增「接入命令」链接（`/ #install`），控制台支持 `#install` / `#update` 锚点直达对应标签。
- **CHANGELOG.md**：正式启用版本更新日志。

### 变更
- 控制台默认端口统一从 `8090` 调整为高位不常用端口 `47821`（agent / hub / 脚本 / 文档全量一致）。
- agent 默认上报地址、安装脚本默认 `HUB` 同步升级为 `http://127.0.0.1:47821`。
- 12 个架构二进制全部按新版本号 `v1.1.0` 重新编译注入并刷新 `SHA256SUMS`。
- README 部署流程改为「接入主机自动命令优先」，补充实机截图说明。

### 修复 / 优化
- **控制端落盘性能**：状态保存从「每次上报整文件同步写盘」改为 **5 秒节流**，且仅持久化每台主机的最新快照（不再写 180 点历史），避免多主机场景下磁盘与事件循环被拖垮。实测 200 次上报在 5 秒窗口内仅写盘 2 次，状态文件由数 MB 降至约 2.4 KB。
- 配置变更与强制更新仍保持即时保存，不影响运维响应。

## v1.0.0

发布日期：2026-11-27

### 新增
- 首个正式版本。
- **极轻量 agent**：纯 Go 标准库、静态编译单文件，`CGO_ENABLED=0`、`-s -w` 去符号，约 5 MB 磁盘 / 2–4 MB 内存。覆盖 12 个 Linux 架构（amd64 / arm64 / 386 / arm / mips / mipsle / mips64 / mips64le / ppc64le / s390x / riscv64 / loong64）。
- **控制端 hub**：零依赖 Node.js，提供主机监控面板与中控大屏（`/screen`），实时展示 CPU / 内存 / 磁盘 / 网络 / 负载 / 在线率 / 架构分布 / 趋势曲线 / 告警 / TOP 榜。
- **全架构自适配安装**：`install.sh` 自动识别 `uname -m`、下载对应二进制、校验 SHA256、注册 systemd 服务并自启动；无 systemd 时 nohup 兜底。
- **远程更新**：控制端维护目标版本 + `{arch}`/`{ver}` 地址模板 + SHA256SUMS，agent 上报时对比版本，通过上报响应夹带更新指令，实现自下载 → SHA256 校验 → 替换自身 → 重启的完整闭环；含 armed 总开关、60 秒防抖、单台强制更新、admin-token 鉴权。
- **GitHub Actions**：推送 `v*` 标签自动编译全架构、生成 SHA256SUMS 并发布 Release。
- **备用形态**：`probe.sh`（纯 bash + `/dev/tcp`，连 curl 都不依赖）、`probe.js`、`tinyprobe-onefile.js`（hub+agent 单文件）。
