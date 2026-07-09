#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::error::Error as StdError;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

const DEFAULT_RUNTIME_HOST: &str = "127.0.0.1";
const DEFAULT_RUNTIME_PORT: u16 = 18519;
const TOKEN_BYTES: usize = 32;
const TOKEN_FILE_NAME: &str = "runtime.token";
const UPDATER_INSTALL_PROGRESS_EVENT: &str = "updater-install-progress";
const CLASH_HTTP_PROXY_CANDIDATES: [&str; 4] = [
    "http://127.0.0.1:7890",
    "http://127.0.0.1:7897",
    "http://127.0.0.1:7899",
    "http://127.0.0.1:10809",
];
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Clone, Serialize)]
struct RuntimeClientConfig {
    origin: String,
    token: String,
}

#[derive(Clone, Serialize)]
struct RuntimeBootStatus {
    origin: String,
    boot_error: Option<String>,
    child_status: Option<String>,
    log_dir: String,
    desktop_log_tail: String,
    stdout_log_tail: String,
    stderr_log_tail: String,
}

#[derive(Clone, Serialize)]
struct UpdateStatus {
    current_version: String,
    update_available: bool,
    version: Option<String>,
    date: Option<String>,
    body: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInstallProgress {
    phase: String,
    downloaded: u64,
    total: Option<u64>,
    percent: Option<u8>,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateConfig {
    pubkey: String,
    endpoints: Vec<Url>,
    timeout_ms: Option<u64>,
    proxy: Option<Url>,
    no_proxy: Option<bool>,
}

struct RuntimeLaunchPlan {
    program: PathBuf,
    args: Vec<&'static str>,
    current_dir: PathBuf,
    app_root: PathBuf,
    mode: &'static str,
}

struct RuntimeSidecarState {
    child: Mutex<Option<Child>>,
    boot_error: Mutex<Option<String>>,
    client_config: RuntimeClientConfig,
    log_dir: PathBuf,
}

impl RuntimeSidecarState {
    fn new(client_config: RuntimeClientConfig, log_dir: PathBuf) -> Self {
        Self {
            child: Mutex::new(None),
            boot_error: Mutex::new(None),
            client_config,
            log_dir,
        }
    }

    fn set_child(&self, child: Child) {
        if let Ok(mut slot) = self.child.lock() {
            *slot = Some(child);
        }
    }

    fn set_boot_error(&self, error: String) {
        if let Ok(mut slot) = self.boot_error.lock() {
            *slot = Some(error);
        }
    }

    fn boot_error(&self) -> Option<String> {
        self.boot_error
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().cloned())
    }

    fn child_status(&self) -> Option<String> {
        let Ok(mut slot) = self.child.lock() else {
            return Some("无法读取 Runtime 子进程状态".to_string());
        };
        let Some(child) = slot.as_mut() else {
            return Some("Runtime 子进程未启动".to_string());
        };
        match child.try_wait() {
            Ok(Some(status)) => {
                let message = format!("Runtime 子进程已退出：{status}");
                *slot = None;
                Some(message)
            }
            Ok(None) => None,
            Err(error) => Some(format!("无法检查 Runtime 子进程状态：{error}")),
        }
    }

    fn shutdown(&self) {
        if let Ok(mut slot) = self.child.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[tauri::command]
fn runtime_config(state: tauri::State<'_, RuntimeSidecarState>) -> RuntimeClientConfig {
    state.client_config.clone()
}

#[tauri::command]
fn runtime_boot_status(state: tauri::State<'_, RuntimeSidecarState>) -> RuntimeBootStatus {
    RuntimeBootStatus {
        origin: state.client_config.origin.clone(),
        boot_error: state.boot_error(),
        child_status: state.child_status(),
        log_dir: state.log_dir.display().to_string(),
        desktop_log_tail: read_log_tail(&state.log_dir.join("desktop-bootstrap.log")),
        stdout_log_tail: read_log_tail(&state.log_dir.join("runtime-stdout.log")),
        stderr_log_tail: read_log_tail(&state.log_dir.join("runtime-stderr.log")),
    }
}

#[tauri::command]
async fn updater_check(app: AppHandle) -> Result<UpdateStatus, String> {
    let current_version = app.package_info().version.to_string();
    let (_updater, update) = check_update_with_proxy_fallback(&app).await?;
    if let Some(update) = update {
        Ok(UpdateStatus {
            current_version,
            update_available: true,
            version: Some(update.version),
            date: update.date.map(|date| date.to_string()),
            body: update.body,
        })
    } else {
        Ok(UpdateStatus {
            current_version,
            update_available: false,
            version: None,
            date: None,
            body: None,
        })
    }
}

#[tauri::command]
async fn updater_install(app: AppHandle) -> Result<(), String> {
    let (_updater, update) = check_update_with_proxy_fallback(&app).await?;
    let Some(update) = update else {
        return Ok(());
    };

    emit_update_progress(&app, "preparing", 0, None, "准备下载更新包");
    let downloaded = Arc::new(AtomicU64::new(0));
    let total = Arc::new(AtomicU64::new(0));
    let download_app = app.clone();
    let finish_app = app.clone();
    let progress_downloaded = Arc::clone(&downloaded);
    let finish_downloaded = Arc::clone(&downloaded);
    let progress_total = Arc::clone(&total);
    let finish_total = Arc::clone(&total);

    update
        .download_and_install(
            move |chunk_length, content_length| {
                let current = progress_downloaded.fetch_add(chunk_length as u64, Ordering::Relaxed)
                    + chunk_length as u64;
                if let Some(length) = content_length {
                    progress_total.store(length, Ordering::Relaxed);
                }
                let known_total = content_length.or_else(|| atomic_total(&progress_total));
                emit_update_progress(
                    &download_app,
                    "downloading",
                    current,
                    known_total,
                    "正在下载更新包",
                );
            },
            move || {
                emit_update_progress(
                    &finish_app,
                    "installing",
                    finish_downloaded.load(Ordering::Relaxed),
                    atomic_total(&finish_total),
                    "正在安装更新",
                );
            },
        )
        .await
        .map_err(|error| format!("安装更新失败：{}", format_error_chain(&error)))?;

    emit_update_progress(
        &app,
        "restarting",
        downloaded.load(Ordering::Relaxed),
        atomic_total(&total),
        "安装完成，正在重启",
    );
    app.restart();
}

fn atomic_total(total: &AtomicU64) -> Option<u64> {
    match total.load(Ordering::Relaxed) {
        0 => None,
        value => Some(value),
    }
}

fn emit_update_progress(
    app: &AppHandle,
    phase: impl Into<String>,
    downloaded: u64,
    total: Option<u64>,
    message: impl Into<String>,
) {
    let percent = total.filter(|value| *value > 0).map(|value| {
        let percent = ((downloaded.saturating_mul(100) / value).min(100)) as u8;
        if downloaded > 0 {
            percent.max(1)
        } else {
            percent
        }
    });
    let _ = app.emit(
        UPDATER_INSTALL_PROGRESS_EVENT,
        UpdateInstallProgress {
            phase: phase.into(),
            downloaded,
            total,
            percent,
            message: message.into(),
        },
    );
}

fn main() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            runtime_config,
            runtime_boot_status,
            updater_check,
            updater_install
        ])
        .setup(|app| {
            let log_dir = resolve_log_dir(app.handle());
            let runtime_host = configured_runtime_host();
            let runtime_port = configured_runtime_port();
            let runtime_token = resolve_runtime_token(app.handle(), &log_dir);
            let state = RuntimeSidecarState::new(
                RuntimeClientConfig {
                    origin: format!("http://{runtime_host}:{runtime_port}"),
                    token: runtime_token.clone(),
                },
                log_dir.clone(),
            );

            match bootstrap_runtime(
                app.handle(),
                &log_dir,
                &runtime_host,
                runtime_port,
                &runtime_token,
            ) {
                Ok(Some(child)) => state.set_child(child),
                Ok(None) => {}
                Err(error) => {
                    state.set_boot_error(error.clone());
                    append_log(&log_dir, &format!("runtime bootstrap failed: {error}"));
                }
            }

            app.manage(state);
            Ok(())
        })
        .plugin(build_updater_plugin())
        .build(tauri::generate_context!())
        .expect("failed to build OpController desktop shell");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            if let Some(state) = app_handle.try_state::<RuntimeSidecarState>() {
                state.shutdown();
            }
        }
    });
}

