# OpController Desktop

OpController Desktop 是一个面向公司内部运营团队的本地桌面自动化平台。它用于连接指纹浏览器，帮助非技术运营同事通过可视化动作卡片设计运营流程，批量打开多个浏览器窗口并发执行任务，支持本机定时任务，并在本地保存执行结果用于复盘。

当前 V1 版本定位为单机桌面应用，首个完整接入的指纹窗口来源是 ixBrowser，同时代码结构已经按多指纹窗口来源扩展方式设计。

## 核心能力

- 通过本地 API 连接已安装的指纹浏览器。
- 同步指纹窗口分组、Profile、标签、代理和已打开会话。
- 通过动作卡片和页面元素拾取器设计运营流程。
- 使用 Playwright over CDP 执行动作，不依赖系统全局鼠标。
- 支持 CSV/Excel 批量导入、Profile 绑定、槽位并发和窗口布局。
- 使用 APScheduler 支持本机定时任务。
- 本地保存批次、任务、步骤、截图、导出结果和日志。
- 针对页面跳转、DOM 更新、等价重复元素、定位漂移提供运行时恢复策略。

## 项目结构

```text
OpController
├── desktop/                 Tauri 2 桌面壳与 React 前端
│   ├── src/                 React、TypeScript、Ant Design 页面和组件
│   └── src-tauri/           Rust 桌面启动、sidecar 拉起和打包配置
├── runtime/                 Python sidecar 运行时
│   ├── app/                 FastAPI API、服务层、模型、指纹窗口来源适配
│   ├── tests/               runtime 单元测试和集成测试
│   └── packaging/           PyInstaller 打包配置
├── shared/                  共享 workflow schema 和模板
├── docs/                    架构文档
└── outputs/                 本地生成样例，已被 Git 忽略
```

启动链路：

```text
Tauri App 启动
  -> 拉起 Python sidecar
  -> 健康检查 http://127.0.0.1:18519/local/v1/health
  -> sidecar 连接 ixBrowser Local API
  -> React UI 调用 /local/v1/*
  -> 执行器通过 CDP 附着到浏览器会话
```

后端核心模式：

- `ProviderRegistry` 和 Provider Adapter 隔离不同指纹浏览器实现。
- `IxBrowserProvider` 是当前首个生产级 Provider。
- `WorkflowDefinition` 保存 YAML DSL 和规范化 JSON。
- `ExecutionService` 负责流程试运行和真实任务执行。
- `BatchService` 创建 `Batch -> BatchRow -> TaskRun -> StepRun`。
- `ScheduleService` 将定时计划转换为真实 Batch 执行。

## 技术栈

- 桌面端：`Tauri 2`、Rust、React、TypeScript、Vite、Ant Design。
- Runtime：Python `>=3.12`、FastAPI、SQLAlchemy、SQLite WAL、APScheduler、Playwright、PyInstaller。
- 浏览器自动化：Playwright over CDP，附着到指纹浏览器返回的调试端点。
- 首个指纹窗口来源：ixBrowser Local API，默认地址 `http://127.0.0.1:53200`。

## 环境要求

### 通用要求

- Git
- Node.js 20+ 和 npm
- Python 3.12+，当前本地开发也兼容 Python 3.14
- Rust stable toolchain
- 本机已安装支持的指纹浏览器
- 使用 ixBrowser 时，需要启用 ixBrowser Local API

### macOS

安装常用工具：

```bash
brew install node python@3.12 rust
```

如果使用更新版本的 Homebrew Python，也可以，但建议创建虚拟环境和后续构建始终使用同一个 Python 版本。

### Windows

需要安装：

- Node.js 20+，可从官网安装或使用 `winget`。
- Python 3.12+，安装时勾选 "Add python.exe to PATH"。
- Rust，通过 `rustup` 安装。
- Microsoft Visual Studio Build Tools，并安装 "Desktop development with C++"。
- WebView2 Runtime，如果系统尚未安装。

Windows 推荐使用 PowerShell 执行命令。

## 首次安装

克隆仓库：

