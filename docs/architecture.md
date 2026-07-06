# Architecture Overview

## Principles

- Desktop-first: no external infrastructure required for V1
- Provider-agnostic core with built-in adapters
- Visual operations first, throughput as a future mode
- Workflow authoring optimized for non-technical operators
- Sidecar runtime keeps orchestration, scheduling, and persistence local

## Core Subsystems

### Desktop shell

- Tauri host for native app packaging
- React UI for provider setup, workflow authoring, batch execution, and results
- System tray, notifications, and local file access

### Runtime sidecar

- FastAPI for local HTTP and WebSocket APIs
- SQLAlchemy + SQLite for persistent state
- APScheduler for local schedules
- Provider registry for fingerprint browser integrations
- Workflow engine for validation and task execution
- Batch runner for slot-based orchestration

### Provider layer

- `BrowserProvider` interface defines health checks, profile sync, session control, and window management
- `ProviderCapability` models feature availability and guides product-level degradation
- `IxBrowserProvider` is the first production implementation

### Workflow layer

- YAML-backed workflow definitions
- Wizard-friendly action cards in the desktop UI
- Locator generation and validation primitives
- Dry-run and validation APIs before template promotion

### Result layer

- Batch summaries
- Task timelines
- Artifact index for screenshots, downloads, and exported reports