fn bootstrap_runtime(
    app: &AppHandle,
    log_dir: &Path,
    runtime_host: &str,
    runtime_port: u16,
    runtime_token: &str,
) -> Result<Option<Child>, String> {
    if runtime_health_ok(
        runtime_host,
        runtime_port,
        runtime_token,
        &app.package_info().version.to_string(),
        Duration::from_millis(350),
    ) {
        append_log(
            log_dir,
            "runtime health check passed, reusing existing process",
        );
        return Ok(None);
    }

    if runtime_port_open(runtime_host, runtime_port) {
        append_log(
            log_dir,
            "runtime port is open but health check failed; waiting for existing process",
        );
        for _ in 0..24 {
            std::thread::sleep(Duration::from_millis(500));
            if runtime_health_ok(
                runtime_host,
                runtime_port,
                runtime_token,
                &app.package_info().version.to_string(),
                Duration::from_millis(500),
            ) {
                append_log(log_dir, "existing runtime became healthy, reusing process");
                return Ok(None);
            }
        }
        return Err(format!(
            "runtime port {runtime_port} is occupied but /local/v1/health is not responding"
        ));
    }

    let launch_plan = resolve_launch_plan(app)?;
    ensure_executable(&launch_plan.program).map_err(|error| {
        format!(
            "failed to set executable permission on {}: {error}",
            launch_plan.program.display()
        )
    })?;

    let stdout_log = open_log_file(log_dir, "runtime-stdout.log")
        .map_err(|error| format!("failed to open runtime stdout log: {error}"))?;
    let stderr_log = open_log_file(log_dir, "runtime-stderr.log")
        .map_err(|error| format!("failed to open runtime stderr log: {error}"))?;

    append_log(
        log_dir,
        &format!(
            "starting runtime via {} ({})",
            launch_plan.program.display(),
            launch_plan.mode
        ),
    );

    let child = Command::new(&launch_plan.program)
        .args(&launch_plan.args)
        .current_dir(&launch_plan.current_dir)
        .env("OPCTRL_APP_ROOT", &launch_plan.app_root)
        .env("OPCTRL_BASE_DIR", app_local_runtime_dir(app))
        .env("OPCTRL_HOST", runtime_host)
        .env("OPCTRL_PORT", runtime_port.to_string())
        .env("OPCTRL_API_TOKEN", runtime_token)
        .env(
            "OPCTRL_DESKTOP_VERSION",
            app.package_info().version.to_string(),
        )
        .env("PYTHONUNBUFFERED", "1")
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log))
        .spawn()
        .map_err(|error| {
            format!(
                "failed to spawn runtime with {}: {error}",
                launch_plan.program.display()
            )
        })?;

    Ok(Some(child))
}