```bash
git clone git@github.com:maxliu9403/OpController.git
cd OpController
```

安装前端依赖：

```bash
npm install
```

创建并安装 Python runtime：

```bash
cd runtime
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
python -m playwright install chromium
cd ..
```

Windows：

```powershell
cd runtime
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
python -m playwright install chromium
cd ..
```

## 本地开发

启动 Python sidecar：

```bash
cd runtime
source .venv/bin/activate
python -m app.main
```

启动 React UI：

```bash
npm run dev:desktop
```

开发模式 UI 默认访问 runtime：

```text
http://127.0.0.1:18519/local/v1
```

启动 Tauri 桌面壳开发模式：

```bash
npm --workspace desktop run tauri:dev
```

Tauri 壳会按以下优先级查找并启动 runtime：

- App resources 中的已打包 runtime 二进制文件。
- 工作区 `runtime/dist/opcontroller-runtime` 下的 runtime 二进制文件。
- 开发环境 `runtime/.venv` 下的 Python launcher。

## 构建与打包

### 打包命令速查

日常只验证前端构建：

```bash
npm run build:desktop
```

macOS 本机内部测试包，推荐给运营或测试同事使用：

```bash
npm run build:mac:internal
```

macOS 生成应用内更新所需产物：

```bash
npm run build:mac:updater
```

macOS Tauri 默认包，仅用于本机开发验证或作为正式签名公证前的原始产物：

```bash
npm --workspace desktop run build:mac
```

Windows 安装包必须在 Windows 环境或 GitHub Actions 的 Windows runner 中构建：

```powershell
npm run build:win
```

Windows 生成应用内更新所需产物：

```powershell
npm run build:win:updater
```

### 仅构建前端

```bash
npm run build:desktop
```

### 构建 Python Runtime Sidecar

macOS：

```bash
npm --workspace desktop run build:runtime:mac
```

等价于：

```bash
cd runtime
./.venv/bin/pyinstaller packaging/opcontroller-runtime.spec --noconfirm
```

预期输出：

```text
runtime/dist/opcontroller-runtime/opcontroller-runtime
```

Windows：

```powershell
cd runtime
.\.venv\Scripts\pyinstaller.exe packaging\opcontroller-runtime.spec --noconfirm
```

预期输出：

```text
runtime/dist/opcontroller-runtime/opcontroller-runtime.exe
```

### 构建 macOS App

普通 Tauri 构建：

```bash
npm --workspace desktop run build:mac
```

预期输出：

```text
desktop/src-tauri/target/release/bundle/macos/OpController.app
desktop/src-tauri/target/release/bundle/dmg/OpController_0.1.0_aarch64.dmg
```

内部测试分发建议使用下面的命令。它会先执行完整 macOS 构建，再对 `.app` 做 ad-hoc 深度签名，并重新生成一个内部 DMG，避免 Tauri 默认产物在部分 Mac 上出现资源封签不完整导致的“文件已损坏”提示：

```bash
npm run build:mac:internal
```

预期输出：

```text
desktop/src-tauri/target/release/bundle/macos/OpController.app
desktop/src-tauri/target/release/bundle/dmg/OpController_0.1.0_aarch64_internal.dmg
```

当前推荐发送给 MacBook Air M3 或其他 Apple Silicon 测试机的是：

```text
desktop/src-tauri/target/release/bundle/dmg/OpController_0.1.0_aarch64_internal.dmg
```

如果把未公证的内部测试包通过微信、网盘、浏览器下载等方式发送到另一台 Mac，macOS 可能会因为 Gatekeeper 隔离属性提示“文件已损坏”。这通常不是 DMG 真损坏，而是未使用 Apple Developer ID 签名和公证。内部测试机可以在安装后执行：

```bash
xattr -dr com.apple.quarantine /Applications/OpController.app
```

测试机安装步骤建议：

1. 打开 `OpController_0.1.0_aarch64_internal.dmg`。
2. 将 `OpController.app` 拖入 `/Applications`。
3. 如果首次打开提示“文件已损坏”或无法验证开发者，在终端执行：

