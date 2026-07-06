import type {
  BatchDetail,
  BatchSummary,
  InputFileParseResult,
  InputProfileMappingValidation,
  LocatorLivePreview,
  LocatorPickResult,
  ProfileRecord,
  ProviderGroupRecord,
  ProviderInfo,
  ProviderScope,
  ProviderSessionRecord,
  ScheduleRecord,
  StepLivePreviewResult,
  SystemCheckResult,
  TaskRunDetail,
  WorkflowActionCard,
  WorkflowDryRunResult,
  WorkflowFolderRecord,
  WorkflowRecord,
} from "../types";

type RuntimeClientConfig = {
  origin: string;
  token: string;
};

let runtimeOrigin = import.meta.env.VITE_RUNTIME_ORIGIN ?? "http://127.0.0.1:18519";
let runtimeToken = import.meta.env.VITE_RUNTIME_TOKEN ?? "";

function runtimeBaseUrl() {
  return `${runtimeOrigin}/local/v1`;
}

export function configureRuntimeClient(config: Partial<RuntimeClientConfig>) {
  if (config.origin) {
    runtimeOrigin = config.origin.replace(/\/$/, "");
  }
  if (config.token !== undefined) {
    runtimeToken = config.token;
  }
}

export async function initializeRuntimeClient() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const config = await invoke<RuntimeClientConfig>("runtime_config");
    configureRuntimeClient(config);
  } catch {
    // Running under plain Vite/browser dev is still supported through VITE_* fallback values.
  }
}

function normalizeNetworkError(cause: unknown) {
  if (cause instanceof Error && /load failed|failed to fetch/i.test(cause.message)) {
    return "本地 Runtime 尚未就绪，请稍等几秒后重试。";
  }
  return cause instanceof Error ? cause.message : "Unknown error";
}

function isRuntimeStartupError(cause: unknown) {
  return cause instanceof Error && /load failed|failed to fetch/i.test(cause.message);
}

type ValidationResult = {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
  normalized_workflow_json?: Record<string, unknown>;
};

type LocatorValidationResult = {
  valid: boolean;
  warnings: string[];
  uniqueness_score: number;
  stability_score: number;
  locator: Record<string, unknown>;
};

function toQuery(params: Record<string, string | boolean | null | undefined>) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  });
  const value = search.toString();
  return value ? `?${value}` : "";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method?.toUpperCase() ?? "GET";
  const shouldSendJsonHeader = method !== "GET" && method !== "HEAD" && !(init?.body instanceof FormData);
  let response: Response;
  const attempts = method === "GET" || method === "HEAD" ? 6 : 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      response = await fetch(`${runtimeBaseUrl()}${path}`, {
        ...init,
        headers: {
          ...(shouldSendJsonHeader ? { "Content-Type": "application/json" } : {}),
          ...(runtimeToken ? { "X-OpController-Token": runtimeToken } : {}),
          ...init?.headers,
        },
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      return response.json() as Promise<T>;
    } catch (cause) {
      if (!isRuntimeStartupError(cause) || attempt === attempts) {
        throw new Error(normalizeNetworkError(cause));
      }
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    }
  }
  throw new Error("本地 Runtime 尚未就绪，请稍等几秒后重试。");
}