fn resolve_launch_plan(app: &AppHandle) -> Result<RuntimeLaunchPlan, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("failed to resolve resource dir: {error}"))?;
    let runtime_binary_name = runtime_binary_name();

    let packaged_runtime_dir = resource_dir
        .join("runtime-dist")
        .join("opcontroller-runtime");
    let packaged_runtime_binary = packaged_runtime_dir.join(&runtime_binary_name);
    if packaged_runtime_binary.exists() {
        return Ok(RuntimeLaunchPlan {
            program: packaged_runtime_binary,
            args: vec![],
            current_dir: packaged_runtime_dir,
            app_root: resource_dir,
            mode: "packaged-binary",
        });
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir
        .join("../..")
        .canonicalize()
        .map_err(|error| {
            format!(
                "packaged runtime not found at {}; failed to resolve workspace root for dev fallback: {error}",
                packaged_runtime_binary.display()
            )
        })?;

    let dev_runtime_dir = workspace_root
        .join("runtime")
        .join("dist")
        .join("opcontroller-runtime");
    let dev_runtime_binary = dev_runtime_dir.join(&runtime_binary_name);
    if dev_runtime_binary.exists() {
        return Ok(RuntimeLaunchPlan {
            program: dev_runtime_binary,
            args: vec![],
            current_dir: dev_runtime_dir,
            app_root: workspace_root.clone(),
            mode: "workspace-binary",
        });
    }

    let dev_python = workspace_root
        .join("runtime")
        .join(".venv")
        .join("bin")
        .join("python");
    if dev_python.exists() {
        return Ok(RuntimeLaunchPlan {
            program: dev_python,
            args: vec!["-m", "app.main"],
            current_dir: workspace_root.join("runtime"),
            app_root: workspace_root,
            mode: "workspace-python",
        });
    }

    Err("no usable runtime binary or workspace Python launcher was found".to_string())
}

