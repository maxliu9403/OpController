# OpController Desktop

OpController Desktop is a local desktop automation platform for internal operations teams. It connects to fingerprint browsers, lets non-technical operators design reusable workflows, runs visual batch jobs with multiple browser windows, schedules local tasks, and stores execution results for review.

The current V1 implementation focuses on a single-machine desktop app with ixBrowser support and an extensible multi-provider architecture.

## What It Does

- Connects to installed fingerprint browsers through local APIs.
- Syncs provider groups, profiles, tags, proxies, and open sessions.
- Lets operators build workflows through action cards and a visual element picker.
- Runs workflows through Playwright over CDP instead of OS-level mouse control.
- Supports CSV/Excel batch input, profile assignment, slot-based concurrency, and window layout.
- Supports local schedules through APScheduler.
- Stores batches, task runs, step runs, screenshots, exports, and logs locally.
- Provides locator recovery strategies for page navigation, DOM updates, duplicate equivalent elements, and selector drift.

## Architecture

```text
OpController
├── desktop/                 Tauri 2 desktop shell and React UI
│   ├── src/                 React, TypeScript, Ant Design pages/components
│   └── src-tauri/           Rust desktop bootstrap and bundling config
├── runtime/                 Python sidecar runtime
│   ├── app/                 FastAPI API, services, models, providers
│   ├── tests/               Runtime unit/integration tests
│   └── packaging/           PyInstaller specs
├── shared/                  Shared workflow schemas and starter templates
├── docs/                    Architecture notes
└── outputs/                 Local generated examples; ignored by Git
```

Runtime flow:

```text
Tauri app starts
  -> bootstraps Python sidecar
  -> health checks http://127.0.0.1:18519/local/v1/health
  -> sidecar connects to ixBrowser local API
  -> React UI calls /local/v1/*
  -> execution service attaches to browser sessions through CDP
```

Core backend patterns:

- `ProviderRegistry` and provider adapters isolate fingerprint browser implementations.
- `IxBrowserProvider` is the first production adapter.
- `WorkflowDefinition` stores YAML DSL plus normalized JSON.
- `ExecutionService` handles workflow preview and real task execution.
- `BatchService` creates `Batch -> BatchRow -> TaskRun -> StepRun`.
- `ScheduleService` turns schedules into real batches.

## Tech Stack

- Desktop: `Tauri 2`, Rust, React, TypeScript, Vite, Ant Design.
- Runtime: Python `>=3.12`, FastAPI, SQLAlchemy, SQLite WAL, APScheduler, Playwright, PyInstaller.
- Browser automation: Playwright over CDP attached to fingerprint browser debug endpoints.
- First provider: ixBrowser Local API, default `http://127.0.0.1:53200`.

## Prerequisites

### Common

- Git
- Node.js 20+ and npm
- Python 3.12+; local development currently also works with Python 3.14
- Rust stable toolchain
- A supported fingerprint browser installed locally
- ixBrowser Local API enabled when using the ixBrowser provider

### macOS

Install common tooling:

```bash
brew install node python@3.12 rust
```

If you use a newer Homebrew Python, create the virtual environment with that interpreter consistently.

### Windows

Install:

- Node.js 20+ from the official installer or `winget`.
- Python 3.12+ with "Add python.exe to PATH".
- Rust through `rustup`.
- Microsoft Visual Studio Build Tools with "Desktop development with C++".
- WebView2 Runtime if it is not already installed.

Recommended Windows shell: PowerShell.

## Fresh Setup

Clone the repository:

```bash
git clone git@github.com:maxliu9403/OpController.git
cd OpController
```

Install frontend dependencies:

```bash
npm install
```

Create and install the Python runtime:

```bash
cd runtime
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
python -m playwright install chromium
cd ..
```

On Windows:

```powershell
cd runtime
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
python -m playwright install chromium
cd ..
```

## Development

Run the Python sidecar:

```bash
cd runtime
source .venv/bin/activate
python -m app.main
```

Run the React UI:

```bash
npm run dev:desktop
```

The development UI talks to:

```text
http://127.0.0.1:18519/local/v1
```

Run the Tauri desktop shell in development mode:

```bash
npm --workspace desktop run tauri:dev
```

The Tauri shell can launch the runtime in three ways:

- Packaged binary under app resources.
- Workspace binary under `runtime/dist/opcontroller-runtime`.
- Development Python launcher under `runtime/.venv`.

## Build

### Build Frontend Only

```bash
npm run build:desktop
```

### Build Python Runtime Sidecar

macOS:

```bash
npm --workspace desktop run build:runtime:mac
```

This runs:

```bash
cd runtime
./.venv/bin/pyinstaller packaging/opcontroller-runtime.spec --noconfirm
```

Expected output:

```text
runtime/dist/opcontroller-runtime/opcontroller-runtime
```

Windows:

```powershell
cd runtime
.\.venv\Scripts\pyinstaller.exe packaging\opcontroller-runtime.spec --noconfirm
```

Expected output:

```text
runtime/dist/opcontroller-runtime/opcontroller-runtime.exe
```

### Build macOS App

```bash
npm --workspace desktop run build:mac
```

Expected outputs:

```text
desktop/src-tauri/target/release/bundle/macos/OpController.app
desktop/src-tauri/target/release/bundle/dmg/OpController_0.1.0_aarch64.dmg
```

For Intel macOS, build on an x64 machine or configure the Rust target and signing pipeline explicitly.

### Build Windows App

Run on Windows:

```powershell
npm install
cd runtime
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
python -m playwright install chromium
cd ..
npm --workspace desktop run build
cd runtime
.\.venv\Scripts\pyinstaller.exe packaging\opcontroller-runtime.spec --noconfirm
cd ..
npm --workspace desktop exec tauri build
```

