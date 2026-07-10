import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type UpdateStatus = {
  current_version: string;
  update_available: boolean;
  version?: string | null;
  date?: string | null;
  body?: string | null;
};

export type UpdateInstallPhase = "preparing" | "downloading" | "installing" | "restarting";

export type UpdateInstallProgress = {
  phase: UpdateInstallPhase;
  downloaded: number;
  total?: number | null;
  percent?: number | null;
  message: string;
};

const UPDATE_INSTALL_PROGRESS_EVENT = "updater-install-progress";

function asMessage(cause: unknown, fallback: string) {
  if (cause instanceof Error) {
    return cause.message;
  }
  if (typeof cause === "string" && cause.trim()) {
    return cause;
  }
  return fallback;
}

export async function checkForUpdates() {
  try {
    return await invoke<UpdateStatus>("updater_check");
  } catch (cause) {
    throw new Error(asMessage(cause, "检查更新失败"));
  }
}

export async function installUpdate(onProgress?: (progress: UpdateInstallProgress) => void) {
  let unlisten: (() => void) | undefined;
  try {
    if (onProgress) {
      try {
        unlisten = await listen<UpdateInstallProgress>(UPDATE_INSTALL_PROGRESS_EVENT, (event) => {
          onProgress(event.payload);
        });
      } catch {
        onProgress({
          phase: "preparing",
          downloaded: 0,
          total: null,
          percent: null,
          message: "无法读取详细进度，正在继续安装更新",
        });
      }
    }
    await invoke("updater_install");
  } catch (cause) {
    throw new Error(asMessage(cause, "安装更新失败"));
  } finally {
    unlisten?.();
  }
}