fn resolve_log_dir(app: &AppHandle) -> PathBuf {
    let base_dir = app_local_runtime_dir(app);
    let log_dir = base_dir.join("logs");
    let _ = fs::create_dir_all(&log_dir);
    log_dir
}

fn app_local_runtime_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("runtime")
}

fn configured_runtime_host() -> String {
    std::env::var("OPCTRL_HOST").unwrap_or_else(|_| DEFAULT_RUNTIME_HOST.to_string())
}

fn configured_runtime_port() -> u16 {
    std::env::var("OPCTRL_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_RUNTIME_PORT)
}

fn resolve_runtime_token(app: &AppHandle, log_dir: &Path) -> String {
    let token_path = app_local_runtime_dir(app).join(TOKEN_FILE_NAME);
    if let Ok(raw) = fs::read_to_string(&token_path) {
        let token = raw.trim();
        if !token.is_empty() {
            return token.to_string();
        }
    }

    let token = generate_runtime_token();
    if let Some(parent) = token_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(error) = fs::write(&token_path, &token) {
        append_log(
            log_dir,
            &format!("failed to persist runtime token, using an ephemeral token: {error}"),
        );
    }
    token
}

fn generate_runtime_token() -> String {
    let mut bytes = [0_u8; TOKEN_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn runtime_port_open(runtime_host: &str, runtime_port: u16) -> bool {
    let address: SocketAddr = format!("{runtime_host}:{runtime_port}")
        .parse()
        .expect("runtime host and port should always parse");
    TcpStream::connect_timeout(&address, Duration::from_millis(350)).is_ok()
}

fn runtime_health_ok(
    runtime_host: &str,
    runtime_port: u16,
    runtime_token: &str,
    desktop_version: &str,
    timeout: Duration,
) -> bool {
    let address: SocketAddr = format!("{runtime_host}:{runtime_port}")
        .parse()
        .expect("runtime host and port should always parse");
    let Ok(mut stream) = TcpStream::connect_timeout(&address, timeout) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let request = format!(
        "GET /local/v1/health HTTP/1.1\r\nHost: {runtime_host}:{runtime_port}\r\nX-OpController-Token: {runtime_token}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    response.starts_with("HTTP/1.1 200")
        && response.contains("\"status\":\"ok\"")
        && response.contains(&format!("\"desktop_version\":\"{desktop_version}\""))
}

fn build_updater_plugin<R: tauri::Runtime>(
) -> tauri::plugin::TauriPlugin<R, tauri_plugin_updater::Config> {
    tauri_plugin_updater::Builder::new().build()
}

fn build_runtime_updater_with_proxy(
    app: &AppHandle,
    config: &UpdateConfig,
    proxy: Option<Url>,
) -> Result<tauri_plugin_updater::Updater, String> {
    let mut builder = app.updater_builder();
    let pubkey = normalize_updater_pubkey(&config.pubkey);
    if !pubkey.trim().is_empty() {
        builder = builder.pubkey(pubkey);
    }
    if let Some(timeout_ms) = config.timeout_ms {
        builder = builder.timeout(Duration::from_millis(timeout_ms));
    }
    if config.no_proxy.unwrap_or(false) {
        builder = builder.no_proxy();
    } else if let Some(proxy) = proxy {
        builder = builder.proxy(proxy);
    }
    let builder = builder
        .endpoints(config.endpoints.clone())
        .map_err(|error| format!("更新配置无效：{error}"))?;
    builder
        .build()
        .map_err(|error| format!("初始化更新器失败：{error}"))
}

async fn check_update_with_proxy_fallback(
    app: &AppHandle,
) -> Result<(tauri_plugin_updater::Updater, Option<Update>), String> {
    let config = read_update_config(app);
    let explicit_proxy = resolve_updater_proxy(config.proxy.clone());
    let updater = build_runtime_updater_with_proxy(app, &config, explicit_proxy.clone())?;
    match updater.check().await {
        Ok(update) => return Ok((updater, update)),
        Err(error) if explicit_proxy.is_none() && !config.no_proxy.unwrap_or(false) => {
            let direct_error = format_error_chain(&error);
            for proxy in clash_proxy_candidates() {
                let proxied_updater =
                    build_runtime_updater_with_proxy(app, &config, Some(proxy.clone()))?;
                match proxied_updater.check().await {
                    Ok(update) => return Ok((proxied_updater, update)),
                    Err(_) => continue,
                }
            }
            Err(format!(
                "检查更新失败：{direct_error}；已尝试 Clash 常见 HTTP 代理端口但仍未连通"
            ))
        }
        Err(error) => Err(format!("检查更新失败：{}", format_error_chain(&error))),
    }
}

fn read_update_config(app: &AppHandle) -> UpdateConfig {
    let path = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("update-config.json"))
        .filter(|path| path.exists())
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("update-config.json"));
    let raw = fs::read_to_string(path)
        .unwrap_or_else(|_| "{\"pubkey\":\"\",\"endpoints\":[]}".to_string());
    serde_json::from_str(&raw).unwrap_or(UpdateConfig {
        pubkey: String::new(),
        endpoints: Vec::new(),
        timeout_ms: None,
        proxy: None,
        no_proxy: None,
    })
}

fn resolve_updater_proxy(configured_proxy: Option<Url>) -> Option<Url> {
    configured_proxy
        .or_else(resolve_env_updater_proxy)
        .or_else(resolve_system_updater_proxy)
}

fn resolve_env_updater_proxy() -> Option<Url> {
    [
        "OPCTRL_UPDATER_PROXY",
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ]
    .into_iter()
    .find_map(|key| {
        env::var(key)
            .ok()
            .and_then(|value| Url::parse(value.trim()).ok())
    })
}

#[cfg(target_os = "macos")]
fn resolve_system_updater_proxy() -> Option<Url> {
    let output = Command::new("scutil").arg("--proxy").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8(output.stdout).ok()?;
    resolve_macos_scutil_proxy(&raw)
}

#[cfg(target_os = "windows")]
fn resolve_system_updater_proxy() -> Option<Url> {
    let proxy_enable = windows_internet_settings_value("ProxyEnable")?;
    if !windows_proxy_enabled(&proxy_enable) {
        return None;
    }

    let proxy_server = windows_internet_settings_value("ProxyServer")?;
    parse_windows_proxy_server(&proxy_server)
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn resolve_system_updater_proxy() -> Option<Url> {
    None
}

#[cfg(target_os = "macos")]
fn resolve_macos_scutil_proxy(raw: &str) -> Option<Url> {
    scutil_proxy_url(raw, "HTTPS").or_else(|| scutil_proxy_url(raw, "HTTP"))
}

#[cfg(target_os = "macos")]
fn scutil_proxy_url(raw: &str, prefix: &str) -> Option<Url> {
    let enabled = scutil_value(raw, &format!("{prefix}Enable"))?;
    if enabled != "1" {
        return None;
    }

    let host = scutil_value(raw, &format!("{prefix}Proxy"))?;
    let port = scutil_value(raw, &format!("{prefix}Port"))?;
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host
    };
    Url::parse(&format!("http://{host}:{port}")).ok()
}

#[cfg(target_os = "macos")]
fn scutil_value(raw: &str, key: &str) -> Option<String> {
    raw.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.trim() != key {
            return None;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    })
}

#[cfg(target_os = "windows")]
fn windows_internet_settings_value(name: &str) -> Option<String> {
    let mut command = Command::new("reg");
    command
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            name,
        ])
        .creation_flags(CREATE_NO_WINDOW);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    windows_reg_query_value(&raw, name)
}