async function requestBlob(path: string, init?: RequestInit): Promise<Blob> {
  const response = await fetch(`${runtimeBaseUrl()}${path}`, {
    ...init,
    headers: {
      ...(runtimeToken ? { "X-OpController-Token": runtimeToken } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.blob();
}

export const api = {
  get baseUrl() {
    return runtimeBaseUrl();
  },
  get token() {
    return runtimeToken;
  },
  monitorStreamUrl: () => {
    const url = new URL(`${runtimeBaseUrl()}/monitor/stream`);
    if (runtimeToken) {
      url.searchParams.set("token", runtimeToken);
    }
    return url.toString().replace("http://", "ws://").replace("https://", "wss://");
  },
  health: () => request<{ status: string }>("/health"),
  systemCheck: () => request<SystemCheckResult>("/system/check"),
  listProviders: () => request<ProviderInfo[]>("/providers"),
  syncProfiles: (providerType: string) =>
    request(`/providers/${providerType}/profiles/sync`, { method: "POST" }),
  listProviderSessions: (providerType: string) =>
    request<ProviderSessionRecord[]>(`/providers/${providerType}/sessions`),
  listProviderGroups: (providerType: string) =>
    request<ProviderGroupRecord[]>(`/providers/${providerType}/groups`),
  getProviderScope: (providerType: string) =>
    request<ProviderScope>(`/providers/${providerType}/scope`),
  updateProviderScope: (providerType: string, payload: ProviderScope) =>
    request<ProviderScope>(`/providers/${providerType}/scope`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  openTestProfile: (providerType: string, externalProfileId: string) =>
    request<ProviderSessionRecord>(`/providers/${providerType}/profiles/${externalProfileId}/test-open`, {
      method: "POST",
    }),
  closeTestProfile: (providerType: string, externalProfileId: string) =>
    request(`/providers/${providerType}/profiles/${externalProfileId}/test-close`, {
      method: "POST",
    }),
  listProfiles: (
    providerType?: string,
    filters?: { group_id?: string | null; managed_only?: boolean | null; q?: string | null },
  ) =>
    request<ProfileRecord[]>(
      `/profiles${toQuery({
        provider_type: providerType,
        group_id: filters?.group_id,
        managed_only: filters?.managed_only,
        q: filters?.q,
      })}`,
    ),
  listWorkflows: (filters?: { folder?: string | null; provider_type?: string | null; q?: string | null }) =>
    request<WorkflowRecord[]>(
      `/workflows${toQuery({
        folder: filters?.folder,
        provider_type: filters?.provider_type,
        q: filters?.q,
      })}`,
    ),
  listActionCards: () => request<WorkflowActionCard[]>("/workflows/action-cards"),
  listWorkflowFolders: () => request<WorkflowFolderRecord[]>("/workflow-folders"),
  createWorkflowFolder: (name: string, description?: string) =>
    request<WorkflowFolderRecord>("/workflow-folders", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    }),
  updateWorkflowFolder: (oldName: string, name: string, description?: string) =>
    request<WorkflowFolderRecord>(`/workflow-folders/${encodeURIComponent(oldName)}`, {
      method: "PUT",
      body: JSON.stringify({ name, description }),
    }),
  deleteWorkflowFolder: (name: string) =>
    request<{ status: string }>(`/workflow-folders/${encodeURIComponent(name)}`, { method: "DELETE" }),
  getWorkflow: (workflowId: string) => request<WorkflowRecord>(`/workflows/${workflowId}`),
  createWorkflow: (workflowYaml: string, folder?: string) =>
    request<WorkflowRecord>("/workflows", {
      method: "POST",
      body: JSON.stringify({ workflow_yaml: workflowYaml, folder }),
    }),
  updateWorkflow: (workflowId: string, workflowYaml: string, folder?: string) =>
    request<WorkflowRecord>(`/workflows/${workflowId}`, {
      method: "PUT",
      body: JSON.stringify({ workflow_yaml: workflowYaml, folder }),
    }),
  deleteWorkflow: (workflowId: string) =>
    request<{ status: string }>(`/workflows/${workflowId}`, { method: "DELETE" }),
  duplicateWorkflow: (workflowId: string) =>
    request<WorkflowRecord>(`/workflows/${workflowId}/duplicate`, { method: "POST" }),
  validateWorkflow: (workflowId: string, workflowYaml: string) =>
    request<ValidationResult>(`/workflows/${workflowId}/validate`, {
      method: "POST",
      body: JSON.stringify({ workflow_yaml: workflowYaml }),
    }),
  dryRunWorkflow: (workflowId: string, payload: Record<string, unknown>) =>
    request<WorkflowDryRunResult>(`/workflows/${workflowId}/dry-run`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  validateLocator: (payload: Record<string, unknown>) =>
    request<LocatorValidationResult>("/locators/validate", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  previewLocatorLive: (payload: Record<string, unknown>) =>
    request<LocatorLivePreview>("/locators/live-preview", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  pickLocatorOnce: (payload: Record<string, unknown>) =>
    request<LocatorPickResult>("/locators/pick/once", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  previewWorkflowStep: (payload: Record<string, unknown>) =>
    request<StepLivePreviewResult>("/workflows/step-preview", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  importBatch: async (file: File, providerType: string, workflowId?: string | null) => {
    const form = new FormData();
    form.append("file", file);
    form.append("provider_type", providerType);
    if (workflowId) {
      form.append("workflow_id", workflowId);
    }
    return request<{
      batch: BatchDetail;
      detected_columns: string[];
      preview_rows: Record<string, unknown>[];
    }>("/batches/import", { method: "POST", body: form });
  },
  validateInputProfileMap: async (
    file: File,
    workflowId: string,
    providerType?: string | null,
    strict = true,
  ) => {
    const form = new FormData();
    form.append("file", file);
    form.append("workflow_id", workflowId);
    if (providerType) {
      form.append("provider_type", providerType);
    }
    form.append("strict", String(strict));
    return request<InputProfileMappingValidation>("/input-files/validate-profile-map", {
      method: "POST",
      body: form,
    });
  },
  downloadWorkflowInputTemplate: (workflowId: string) =>
    requestBlob(`/workflows/${workflowId}/input-template`),
  parseScheduleInputFile: async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<InputFileParseResult>("/schedules/input-file/parse", { method: "POST", body: form });
  },
  listBatches: () => request<BatchSummary[]>("/batches"),
  getBatch: (batchId: string) => request<BatchDetail>(`/batches/${batchId}`),
  startBatch: (batchId: string, payload: Record<string, unknown>) =>
    request<BatchDetail>(`/batches/${batchId}/start`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  pauseBatch: (batchId: string) => request(`/batches/${batchId}/pause`, { method: "POST" }),
  resumeBatch: (batchId: string) => request(`/batches/${batchId}/resume`, { method: "POST" }),
  cancelBatch: (batchId: string) => request(`/batches/${batchId}/cancel`, { method: "POST" }),
  getTask: (taskRunId: string) => request<TaskRunDetail>(`/task-runs/${taskRunId}`),
  listSchedules: () => request<ScheduleRecord[]>("/schedules"),
  createSchedule: (payload: Record<string, unknown>) =>
    request<ScheduleRecord>("/schedules", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  replaceScheduleInputFile: async (scheduleId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<ScheduleRecord>(`/schedules/${scheduleId}/input-file`, {
      method: "POST",
      body: form,
    });
  },
  updateSchedule: (scheduleId: string, payload: Record<string, unknown>) =>
    request<ScheduleRecord>(`/schedules/${scheduleId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  deleteSchedule: (scheduleId: string) =>
    request<{ status: string }>(`/schedules/${scheduleId}`, { method: "DELETE" }),
  getResultBatch: (batchId: string) => request<BatchDetail>(`/results/batches/${batchId}`),
};