```bash
xattr -dr com.apple.quarantine /Applications/OpController.app
```

4. 再次从 `/Applications` 打开 `OpController.app`。

如果只是把 `.app` 放在当前机器本地运行，也可以直接打开：

```text
desktop/src-tauri/target/release/bundle/macos/OpController.app
```

正式对外分发需要使用 Apple Developer ID 证书签名、开启 hardened runtime、提交 Apple notarization，并 stapler 到 DMG。内部 ad-hoc 签名包不能替代正式公证包。

如果需要构建 Intel macOS 版本，建议在 x64 Mac 上构建，或额外配置 Rust target、签名和打包链路。

### 构建 Windows App

Windows 包必须在 Windows 环境构建。原因是本项目包含 Python sidecar，PyInstaller 只能为当前操作系统生成可执行文件；在 macOS 上不能直接产出可运行的 Windows runtime。

如果是一台全新的 Windows 电脑，推荐直接使用一键打包脚本。脚本会优先通过 `winget` 安装 Node.js、Python 3.12、Rust、WebView2 Runtime 和 Visual Studio Build Tools，然后自动安装项目依赖并打包：

```powershell
.\scripts\package-windows.cmd
```

建议在“以管理员身份运行”的 PowerShell 或 Windows Terminal 中执行，避免 Visual Studio Build Tools 安装过程被权限拦截。

也可以直接运行 PowerShell 版本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1
```

常用参数：

```powershell
# 清理旧产物后重新完整打包
.\scripts\package-windows.cmd -Clean

# 打包前额外运行 runtime 测试
.\scripts\package-windows.cmd -RunTests

# 已手动安装系统依赖时，跳过 winget 安装检查
.\scripts\package-windows.cmd -SkipPrerequisites