#[cfg(target_os = "windows")]
fn windows_reg_query_value(raw: &str, name: &str) -> Option<String> {
    raw.lines().find_map(|line| {
        let trimmed = line.trim();
        let mut parts = trimmed.split_whitespace();
        let value_name = parts.next()?;
        if !value_name.eq_ignore_ascii_case(name) {
            return None;
        }
        let _value_type = parts.next()?;
        let value = parts.collect::<Vec<_>>().join(" ");
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    })
}

#[cfg(target_os = "windows")]
fn windows_proxy_enabled(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    value == "1" || value.starts_with("0x") && value.ends_with('1')
}

#[cfg(target_os = "windows")]
fn parse_windows_proxy_server(raw: &str) -> Option<Url> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }

    if raw.contains('=') {
        let mut fallback = None;
        for segment in raw
            .split(';')
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let Some((protocol, proxy)) = segment.split_once('=') else {
                fallback = fallback.or_else(|| normalize_proxy_url(segment));
                continue;
            };

            let protocol = protocol.trim().to_ascii_lowercase();
            let proxy = proxy.trim();
            if protocol == "https" || protocol == "http" {
                return normalize_proxy_url(proxy);
            }

            if protocol != "socks" {
                fallback = fallback.or_else(|| normalize_proxy_url(proxy));
            }
        }
        return fallback;
    }

    normalize_proxy_url(raw)
}

