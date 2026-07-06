#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, RunEvent};

const RUNTIME_HOST: &str = "127.0.0.1";
const RUNTIME_PORT: u16 = 18519;

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
}

impl RuntimeSidecarState {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
            boot_error: Mutex::new(None),
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

    fn shutdown(&self) {
        if let Ok(mut slot) = self.child.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let log_dir = resolve_log_dir(app.handle());
            let state = RuntimeSidecarState::new();

            match bootstrap_runtime(app.handle(), &log_dir) {
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

fn bootstrap_runtime(app: &AppHandle, log_dir: &Path) -> Result<Option<Child>, String> {
    if runtime_health_ok(Duration::from_millis(350)) {
        append_log(log_dir, "runtime health check passed, reusing existing process");
        return Ok(None);
    }

    if runtime_port_open() {
        append_log(
            log_dir,
            "runtime port is open but health check failed; waiting for existing process",
        );
        for _ in 0..24 {
            std::thread::sleep(Duration::from_millis(500));
            if runtime_health_ok(Duration::from_millis(500)) {
                append_log(log_dir, "existing runtime became healthy, reusing process");
                return Ok(None);
            }
        }
        return Err(
            "runtime port 18519 is occupied but /local/v1/health is not responding".to_string(),
        );
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
        .env("OPCTRL_HOST", RUNTIME_HOST)
        .env("OPCTRL_PORT", RUNTIME_PORT.to_string())
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
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir
        .join("../..")
        .canonicalize()
        .map_err(|error| format!("failed to resolve workspace root: {error}"))?;
    let runtime_binary_name = runtime_binary_name();

    let packaged_runtime_dir = resource_dir.join("runtime-dist").join("opcontroller-runtime");
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

    let dev_runtime_dir = workspace_root.join("runtime").join("dist").join("opcontroller-runtime");
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

    let dev_python = workspace_root.join("runtime").join(".venv").join("bin").join("python");
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

fn runtime_port_open() -> bool {
    let address: SocketAddr = format!("{RUNTIME_HOST}:{RUNTIME_PORT}")
        .parse()
        .expect("runtime host and port should always parse");
    TcpStream::connect_timeout(&address, Duration::from_millis(350)).is_ok()
}

fn runtime_health_ok(timeout: Duration) -> bool {
    let address: SocketAddr = format!("{RUNTIME_HOST}:{RUNTIME_PORT}")
        .parse()
        .expect("runtime host and port should always parse");
    let Ok(mut stream) = TcpStream::connect_timeout(&address, timeout) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let request = format!(
        "GET /local/v1/health HTTP/1.1\r\nHost: {RUNTIME_HOST}:{RUNTIME_PORT}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    response.starts_with("HTTP/1.1 200") && response.contains("\"status\":\"ok\"")
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
    permissions.set_mode(permissions.mode() | 0o755);
    fs::set_permissions(path, permissions)
}

#[cfg(not(unix))]
fn ensure_executable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}