# 网络环境不方便下载 Playwright Chromium 时跳过
.\scripts\package-windows.cmd -SkipPlaywrightInstall
```

脚本日志会写入：

```text
outputs/logs/package-windows-*.log
```

如果 `winget` 不存在，或 Visual Studio Build Tools 安装后当前终端仍无法识别 C++ 工具链，请重启 PowerShell 后重新执行脚本。

手动准备环境的命令如下：

```powershell
npm install
cd runtime
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
python -m playwright install chromium
cd ..
```

环境已准备好之后，也可以只执行项目内构建命令：

```powershell
npm run build:win
```

输出目录：

```text
desktop/src-tauri/target/release/bundle/
```

常见输出包括：

```text
desktop/src-tauri/target/release/bundle/nsis/*.exe
desktop/src-tauri/target/release/bundle/msi/*.msi
```

Windows 日常分发优先使用 `nsis/*.exe` 安装包。该安装包已配置安装前钩子，会在升级安装时自动停止旧版 `OpController` 与 `opcontroller-runtime.exe`，并清理旧的 `runtime-dist` 资源目录，避免 Python runtime 内置 DLL 被占用导致安装失败。

如果旧版本安装包在 Windows 上提示类似下面的错误：

```text
Error opening file for writing:
C:\Users\<用户>\AppData\Local\OpController\runtime-dist\opcontroller-runtime\_internal\MSVCP140.dll
```

说明旧版 runtime 进程仍占用 DLL。可以先关闭 OpController，然后在 PowerShell 执行下面的临时清理命令，再重新运行新版安装包：

```powershell
taskkill /F /T /IM opcontroller-runtime.exe
taskkill /F /T /IM opcontroller-desktop.exe
taskkill /F /T /IM opcontroller.exe
taskkill /F /T /IM OpController.exe
taskkill /F /T /IM "OpController Desktop.exe"
Remove-Item "$env:LOCALAPPDATA\OpController\runtime-dist" -Recurse -Force -ErrorAction SilentlyContinue
```

一键脚本还会把最终安装包汇总复制到：

```text
outputs/windows/
```

### 使用 GitHub Actions 构建 Windows 包

如果不想在 Windows 电脑上安装构建环境，可以使用仓库内置的 GitHub Actions：

1. 将代码提交并推送到 GitHub 仓库。
2. 打开 GitHub 仓库页面，进入 `Actions`。
3. 在左侧选择 `Build Windows`。
4. 点击右侧 `Run workflow`。
5. 保持默认参数，或勾选 `打包前运行 runtime 测试`。
6. 等待 workflow 完成后，进入本次运行详情页。
7. 在页面底部 `Artifacts` 下载 `OpController-windows-x64`。

该 Artifact 内通常包含：

```text
*.exe
*.msi
```

Windows workflow 会显式执行：

```text
tauri build --bundles nsis,msi --verbose
```

如果构建失败，优先查看 `Build Windows desktop bundles` 步骤的 Tauri 日志。如果构建成功但没有上传产物，查看 `Verify Windows artifacts` 步骤；它会扫描 `desktop/src-tauri/target/release/bundle/nsis` 和 `desktop/src-tauri/target/release/bundle/msi`，并在 Job Summary 中列出最近生成的文件，方便定位 Tauri 实际输出到了哪里。

workflow 文件位于：

```text
.github/workflows/windows-build.yml
```

触发规则：

- 手动触发：GitHub 页面 `Actions -> Build Windows -> Run workflow`。
- 自动触发：推送到 `main` 且修改了 `desktop/`、`runtime/`、`shared/` 或 workflow 相关文件。

## 环境变量

Runtime 配置统一使用 `OPCTRL_` 前缀。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPCTRL_HOST` | `127.0.0.1` | 本地 sidecar 监听地址。 |
| `OPCTRL_PORT` | `18519` | 本地 sidecar 端口。 |
| `OPCTRL_API_TOKEN` | 未设置 | 本地 API 访问令牌。桌面壳会自动生成并注入；手动运行 runtime 时可设置它来保护本地接口。 |
| `OPCTRL_BASE_DIR` | 直接运行 runtime 时为 `~/.opcontroller` | runtime 数据根目录。Tauri 打包运行时会覆盖为 App 本地数据目录。 |
| `OPCTRL_APP_ROOT` | 未设置 | 打包 runtime 使用的 App/resource 根目录。 |
| `OPCTRL_TIMEZONE` | `Asia/Shanghai` | 定时任务时区。 |
| `OPCTRL_PROVIDER_DEFAULT_TYPE` | `ixbrowser` | 默认指纹窗口来源类型。 |
| `OPCTRL_IXBROWSER_API_BASE` | `http://127.0.0.1:53200` | ixBrowser Local API 地址。 |
| `OPCTRL_IXBROWSER_API_TIMEOUT_SEC` | `10` | ixBrowser Local API 超时时间。 |
| `OPCTRL_DEFAULT_SLOT_LIMIT` | `6` | 默认可视化并发槽位数。 |
| `OPCTRL_MAX_SLOT_LIMIT` | `10` | 单机可视化运行硬上限。 |
| `OPCTRL_PROVIDER_OPEN_TIMEOUT_SEC` | `60` | Profile 打开超时。 |
| `OPCTRL_PROVIDER_CLOSE_TIMEOUT_SEC` | `15` | Profile 关闭超时。 |
| `OPCTRL_BROWSER_ATTACH_TIMEOUT_SEC` | `25` | CDP 附着超时。 |
| `OPCTRL_WINDOW_LAYOUT_TIMEOUT_SEC` | `6` | 窗口布局超时。 |
| `OPCTRL_WINDOW_LAYOUT_MIN_WIDTH` | `320` | 可视化平铺时单个窗口允许缩放到的最小宽度。 |
| `OPCTRL_WINDOW_LAYOUT_MIN_HEIGHT` | `280` | 可视化平铺时单个窗口允许缩放到的最小高度。 |
| `OPCTRL_WINDOW_LAYOUT_MARGIN_PX` | `10` | 平铺窗口之间和屏幕边缘的间距。 |

示例：

```bash
OPCTRL_IXBROWSER_API_BASE=http://127.0.0.1:53200 \
OPCTRL_BASE_DIR="$HOME/.opcontroller-dev" \
python -m app.main
```

前端开发时可覆盖 runtime 地址：

```bash
VITE_RUNTIME_ORIGIN=http://127.0.0.1:18519 npm run dev:desktop
```

## 本地数据目录

Tauri 打包应用会把 runtime 数据保存到 App 本地数据目录。

- macOS：`~/Library/Application Support/com.max.opcontroller/runtime`
- Windows：`%LOCALAPPDATA%\com.max.opcontroller\runtime`

目录内容：

```text
data/app.db       SQLite 数据库
logs/             sidecar 和桌面启动日志
artifacts/        截图和流程执行产物
exports/          批次导出文件
cache/            runtime 缓存
```

这些文件均不应提交到 Git。

## ixBrowser 配置

1. 安装并登录 ixBrowser。
2. 启用 ixBrowser Local API。
3. 确认 Local API 运行在配置端口，默认 `53200`。
4. 在“指纹窗口”页面同步 Profile。
5. 如果只希望管理部分分组或窗口，在“指纹窗口”页面配置管理范围。
6. 使用页面元素拾取和流程试运行前，需要先打开一个测试指纹窗口。

如果 Profile 已经在 ixBrowser 中打开，但 ixBrowser 没有返回可附着的调试端点，先在 ixBrowser 中关闭该 Profile，再通过 OpController 重新打开。

## 流程编排说明

流程底层保存为 YAML，但运营同事通常不需要直接写 YAML，而是通过动作卡片完成配置。

关键运行时行为：

- 点击、输入、滚动都带拟人化节奏。
- 点击后如果发生同标签页跳转，系统会自动检测 URL 变化并等待页面稳定。
- 页面就绪可通过 `wait` 节点建模。
- 滚动节点采用分段滚动、随机停留和轻微回看。
- 如果定位规则命中多个等价元素，例如两个 `View Closet` 链接都指向同一个卖家橱窗，执行器会选择第一个可见等价元素继续执行。
- 如果多个元素指向不同业务目标，系统仍会返回 `locator_ambiguous`，避免误点。

## 测试

运行 runtime 全量测试：

```bash
runtime/.venv/bin/python -m pytest runtime/tests -q
```

检查 runtime 编译：

```bash
python3 -m compileall runtime/app
```

检查前端构建：

```bash
npm run build:desktop
```

## Git 管理规范

仓库应提交源码、锁文件、schema、模板和文档。

不要提交：

- `node_modules`
- Python 虚拟环境
- PyInstaller `build` / `dist`
- Tauri `target`
- `.app`、`.dmg`、`.msi`、`.exe` 等安装包
- SQLite 数据库
- 截图、导出结果、日志、生成的 Excel 文件
- 本地 `.env` 文件

## 常见问题

### Runtime 尚未就绪

检查健康接口：

```bash
curl http://127.0.0.1:18519/local/v1/health
```

然后查看日志：

```text
~/Library/Application Support/com.max.opcontroller/runtime/logs/
```

如果 macOS 一直停留在“正在启动本地 Runtime”，说明 Tauri 桌面壳已经打开，但内置 Python sidecar 没有完成启动。常见原因包括：

- 直接在 DMG 只读挂载盘里启动 App。
- App 没有拖入 `/Applications`，或仍带有 macOS quarantine 隔离属性。
- `18519` 端口被其他进程占用。
- 内置 runtime 子进程启动后立刻退出。

建议先将 App 拖入 `/Applications`，再执行：

```bash
xattr -dr com.apple.quarantine /Applications/OpController.app
```

重点查看这些日志：

```text
desktop-bootstrap.log
runtime-stdout.log
runtime-stderr.log
```

新版启动页会在超时后直接展示 runtime 地址、日志目录、子进程状态和 `runtime-stderr.log` 尾部，便于定位跨机器启动问题。

### 18519 端口被占用

可能已有 runtime 进程在运行。请完全退出 OpController，或停止占用该端口的进程。

### ixBrowser Server Busy

ixBrowser Local API 可能拒绝并发请求。等待几秒、降低并发槽位，或重启 ixBrowser。

### 缺少 Debug Endpoint

关闭 ixBrowser 中已打开的 Profile，再通过 OpController 打开，让指纹窗口来源返回 CDP 调试端点。

### 打包后的 App 没有包含 Runtime

先构建 runtime：

```bash
npm --workspace desktop run build:runtime:mac
```

再构建 macOS App：

```bash
npm --workspace desktop run build:mac
```

## 当前边界

V1 是本地单机产品，暂不包含：

- 分布式多机器调度。
- 指纹窗口来源插件市场。
- 企业 IM 或邮件通知主链路。
- 系统唤醒后的自动补跑。

当前代码已经按指纹窗口来源、调度器、执行器和 runtime service 边界拆分，后续可以在这些边界后继续扩展。

## 应用内更新

桌面端现在支持：

- 启动后自动检查新版本。
- 在左侧边栏手动点击“检查更新”。
- 发现新版本后下载并安装，完成后自动重启桌面端。

### 接入步骤

应用内更新基于 Tauri updater。更新元数据文件位于：

```text
desktop/src-tauri/update-config.json
```

首次接入时需要填入：

```json
{
  "pubkey": "base64 后的 minisign 公钥",
  "endpoints": [
    "https://你的发布地址/latest.json"
  ],
  "timeoutMs": 30000
}
```

说明：

- `pubkey` 用于校验下载到的更新包签名。Tauri updater 运行时需要填写 base64 后的 minisign 公钥内容，也就是 `tauri.updater.conf.json` 里的 `plugins.updater.pubkey` 格式。
- `endpoints` 指向返回 Tauri updater JSON 的地址，可以是 GitHub Releases 生成的静态 `latest.json`，也可以是公司内部静态文件服务。
- `timeoutMs` 是检查更新和下载更新包的请求超时时间，默认建议不少于 `30000`。
- 当前仓库内已经配置了 GitHub Releases 更新地址；如果需要关闭某个测试包的远程更新，把 `endpoints` 改为空数组即可。

如果检查更新报 `error sending request`，先确认当前网络可以访问 GitHub Release 和跳转后的 Release Asset：

```bash
curl -L -I https://github.com/maxliu9403/OpController/releases/latest/download/latest.json
```

GitHub Release 下载会跳转到 `release-assets.githubusercontent.com`，公司网络或代理也需要放行该域名。如果当前网络必须走代理，可以在启动桌面端前设置：

```bash
OPCTRL_UPDATER_PROXY=http://127.0.0.1:7890 open -a OpController
```

也可以使用标准环境变量 `HTTPS_PROXY` / `HTTP_PROXY`。

如果使用 Clash，优先开启 TUN/增强模式。未开启 TUN 时，桌面端会在直连失败后自动尝试 Clash 常见 HTTP 代理端口：`7890`、`7897`、`7899`、`10809`。如果你的 Clash HTTP 端口不同，使用 `OPCTRL_UPDATER_PROXY` 显式指定即可。

如果手里只有 `~/.tauri/opcontroller.key.pub` 这种原文公钥，可以这样生成配置值：

```bash
base64 < ~/.tauri/opcontroller.key.pub | tr -d '\n'
```

### 生成更新产物

日常开发构建仍使用普通命令：

```bash
npm run build:desktop
```

只有在发布新版本、需要生成 updater 产物时，才使用 updater 专用构建命令：

```bash
npm run build:mac:updater
```

```powershell
npm run build:win:updater
```

这样做的原因是 updater 构建会额外生成签名和更新包；普通开发构建不必依赖完整的更新发布配置。

### 运行时版本校验

桌面壳在复用本地 runtime 进程前，会校验：

- `/local/v1/health` 返回 `status=ok`
- runtime 记录的 `desktop_version` 与当前桌面端版本一致

如果版本不一致，桌面壳不会复用旧 sidecar，而是拉起新版 runtime，避免“桌面端已升级但后台仍是旧版本”的混跑问题。