Expected outputs are under:

```text
desktop/src-tauri/target/release/bundle/
```

The exact installer type depends on the Tauri bundle configuration and Windows toolchain.

## Environment Variables

Runtime settings use the `OPCTRL_` prefix.

| Variable | Default | Description |
| --- | --- | --- |
| `OPCTRL_HOST` | `127.0.0.1` | Local sidecar host. |
| `OPCTRL_PORT` | `18519` | Local sidecar port. |
| `OPCTRL_BASE_DIR` | `~/.opcontroller` in direct runtime mode | Runtime data root. Tauri overrides this to the app local data directory. |
| `OPCTRL_APP_ROOT` | unset | App/resource root used by packaged runtime. |
| `OPCTRL_TIMEZONE` | `Asia/Shanghai` | Scheduler timezone. |
| `OPCTRL_PROVIDER_DEFAULT_TYPE` | `ixbrowser` | Default provider type. |
| `OPCTRL_IXBROWSER_API_BASE` | `http://127.0.0.1:53200` | ixBrowser Local API base URL. |
| `OPCTRL_IXBROWSER_API_TIMEOUT_SEC` | `10` | ixBrowser Local API timeout. |
| `OPCTRL_DEFAULT_SLOT_LIMIT` | `6` | Default visual concurrency slot limit. |
| `OPCTRL_MAX_SLOT_LIMIT` | `10` | Hard slot cap for local visual runs. |
| `OPCTRL_PROVIDER_OPEN_TIMEOUT_SEC` | `60` | Profile open timeout. |
| `OPCTRL_PROVIDER_CLOSE_TIMEOUT_SEC` | `15` | Profile close timeout. |
| `OPCTRL_BROWSER_ATTACH_TIMEOUT_SEC` | `25` | CDP attach timeout. |
| `OPCTRL_WINDOW_LAYOUT_TIMEOUT_SEC` | `6` | Window layout timeout. |

Example:

```bash
OPCTRL_IXBROWSER_API_BASE=http://127.0.0.1:53200 \
OPCTRL_BASE_DIR="$HOME/.opcontroller-dev" \
python -m app.main
```

Frontend development can override the runtime origin:

```bash
VITE_RUNTIME_ORIGIN=http://127.0.0.1:18519 npm run dev:desktop
```

## Local Data

Packaged Tauri app stores runtime data under the app local data directory:

- macOS: `~/Library/Application Support/com.max.opcontroller/runtime`
- Windows: `%LOCALAPPDATA%\com.max.opcontroller\runtime`

Inside that directory:

```text
data/app.db       SQLite database
logs/             sidecar and desktop bootstrap logs
artifacts/        screenshots and workflow artifacts
exports/          batch exports
cache/            runtime cache
```

These files are intentionally ignored by Git.

## ixBrowser Setup

1. Install and sign in to ixBrowser.
2. Enable Local API.
3. Keep the local API running on the configured port, default `53200`.
4. Sync profiles from the Provider page.
5. Configure provider scope if only some groups/profiles should be managed.
6. Open a test profile before using element picking or workflow dry run.

If a profile is already open but ixBrowser does not return a debug endpoint, close the profile in ixBrowser and open it again through OpController.

## Workflow Authoring Notes

The workflow editor stores YAML, but operators normally use action cards.

Important runtime behaviors:

- Clicks are humanized and use Playwright over CDP.
- Same-tab navigation after click is detected and waited for automatically.
- Page readiness can be modeled with `wait` nodes.
- Scroll nodes are segmented and include random pauses.
- If a locator matches duplicate equivalent elements, such as two identical `View Closet` links pointing to the same closet, the executor picks the first visible equivalent target.
- If duplicates point to different business targets, execution still fails with `locator_ambiguous` to avoid unsafe clicks.

## Tests

Run all runtime tests:

```bash
runtime/.venv/bin/python -m pytest runtime/tests -q
```

Compile-check runtime:

```bash
python3 -m compileall runtime/app
```

Build-check frontend:

```bash
npm run build:desktop
```

## Git Hygiene

The repository should include source files, lockfiles, schemas, and documentation.

Do not commit:

- `node_modules`
- Python virtual environments
- PyInstaller `build`/`dist`
- Tauri `target`
- `.app`, `.dmg`, `.msi`, `.exe` installers
- SQLite databases
- screenshots, exports, logs, generated Excel files
- local `.env` files

## Troubleshooting

### Runtime Is Not Ready

Check:

```bash
curl http://127.0.0.1:18519/local/v1/health
```

Then inspect logs:

```text
~/Library/Application Support/com.max.opcontroller/runtime/logs/
```

### Port 18519 Is Occupied

Another runtime may already be running. Quit OpController fully or stop the process using that port.

### ixBrowser Server Busy

ixBrowser Local API may reject parallel requests. Wait a few seconds, reduce concurrency, or restart ixBrowser.

### Missing Debug Endpoint

Close the profile in ixBrowser and reopen it through OpController so the provider returns a CDP endpoint.

### Build App Does Not Include Runtime

Build the runtime first:

```bash
npm --workspace desktop run build:runtime:mac
```

Then run:

```bash
npm --workspace desktop run build:mac
```

## Current Scope

V1 is a local single-machine product. It does not yet provide:

- Distributed multi-node scheduling.
- Provider plugin marketplace.
- Enterprise IM or email notification pipeline.
- System wakeup for missed schedules.

The codebase is intentionally structured so these capabilities can be added behind provider, scheduler, and runtime service boundaries.
