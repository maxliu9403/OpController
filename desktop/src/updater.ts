import { invoke } from "@tauri-apps/api/core";

export type UpdateStatus = {
  current_version: string;
  update_available: boolean;
  version?: string | null;
  date?: string | null;
  body?: string | null;
};

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

export async function installUpdate() {
  try {
    await invoke("updater_install");
  } catch (cause) {
    throw new Error(asMessage(cause, "安装更新失败"));
  }
}