#[cfg(target_os = "windows")]
fn normalize_proxy_url(value: &str) -> Option<Url> {
    let value = value.trim().trim_matches('"').trim_matches('\'');
    if value.is_empty() {
        return None;
    }
    if value.contains("://") {
        Url::parse(value).ok()
    } else {
        Url::parse(&format!("http://{value}")).ok()
    }
}

fn clash_proxy_candidates() -> Vec<Url> {
    CLASH_HTTP_PROXY_CANDIDATES
        .iter()
        .filter_map(|value| Url::parse(value).ok())
        .collect()
}

fn format_error_chain(error: &dyn StdError) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let cause_message = cause.to_string();
        if !cause_message.is_empty() && !message.contains(&cause_message) {
            message.push_str("；原因：");
            message.push_str(&cause_message);
        }
        source = cause.source();
    }
    message
}

fn normalize_updater_pubkey(pubkey: &str) -> String {
    let trimmed = pubkey.trim();
    if trimmed.starts_with("untrusted comment:") {
        BASE64_STANDARD.encode(format!("{trimmed}\n"))
    } else {
        trimmed.to_string()
    }
}

fn open_log_file(log_dir: &Path, file_name: &str) -> std::io::Result<File> {
    fs::create_dir_all(log_dir)?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join(file_name))
}

fn append_log(log_dir: &Path, message: &str) {
    if let Ok(mut file) = open_log_file(log_dir, "desktop-bootstrap.log") {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let _ = writeln!(file, "[{timestamp}] {message}");
    }
}

fn read_log_tail(path: &Path) -> String {
    let Ok(raw) = fs::read_to_string(path) else {
        return String::new();
    };
    let lines: Vec<&str> = raw.lines().rev().take(80).collect();
    lines.into_iter().rev().collect::<Vec<&str>>().join("\n")
}

fn runtime_binary_name() -> String {
    if cfg!(target_os = "windows") {
        "opcontroller-runtime.exe".to_string()
    } else {
        "opcontroller-runtime".to_string()
    }
}

#[cfg(unix)]
fn ensure_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = fs::metadata(path)?;
    let mut permissions = metadata.permissions();
    if permissions.mode() & 0o111 != 0 {
        return Ok(());
    }
    permissions.set_mode(permissions.mode() | 0o755);
    fs::set_permissions(path, permissions)
}

#[cfg(not(unix))]
fn ensure_executable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}
