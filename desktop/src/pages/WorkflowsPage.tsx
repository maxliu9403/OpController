import { Alert, Button, Col, Drawer, Empty, Input, Modal, Popconfirm, Row, Select, Space, Spin, Steps, Table, Tabs, Tag, Typography, message, type TableColumnsType } from "antd";
import { Check, Copy, Download, FilePlus2, FolderPlus, Link2, LockKeyhole, Pencil, Trash2, Upload, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import YAML from "yaml";
import { api } from "../api/client";
import { SectionCard } from "../components/SectionCard";
import { StatusBadge } from "../components/StatusBadge";
import { TableActionMenu } from "../components/TableActionMenu";
import {
  type LocatorPreview,
  type StepComposerValues,
  WorkflowStepComposer,
} from "../components/WorkflowStepComposer";
import { type WorkflowDraftStep, WorkflowWizard } from "../components/WorkflowWizard";
import { usePolling } from "../hooks/usePolling";
import type {
  LocatorPickResult,
  ProfileRecord,
  ProviderGroupRecord,
  ProviderScope,
  StepLivePreviewResult,
  WorkflowActionCard,
  WorkflowDryRunStepResult,
  WorkflowDryRunResult,
  WorkflowFolderRecord,
  WorkflowRecord,
} from "../types";
import { downloadTextFile, safeFileName } from "../utils/files";

const MonacoEditor = lazy(() => import("@monaco-editor/react"));

function buildDefaultWorkflow(name = "新建运营流程", providerType = "ixbrowser") {
  return `metadata:
  name: ${JSON.stringify(name)}
  description: 向导生成的基础模板
  version: "1.0.0"
profile_policy:
  provider_type: ${providerType}
  selection_mode: explicit_profiles
  profile_ids: []
runtime_policy:
  mode: visual
  min_window_width: 420
  min_window_height: 720
  page_timeout_sec: 30
  step_timeout_sec: 15
  retry_once_on_failure: true
  screenshot_on_failure: true
steps: []
`;
}

const DEFAULT_WORKFLOW = buildDefaultWorkflow();

type WorkflowDraftDocument = {
  metadata?: Record<string, unknown>;
  profile_policy?: Record<string, unknown>;
  runtime_policy?: Record<string, unknown>;
  steps?: WorkflowDraftStep[];
  locators?: Record<string, Record<string, unknown>>;
};

type WorkflowExportBundle = {
  schema_version: "opcontroller.workflow.v1";
  exported_at: string;
  name: string;
  folder: string;
  provider_type: string;
  workflow_yaml: string;
};

type WorkflowEditorMode = "locked" | "editing";
type WorkflowOpenMode = "preview" | "edit";
type PendingWorkflowSwitch = {
  workflow: WorkflowRecord;
  mode: WorkflowOpenMode;
};

function workflowNameFromYaml(workflowYaml: string, fallback = "导入流程") {
  try {
    const parsed = YAML.parse(workflowYaml) as WorkflowDraftDocument;
    const name = parsed.metadata?.name;
    return typeof name === "string" && name.trim() ? name.trim() : fallback;
  } catch {
    return fallback;
  }
}

function providerTypeFromYaml(workflowYaml: string, fallback = "ixbrowser") {
  try {
    const parsed = YAML.parse(workflowYaml) as WorkflowDraftDocument;
    const providerType = parsed.profile_policy?.provider_type;
    return typeof providerType === "string" && providerType.trim() ? providerType.trim() : fallback;
  } catch {
    return fallback;
  }
}

function rewriteWorkflowName(workflowYaml: string, name: string) {
  const parsed = (YAML.parse(workflowYaml) ?? {}) as WorkflowDraftDocument;
  parsed.metadata = parsed.metadata ?? {};
  parsed.metadata.name = name;
  return YAML.stringify(parsed);
}

function rewriteWorkflowProvider(workflowYaml: string, providerType: string) {
  const parsed = (YAML.parse(workflowYaml) ?? {}) as WorkflowDraftDocument;
  applySelectedProfilePolicy(parsed, providerType, []);
  return YAML.stringify(parsed);
}

function requiresLocator(type: string) {
  return ["click", "fill", "select", "wait_visible", "wait", "extract_text", "for_each"].includes(type);
}

function stepRequiresLocator(type: string, values?: StepComposerValues | null) {
  if (type === "wait") {
    return values?.waitMode !== "page_stable" && values?.waitMode !== "page_ready";
  }
  return requiresLocator(type);
}

function buildLocatorPayload(values: StepComposerValues) {
  const attributes: Record<string, string> = {};
  if (values.attributeKey?.trim() && values.attributeValue?.trim()) {
    attributes[values.attributeKey.trim()] = values.attributeValue.trim();
  }
  return {
    tag_name: values.tagName ?? "button",
    text: values.visibleText?.trim() || values.targetName?.trim() || "",
    attributes,
    neighbors: values.neighborText?.trim() ? { anchor_text: values.neighborText.trim() } : {},
    list_context: values.listRowAnchor?.trim() ? { row_anchor_text: values.listRowAnchor.trim() } : {},
  };
}

function buildStepId(type: string, index: number) {
  return `${type}-${index}`;
}

function buildSelectorKey(type: string, index: number) {
  return `${type}_locator_${index}`;
}

function isAmbiguousClickStep(step: WorkflowDryRunStepResult) {
  return step.action_type === "click" && step.error_code === "locator_ambiguous";
}

function profileGroupId(profile: { group_summary?: { id?: string | number | null } }) {
  const raw = profile.group_summary?.id;
  return raw === null || raw === undefined || raw === "" ? "__ungrouped__" : String(raw);
}

function normalizeProviderScope(scope: ProviderScope | null | undefined, providerType: string): ProviderScope {
  return scope ?? {
    provider_type: providerType,
    managed_group_ids: [],
    include_profile_ids: [],
    exclude_profile_ids: [],
    is_configured: false,
  };
}

function filterManagedGroups(
  groups: ProviderGroupRecord[] | null | undefined,
  scope: ProviderScope | null | undefined,
  providerType: string,
) {
  const normalized = normalizeProviderScope(scope, providerType);
  const source = groups ?? [];
  if (!normalized.is_configured) {
    return source;
  }
  const managed = new Set(normalized.managed_group_ids.map(String));
  return source.filter((group) => managed.has(String(group.external_group_id)));
}

function workflowPolicyFromRecord(workflow: WorkflowRecord) {
  const normalizedPolicy = workflow.normalized_workflow_json?.profile_policy;
  if (normalizedPolicy && typeof normalizedPolicy === "object") {
    return normalizedPolicy as Record<string, unknown>;
  }
  try {
    const parsed = YAML.parse(workflow.workflow_yaml) as WorkflowDraftDocument;
    return parsed.profile_policy ?? {};
  } catch {
    return {};
  }
}

function workflowRunGroupIds(workflow: WorkflowRecord) {
  const policy = workflowPolicyFromRecord(workflow);
  return Array.isArray(policy.group_ids) ? policy.group_ids.map(String).filter(Boolean) : [];
}

function countProfilesInGroups(profiles: ProfileRecord[] | null | undefined, groupIds: string[]) {
  const groupSet = new Set(groupIds.map(String));
  return (profiles ?? []).filter((profile) => groupSet.has(profileGroupId(profile))).length;
}

function groupSummaryLabel(groups: ProviderGroupRecord[], groupIds: string[]) {
  if (!groupIds.length) {
    return "未关联";
  }
  const nameById = new Map(groups.map((group) => [String(group.external_group_id), group.display_name]));
  return groupIds
    .slice(0, 3)
    .map((id) => nameById.get(id) ?? id)
    .join("、") + (groupIds.length > 3 ? ` 等 ${groupIds.length} 组` : "");
}

function defaultTagForType(type: string) {
  if (type === "fill") {
    return "input";
  }
  if (type === "select") {
    return "select";
  }
  if (type === "for_each") {
    return "div";
  }
  return "button";
}

function collectSelectorKeys(steps: WorkflowDraftStep[] = [], keys = new Set<string>()) {
  for (const step of steps) {
    if (step.selector_key) {
      keys.add(step.selector_key);
    }
    if (step.steps?.length) {
      collectSelectorKeys(step.steps, keys);
    }
  }
  return keys;
}

function pruneUnusedLocators(parsed: WorkflowDraftDocument) {
  if (!parsed.locators) {
    return;
  }
  const used = collectSelectorKeys(parsed.steps ?? []);
  for (const key of Object.keys(parsed.locators)) {
    if (!used.has(key)) {
      delete parsed.locators[key];
    }
  }
}

function nextOrdinal(steps: WorkflowDraftStep[], locators: Record<string, unknown> | undefined, type: string) {
  const stepIds = new Set(steps.map((step) => step.id));
  const locatorKeys = new Set(Object.keys(locators ?? {}));
  let ordinal = steps.length + 1;
  while (stepIds.has(buildStepId(type, ordinal)) || locatorKeys.has(buildSelectorKey(type, ordinal))) {
    ordinal += 1;
  }
  return ordinal;
}

function applySelectedProfilePolicy(
  parsed: WorkflowDraftDocument,
  providerType: string,
  groupIds: string[],
) {
  parsed.profile_policy = parsed.profile_policy ?? {};
  parsed.profile_policy.provider_type = providerType;
  if (groupIds.length) {
    parsed.profile_policy.selection_mode = "by_group";
    parsed.profile_policy.group_ids = groupIds;
    parsed.profile_policy.profile_ids = [];
    return;
  }
  parsed.profile_policy.selection_mode = "explicit_profiles";
  parsed.profile_policy.group_ids = [];
  parsed.profile_policy.profile_ids = [];
}

function locatorToInitialPreview(locator: Record<string, unknown> | null | undefined): LocatorPreview | null {
  if (!locator) {
    return null;
  }
  return {
    valid: true,
    warnings: [],
    uniqueness_score: 1,
    stability_score: Number(locator.stability_score ?? 0),
    locator,
  };
}

function stepToComposerValues(
  step: WorkflowDraftStep,
  card: WorkflowActionCard,
  locator: Record<string, unknown> | null | undefined,
): StepComposerValues {
  const attributeSignature = (locator?.attribute_signature ?? {}) as Record<string, unknown>;
  const [attributeKey, attributeValue] = Object.entries(attributeSignature)[0] ?? [];
  const textSignature = (locator?.text_signature ?? {}) as Record<string, unknown>;
  const neighborSignature = (locator?.neighbor_anchor_signature ?? {}) as Record<string, unknown>;
  const listContextSignature = (locator?.list_context_signature ?? {}) as Record<string, unknown>;

  return {
    stepLabel: step.label || step.id || card.label,
    url: step.url ?? undefined,
    value:
      typeof step.value === "string"
        ? step.value
        : step.value === null || step.value === undefined
          ? undefined
          : JSON.stringify(step.value),
    saveAs: step.save_as ?? undefined,
    timeoutSec: step.timeout_sec ?? undefined,
    waitMode:
      step.wait_mode === "element_hidden" ||
      step.wait_mode === "element_count" ||
      step.wait_mode === "page_stable" ||
      step.wait_mode === "page_ready"
        ? step.wait_mode
        : step.type === "wait"
          ? "page_ready"
          : undefined,
    onTimeout:
      step.on_timeout === "continue_with_warning" ? "continue_with_warning" : "fail",
    minCount: typeof step.min_count === "number" ? step.min_count : 1,
    stableMs: typeof step.stable_ms === "number" ? step.stable_ms : 1200,
    optional: Boolean(step.optional),
	    clickTargetMode:
	      step.click_target_mode === "random_many" ? "random_many" : "unique",
	    randomClickCount: typeof step.random_click_count === "number" ? step.random_click_count : 1,
	    scrollDirection: step.scroll_direction === "up" ? "up" : "down",
	    scrollDistance: typeof step.scroll_distance === "number" ? step.scroll_distance : 320,
	    scrollRepeat: typeof step.scroll_repeat === "number" ? step.scroll_repeat : 4,
	    scrollPauseMs: typeof step.scroll_pause_ms === "number" ? step.scroll_pause_ms : 1200,
    targetName: step.label || card.label,
    tagName: String(locator?.tag_name ?? defaultTagForType(card.type)),
    visibleText: typeof textSignature.normalized === "string" ? textSignature.normalized : undefined,
    attributeKey,
    attributeValue: attributeValue === undefined ? undefined : String(attributeValue),
    neighborText:
      typeof neighborSignature.anchor_text === "string" ? neighborSignature.anchor_text : undefined,
    listRowAnchor:
      typeof listContextSignature.row_anchor_text === "string"
        ? listContextSignature.row_anchor_text
        : undefined,
  };
}

function buildStepPayload(
  card: WorkflowActionCard,
  values: StepComposerValues,
  options?: { stepId?: string; selectorKey?: string },
) {
  const step: Record<string, unknown> = {
    id: options?.stepId ?? `${card.type}-preview`,
    type: card.type,
    label: values.stepLabel,
  };

  if (values.timeoutSec) {
    step.timeout_sec = values.timeoutSec;
  }

  if (card.type === "goto") {
    step.url = values.url?.trim();
  }

  if (card.type === "fill" || card.type === "select") {
    step.value = typeof values.value === "string" ? values.value.trim() : values.value;
  }

  if (card.type === "sleep") {
    step.value = Number(values.value ?? 5);
  }

	  if (card.type === "scroll") {
	    step.scroll_direction = values.scrollDirection ?? "down";
	    step.scroll_distance = Math.max(1, Number(values.scrollDistance ?? 320));
	    step.scroll_repeat = Math.max(1, Number(values.scrollRepeat ?? 4));
	    step.scroll_pause_ms = Math.max(0, Number(values.scrollPauseMs ?? 1200));
	  }

  if (card.type === "click") {
    step.click_target_mode = values.clickTargetMode ?? "unique";
    step.random_click_count =
      values.clickTargetMode === "random_many"
        ? Math.max(1, Number(values.randomClickCount ?? 1))
        : 1;
  }

  if (card.type === "wait") {
    step.wait_mode = values.waitMode ?? "page_ready";
    step.on_timeout = values.onTimeout ?? "fail";
    step.optional = values.onTimeout === "continue_with_warning" || Boolean(values.optional);
    if (values.waitMode === "element_count") {
      step.min_count = Math.max(0, Number(values.minCount ?? 1));
    }
    if (values.waitMode === "page_stable" || values.waitMode === "page_ready") {
      step.stable_ms = Math.max(300, Number(values.stableMs ?? 1200));
    }
  }

  if (card.type === "extract_text" || card.type === "screenshot") {
    if (values.saveAs?.trim()) {
      step.save_as = values.saveAs.trim();
    }
  }

  if (card.type === "for_each") {
    step.steps = [];
  }

  if (options?.selectorKey) {
    step.selector_key = options.selectorKey;
  }

  return step;
}

export function WorkflowsPage() {
  const providers = usePolling(api.listProviders, { intervalMs: 12000, cacheKey: "providers:list" });
  const actionCards = usePolling(api.listActionCards, { intervalMs: 12000, cacheKey: "workflows:action-cards" });
  const [workflowReloadKey, setWorkflowReloadKey] = useState(0);
  const [folderReloadKey, setFolderReloadKey] = useState(0);
  const [workflowFolderFilter, setWorkflowFolderFilter] = useState<string | null>(null);
  const [workflowProviderFilter, setWorkflowProviderFilter] = useState<string | null>(null);
  const [workflowSearch, setWorkflowSearch] = useState("");
  const [activeFolder, setActiveFolder] = useState("未分组");
  const [creatingWorkflow, setCreatingWorkflow] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newWorkflowModalOpen, setNewWorkflowModalOpen] = useState(false);
  const [newWorkflowStep, setNewWorkflowStep] = useState(0);
  const [newWorkflowName, setNewWorkflowName] = useState("");
  const [newWorkflowFolder, setNewWorkflowFolder] = useState("未分组");
  const [newWorkflowFolderInput, setNewWorkflowFolderInput] = useState("");
  const [newWorkflowProviderType, setNewWorkflowProviderType] = useState("ixbrowser");
  const [startingWorkflow, setStartingWorkflow] = useState(false);
  const [importingWorkflow, setImportingWorkflow] = useState(false);
  const [editingFolderName, setEditingFolderName] = useState<string | null>(null);
  const [editingFolderValue, setEditingFolderValue] = useState("");
  const [folderActionLoading, setFolderActionLoading] = useState(false);
  const [renamingWorkflowId, setRenamingWorkflowId] = useState<string | null>(null);
  const [renamingWorkflowValue, setRenamingWorkflowValue] = useState("");
  const [workflowActionLoadingId, setWorkflowActionLoadingId] = useState<string | null>(null);
  const [activeWorkflow, setActiveWorkflow] = useState<WorkflowRecord | null>(null);
  const [editorMode, setEditorMode] = useState<WorkflowEditorMode>("locked");
  const [pendingWorkflowSwitch, setPendingWorkflowSwitch] = useState<PendingWorkflowSwitch | null>(null);
  const [pendingSwitchSaving, setPendingSwitchSaving] = useState(false);
  const [pendingNewWorkflowOpen, setPendingNewWorkflowOpen] = useState(false);
  const [pendingNewWorkflowSaving, setPendingNewWorkflowSaving] = useState(false);
  const [yamlValue, setYamlValue] = useState(DEFAULT_WORKFLOW);
  const [selectedCard, setSelectedCard] = useState<WorkflowActionCard | null>(null);
  const [editingStepIndex, setEditingStepIndex] = useState<number | null>(null);
  const [insertAfterStepIndex, setInsertAfterStepIndex] = useState<number | null>(null);
  const [selectedProviderType, setSelectedProviderType] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [runGroupIds, setRunGroupIds] = useState<string[]>([]);
  const [profileReloadKey, setProfileReloadKey] = useState(0);
  const [groupReloadKey, setGroupReloadKey] = useState(0);
  const [sessionReloadKey, setSessionReloadKey] = useState(0);
  const [sessionActionLoading, setSessionActionLoading] = useState(false);
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<WorkflowDryRunResult | null>(null);
  const [profileGroupModalWorkflow, setProfileGroupModalWorkflow] = useState<WorkflowRecord | null>(null);
  const [profileGroupDraftIds, setProfileGroupDraftIds] = useState<string[]>([]);
  const [profileGroupSaving, setProfileGroupSaving] = useState(false);
  const [profileGroupModalReloadKey, setProfileGroupModalReloadKey] = useState(0);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const workflowsFetcher = useCallback(
    () =>
      api.listWorkflows({
        folder: workflowFolderFilter,
        provider_type: workflowProviderFilter,
        q: workflowSearch.trim() || null,
      }),
    [workflowFolderFilter, workflowProviderFilter, workflowSearch, workflowReloadKey],
  );
  const foldersFetcher = useCallback(() => api.listWorkflowFolders(), [folderReloadKey]);
  const profilesFetcher = useCallback(
    () => (selectedProviderType ? api.listProfiles(selectedProviderType, { managed_only: true }) : Promise.resolve([])),
    [selectedProviderType, profileReloadKey],
  );
  const groupsFetcher = useCallback(
    () => (selectedProviderType ? api.listProviderGroups(selectedProviderType) : Promise.resolve([])),
    [selectedProviderType, groupReloadKey],
  );
  const providerScopeFetcher = useCallback(
    () => (selectedProviderType ? api.getProviderScope(selectedProviderType) : Promise.resolve(null)),
    [selectedProviderType, groupReloadKey],
  );
  const sessionsFetcher = useCallback(
    () => (selectedProviderType ? api.listProviderSessions(selectedProviderType) : Promise.resolve([])),
    [selectedProviderType, sessionReloadKey],
  );
  const profileGroupModalProviderType = profileGroupModalWorkflow?.target_provider_type ?? "";
  const profileGroupModalGroupsFetcher = useCallback(
    () => (profileGroupModalProviderType ? api.listProviderGroups(profileGroupModalProviderType) : Promise.resolve([])),
    [profileGroupModalProviderType, profileGroupModalReloadKey],
  );
  const profileGroupModalProfilesFetcher = useCallback(
    () =>
      profileGroupModalProviderType
        ? api.listProfiles(profileGroupModalProviderType, { managed_only: true })
        : Promise.resolve([]),
    [profileGroupModalProviderType, profileGroupModalReloadKey],
  );
  const profileGroupModalScopeFetcher = useCallback(
    () => (profileGroupModalProviderType ? api.getProviderScope(profileGroupModalProviderType) : Promise.resolve(null)),
    [profileGroupModalProviderType, profileGroupModalReloadKey],
  );
  const workflowListCacheKey = [
    "workflows:list",
    workflowFolderFilter ?? "all",
    workflowProviderFilter ?? "all",
    workflowSearch.trim() || "all",
  ].join(":");
  const workflows = usePolling(workflowsFetcher, { intervalMs: 12000, cacheKey: workflowListCacheKey });
  const folders = usePolling(foldersFetcher, { intervalMs: 12000, cacheKey: "workflow-folders:list" });
  const profiles = usePolling(profilesFetcher, {
    intervalMs: 10000,
    cacheKey: `provider:${selectedProviderType || "none"}:profiles:managed`,
    enabled: Boolean(selectedProviderType),
  });
  const groups = usePolling(groupsFetcher, {
    intervalMs: 10000,
    cacheKey: `provider:${selectedProviderType || "none"}:groups`,
    enabled: Boolean(selectedProviderType),
  });
  const providerScope = usePolling(providerScopeFetcher, {
    intervalMs: 10000,
    cacheKey: `provider:${selectedProviderType || "none"}:scope`,
    enabled: Boolean(selectedProviderType),
  });
  const openedSessions = usePolling(sessionsFetcher, {
    intervalMs: 6000,
    cacheKey: `provider:${selectedProviderType || "none"}:sessions`,
    enabled: Boolean(selectedProviderType),
  });
  const profileGroupModalGroups = usePolling(profileGroupModalGroupsFetcher, {
    intervalMs: 10000,
    cacheKey: `provider:${profileGroupModalProviderType || "none"}:groups`,
    enabled: Boolean(profileGroupModalProviderType),
  });
  const profileGroupModalProfiles = usePolling(profileGroupModalProfilesFetcher, {
    intervalMs: 10000,
    cacheKey: `provider:${profileGroupModalProviderType || "none"}:profiles:managed`,
    enabled: Boolean(profileGroupModalProviderType),
  });
  const profileGroupModalScope = usePolling(profileGroupModalScopeFetcher, {
    intervalMs: 10000,
    cacheKey: `provider:${profileGroupModalProviderType || "none"}:scope`,
    enabled: Boolean(profileGroupModalProviderType),
  });

  useEffect(() => {
    if (!selectedProviderType && providers.data?.length) {
      setSelectedProviderType(providers.data[0].provider_type);
    }
    if (providers.data?.length && !providers.data.some((item) => item.provider_type === newWorkflowProviderType)) {
      setNewWorkflowProviderType(providers.data[0].provider_type);
    }
  }, [newWorkflowProviderType, providers.data, selectedProviderType]);

  useEffect(() => {
    if (!activeWorkflow && !creatingWorkflow && workflows.data?.length) {
      setActiveWorkflow(workflows.data[0]);
      setEditorMode("locked");
      setYamlValue(workflows.data[0].workflow_yaml);
      setActiveFolder(workflows.data[0].folder || "未分组");
    }
  }, [activeWorkflow, creatingWorkflow, workflows.data]);

  useEffect(() => {
    if (activeWorkflow?.target_provider_type) {
      setSelectedProviderType(activeWorkflow.target_provider_type);
    }
    if (activeWorkflow?.folder) {
      setActiveFolder(activeWorkflow.folder);
    }
    if (activeWorkflow?.workflow_yaml) {
      try {
        const parsed = YAML.parse(activeWorkflow.workflow_yaml) as WorkflowDraftDocument;
        const policy = parsed.profile_policy ?? {};
        const groupIds = Array.isArray(policy.group_ids) ? policy.group_ids : [];
        const profileIds = Array.isArray(policy.profile_ids) ? policy.profile_ids : [];
        setRunGroupIds(groupIds.map(String));
        setSelectedGroupId(groupIds[0] === undefined ? null : String(groupIds[0]));
        setSelectedProfileId(profileIds[0] === undefined ? null : String(profileIds[0]));
      } catch {
        setRunGroupIds([]);
        setSelectedGroupId(null);
        setSelectedProfileId(null);
      }
    }
  }, [activeWorkflow?.target_provider_type, activeWorkflow?.workflow_yaml]);

  useEffect(() => {
    if (!selectedProfileId && profiles.data?.length && !selectedGroupId) {
      setSelectedProfileId(profiles.data[0].external_profile_id);
    }
  }, [profiles.data, selectedGroupId, selectedProfileId]);

  const folderRecords = useMemo(
    () => (folders.data?.length ? folders.data : [{ name: "未分组", workflow_count: 0 } as WorkflowFolderRecord]),
    [folders.data],
  );
  const folderOptions = useMemo(
    () =>
      folderRecords.map((folder) => ({
        value: folder.name,
        label: `${folder.name} (${folder.workflow_count})`,
      })),
    [folderRecords],
  );
  const folderNameSet = useMemo(
    () => new Set(folderRecords.map((folder) => folder.name)),
    [folderRecords],
  );
  const isWorkflowEditable = creatingWorkflow || editorMode === "editing";
  const hasUnsavedWorkflowChanges = useMemo(() => {
    if (!isWorkflowEditable) {
      return false;
    }
    if (creatingWorkflow) {
      return true;
    }
    if (!activeWorkflow) {
      return false;
    }
    return yamlValue !== activeWorkflow.workflow_yaml || activeFolder !== (activeWorkflow.folder || "未分组");
  }, [activeFolder, activeWorkflow, creatingWorkflow, editorMode, isWorkflowEditable, yamlValue]);

  const workflowDraft = useMemo(() => {
    try {
      return YAML.parse(yamlValue) as WorkflowDraftDocument;
    } catch {
      return null;
    }
  }, [yamlValue]);

  const draftSteps = workflowDraft?.steps ?? [];
  const draftLocators = workflowDraft?.locators ?? {};
  const providerOptions = useMemo(
    () =>
      (providers.data ?? []).map((item) => ({ value: item.provider_type, label: item.display_name })),
    [providers.data],
  );
  const managedGroups = useMemo(
    () => filterManagedGroups(groups.data, providerScope.data, selectedProviderType),
    [groups.data, providerScope.data, selectedProviderType],
  );
  const filteredProfiles = useMemo(
    () =>
      (profiles.data ?? []).filter((profile) => {
        if (!selectedGroupId) {
          return true;
        }
        return profileGroupId(profile) === selectedGroupId;
      }),
    [profiles.data, selectedGroupId],
  );
  const selectedSession = useMemo(
    () =>
      (openedSessions.data ?? []).find((item) => item.provider_profile_id === selectedProfileId) ?? null,
    [openedSessions.data, selectedProfileId],
  );
  const selectedProfile = useMemo(
    () => filteredProfiles.find((item) => item.external_profile_id === selectedProfileId) ?? null,
    [filteredProfiles, selectedProfileId],
  );
  const selectedGroup = useMemo(
    () => managedGroups.find((item) => item.external_group_id === selectedGroupId) ?? null,
    [managedGroups, selectedGroupId],
  );
  const workflowProfileBindingStatus = useCallback(
    (workflow: WorkflowRecord) => {
      const groupIds = workflowRunGroupIds(workflow);
      if (!groupIds.length) {
        return {
          color: "red",
          label: "未关联 Profile 组",
          detail: "不可启动",
          profileCount: 0,
          usable: false,
        };
      }
      if (workflow.target_provider_type !== selectedProviderType) {
        return {
          color: "blue",
          label: `已关联 ${groupIds.length} 组`,
          detail: "切换 Provider 后可查看数量",
          profileCount: null,
          usable: true,
        };
      }
      const managedIds = new Set(managedGroups.map((group) => String(group.external_group_id)));
      const outOfScope = groupIds.filter((groupId) => !managedIds.has(groupId));
      if (outOfScope.length) {
        return {
          color: "red",
          label: "Provider 未加白",
          detail: outOfScope.slice(0, 3).join("、"),
          profileCount: 0,
          usable: false,
        };
      }
      const profileCount = countProfilesInGroups(profiles.data, groupIds);
      if (profileCount <= 0) {
        return {
          color: "red",
          label: "未命中 Profile",
          detail: "不可启动",
          profileCount,
          usable: false,
        };
      }
      return {
        color: "green",
        label: `可启动 ${profileCount} Profiles`,
        detail: groupSummaryLabel(managedGroups, groupIds),
        profileCount,
        usable: true,
      };
    },
    [managedGroups, profiles.data, selectedProviderType],
  );
  const groupOptions = useMemo(
    () => [
      { value: "__all__", label: "全部已管理分组" },
      ...managedGroups.map((group) => ({
        value: group.external_group_id,
        label: `${group.display_name}${group.profile_count === null || group.profile_count === undefined ? "" : ` (${group.profile_count})`}`,
      })),
    ],
    [managedGroups],
  );
  const modalManagedGroups = useMemo(
    () => filterManagedGroups(profileGroupModalGroups.data, profileGroupModalScope.data, profileGroupModalProviderType),
    [profileGroupModalGroups.data, profileGroupModalProviderType, profileGroupModalScope.data],
  );
  const modalGroupOptions = useMemo(() => {
    const managedIds = new Set(modalManagedGroups.map((group) => String(group.external_group_id)));
    const unavailableSelected = profileGroupDraftIds.filter((id) => id && !managedIds.has(String(id)));
    return [
      ...modalManagedGroups.map((group) => ({
        value: group.external_group_id,
        label: `${group.display_name}${group.profile_count === null || group.profile_count === undefined ? "" : ` (${group.profile_count})`}`,
      })),
      ...unavailableSelected.map((id) => ({
        value: id,
        label: `未在 Provider 管理范围内：${id}`,
        disabled: true,
      })),
    ];
  }, [modalManagedGroups, profileGroupDraftIds]);
  const modalProfileCount = useMemo(
    () => countProfilesInGroups(profileGroupModalProfiles.data, profileGroupDraftIds),
    [profileGroupDraftIds, profileGroupModalProfiles.data],
  );
  const profileOptions = useMemo(
    () =>
      filteredProfiles.map((profile) => ({
        value: profile.external_profile_id,
        label: `${profile.display_name} (#${profile.external_profile_id})`,
      })),
    [filteredProfiles],
  );

  useEffect(() => {
    if (!filteredProfiles.length) {
      setSelectedProfileId(null);
      return;
    }
    if (!selectedProfileId || !filteredProfiles.some((profile) => profile.external_profile_id === selectedProfileId)) {
      setSelectedProfileId(filteredProfiles[0].external_profile_id);
    }
  }, [filteredProfiles, selectedProfileId]);

  useEffect(() => {
    if (!selectedGroupId) {
      return;
    }
    if (!managedGroups.some((group) => String(group.external_group_id) === selectedGroupId)) {
      setSelectedGroupId(null);
    }
  }, [managedGroups, selectedGroupId]);

  const ensureWorkflowEditable = useCallback(() => {
    if (isWorkflowEditable) {
      return true;
    }
    message.info("当前流程画布已锁定，请先点击流程列表中的“编排”再修改节点。");
    return false;
  }, [isWorkflowEditable]);

  const openStepComposer = (card: WorkflowActionCard, options?: { insertAfterIndex?: number }) => {
    if (!ensureWorkflowEditable()) {
      return;
    }
    if (!workflowDraft) {
      message.error("当前 YAML 结构不可解析，先修复高级视图里的语法");
      return;
    }
    setEditingStepIndex(null);
    setInsertAfterStepIndex(
      typeof options?.insertAfterIndex === "number" ? options.insertAfterIndex : null,
    );
    setSelectedCard(card);
  };

  const handleEditStep = (index: number) => {
    if (!ensureWorkflowEditable()) {
      return;
    }
    const step = draftSteps[index];
    const card = (actionCards.data ?? []).find((item) => item.type === step?.type);
    if (!step || !card) {
      message.warning("这个步骤类型暂不支持在运营视图编辑，可以在高级 YAML 中查看。");
      return;
    }
    setEditingStepIndex(index);
    setInsertAfterStepIndex(null);
    setSelectedCard(card);
  };

  const updateWorkflowDraft = (mutator: (parsed: WorkflowDraftDocument) => void, successMessage: string) => {
    if (!ensureWorkflowEditable()) {
      return;
    }
    try {
      const parsed = (YAML.parse(yamlValue) ?? {}) as WorkflowDraftDocument;
      parsed.steps = parsed.steps ?? [];
      parsed.locators = parsed.locators ?? {};
      mutator(parsed);
      pruneUnusedLocators(parsed);
      setYamlValue(YAML.stringify(parsed));
      message.success(successMessage);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "流程更新失败");
    }
  };

  const handleDeleteStep = (index: number) => {
    updateWorkflowDraft((parsed) => {
      if (!parsed.steps?.[index]) {
        throw new Error("找不到要删除的步骤");
      }
      parsed.steps.splice(index, 1);
    }, "步骤已删除");
  };

  const handleDuplicateStep = (index: number) => {
    updateWorkflowDraft((parsed) => {
      const source = parsed.steps?.[index];
      if (!source) {
        throw new Error("找不到要复制的步骤");
      }
      const ordinal = nextOrdinal(parsed.steps ?? [], parsed.locators, source.type);
      const copiedStep: WorkflowDraftStep = {
        ...source,
        id: buildStepId(source.type, ordinal),
        label: source.label ? `${source.label} 副本` : `${source.id} 副本`,
        steps: source.steps ? structuredClone(source.steps) : undefined,
      };
      if (source.selector_key && parsed.locators?.[source.selector_key]) {
        const selectorKey = buildSelectorKey(source.type, ordinal);
        copiedStep.selector_key = selectorKey;
        parsed.locators[selectorKey] = structuredClone(parsed.locators[source.selector_key]);
      }
      parsed.steps?.splice(index + 1, 0, copiedStep);
    }, "步骤已复制");
  };

  const handleMoveStep = (index: number, direction: "up" | "down") => {
    updateWorkflowDraft((parsed) => {
      const steps = parsed.steps ?? [];
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= steps.length) {
        return;
      }
      const [step] = steps.splice(index, 1);
      steps.splice(targetIndex, 0, step);
      parsed.steps = steps;
    }, "步骤顺序已更新");
  };

  const handleConvertStepToRandomClick = (stepId: string) => {
    updateWorkflowDraft((parsed) => {
      const step = parsed.steps?.find((item) => item.id === stepId);
      if (!step) {
        throw new Error("找不到要修复的点击步骤");
      }
      if (step.type !== "click") {
        throw new Error("只有点击步骤可以切换为随机点击");
      }
      step.click_target_mode = "random_many";
      step.random_click_count = 1;
    }, "已把该步骤改为随机点击 1 个匹配元素，请重新试运行。");
    setDryRunResult(null);
  };

  const resetComposerState = () => {
    setSelectedCard(null);
    setEditingStepIndex(null);
    setInsertAfterStepIndex(null);
    setDryRunResult(null);
  };

  const loadWorkflowIntoCanvas = (workflow: WorkflowRecord, mode: WorkflowOpenMode) => {
    const policy = workflowPolicyFromRecord(workflow);
    const groupIds = Array.isArray(policy.group_ids) ? policy.group_ids.map(String).filter(Boolean) : [];
    const profileIds = Array.isArray(policy.profile_ids) ? policy.profile_ids.map(String).filter(Boolean) : [];
    setActiveWorkflow(workflow);
    setCreatingWorkflow(false);
    setActiveFolder(workflow.folder || "未分组");
    setYamlValue(workflow.workflow_yaml);
    setSelectedProviderType(workflow.target_provider_type);
    setRunGroupIds(groupIds);
    setSelectedGroupId(groupIds[0] ?? null);
    setSelectedProfileId(profileIds[0] ?? null);
    setEditorMode(mode === "edit" ? "editing" : "locked");
    resetComposerState();
  };

  const confirmEnterEditMode = (workflow: WorkflowRecord) => {
    Modal.confirm({
      title: "进入编排模式？",
      okText: "进入编排",
      cancelText: "保持锁定",
      content: (
        <Space direction="vertical" size={8}>
          <Typography.Text>流程：{workflow.name}</Typography.Text>
          <Typography.Text type="secondary">
            当前流程默认是只读锁定状态。进入编排后才能新增、编辑、删除和调整节点。
          </Typography.Text>
        </Space>
      ),
      onOk: () => {
        setEditorMode("editing");
        setSelectedProviderType(workflow.target_provider_type);
        message.success("流程画布已解锁，可以开始编排。");
      },
    });
  };

  const handleOpenWorkflow = (workflow: WorkflowRecord, mode: WorkflowOpenMode) => {
    const isSameWorkflow = activeWorkflow?.id === workflow.id && !creatingWorkflow;
    if (isSameWorkflow) {
      if (mode === "edit") {
        if (editorMode === "editing") {
          message.info("当前流程已经处于编排模式。");
          return;
        }
        confirmEnterEditMode(workflow);
      }
      return;
    }

    if (isWorkflowEditable) {
      setPendingWorkflowSwitch({ workflow, mode });
      return;
    }

    Modal.confirm({
      title: mode === "edit" ? "切换并进入编排？" : "切换查看流程？",
      okText: mode === "edit" ? "确认编排" : "确认查看",
      cancelText: "取消",
      content: (
        <Space direction="vertical" size={8}>
          <Typography.Text>即将切换到：{workflow.name}</Typography.Text>
          <Typography.Text type="secondary">
            {mode === "edit" ? "切换后会解锁下方流程画布。" : "切换后下方流程画布仍保持只读锁定。"}
          </Typography.Text>
        </Space>
      ),
      onOk: () => loadWorkflowIntoCanvas(workflow, mode),
    });
  };

  const openNewWorkflowGuide = () => {
    const now = new Date();
    const name = `新建运营流程 ${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;
    const folder = workflowFolderFilter || activeFolder || "未分组";
    setNewWorkflowName(name);
    setNewWorkflowFolder(folder);
    setNewWorkflowProviderType(selectedProviderType || providers.data?.[0]?.provider_type || "ixbrowser");
    setNewWorkflowFolderInput("");
    setNewWorkflowStep(0);
    setNewWorkflowModalOpen(true);
  };

  const handleNewWorkflow = () => {
    if (isWorkflowEditable) {
      setPendingNewWorkflowOpen(true);
      return;
    }
    openNewWorkflowGuide();
  };

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) {
      message.warning("请输入流程分组名称");
      return;
    }
    try {
      await api.createWorkflowFolder(name);
      setNewFolderName("");
      setFolderReloadKey((value) => value + 1);
      setWorkflowFolderFilter(name);
      setActiveFolder(name);
      message.success("流程分组已创建");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "创建分组失败");
    }
  };

  const startEditFolder = (name: string) => {
    setEditingFolderName(name);
    setEditingFolderValue(name);
  };

  const cancelEditFolder = () => {
    setEditingFolderName(null);
    setEditingFolderValue("");
  };

  const handleRenameFolder = async () => {
    if (!editingFolderName) {
      return;
    }
    const nextName = editingFolderValue.trim();
    if (!nextName) {
      message.warning("请输入新的流程分组名称");
      return;
    }
    try {
      setFolderActionLoading(true);
      const updated = await api.updateWorkflowFolder(editingFolderName, nextName);
      if (workflowFolderFilter === editingFolderName) {
        setWorkflowFolderFilter(updated.name);
      }
      if (activeFolder === editingFolderName) {
        setActiveFolder(updated.name);
      }
      if (newWorkflowFolder === editingFolderName) {
        setNewWorkflowFolder(updated.name);
      }
      if (activeWorkflow?.folder === editingFolderName) {
        setActiveWorkflow({ ...activeWorkflow, folder: updated.name });
      }
      setWorkflowReloadKey((value) => value + 1);
      setFolderReloadKey((value) => value + 1);
      cancelEditFolder();
      message.success("流程分组已重命名");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "重命名分组失败");
    } finally {
      setFolderActionLoading(false);
    }
  };

  const handleDeleteFolder = async (folderName: string) => {
    try {
      setFolderActionLoading(true);
      await api.deleteWorkflowFolder(folderName);
      if (workflowFolderFilter === folderName) {
        setWorkflowFolderFilter(null);
      }
      if (activeFolder === folderName) {
        setActiveFolder("未分组");
      }
      if (newWorkflowFolder === folderName) {
        setNewWorkflowFolder("未分组");
      }
      if (activeWorkflow?.folder === folderName) {
        setActiveWorkflow({ ...activeWorkflow, folder: "未分组" });
      }
      setWorkflowReloadKey((value) => value + 1);
      setFolderReloadKey((value) => value + 1);
      message.success("流程分组已删除，组内流程已移到未分组");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "删除分组失败");
    } finally {
      setFolderActionLoading(false);
    }
  };

  const ensureWorkflowFolder = async (folderName: string) => {
    if (!folderName || folderName === "未分组" || folderNameSet.has(folderName)) {
      return;
    }
    await api.createWorkflowFolder(folderName);
    setFolderReloadKey((value) => value + 1);
  };

  const handleUseNewWorkflowFolder = () => {
    const folderName = newWorkflowFolderInput.trim();
    if (!folderName) {
      message.warning("请输入要创建的流程分组名称");
      return;
    }
    setNewWorkflowFolder(folderName);
    setNewWorkflowFolderInput("");
    message.success(`已选择新分组：${folderName}`);
  };

  const handleStartNewWorkflow = async () => {
    const name = newWorkflowName.trim();
    const folder = newWorkflowFolder.trim() || "未分组";
    if (!name) {
      message.warning("请先填写流程名称");
      setNewWorkflowStep(1);
      return;
    }
    try {
      setStartingWorkflow(true);
      await ensureWorkflowFolder(folder);
      setActiveWorkflow(null);
      setCreatingWorkflow(true);
      setEditorMode("editing");
      setActiveFolder(folder);
      setWorkflowFolderFilter(folder);
      setSelectedProviderType(newWorkflowProviderType);
      setRunGroupIds([]);
      setYamlValue(buildDefaultWorkflow(name, newWorkflowProviderType));
      resetComposerState();
      setNewWorkflowModalOpen(false);
      message.success("新流程草稿已就绪，可以开始编排。");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "新建流程失败");
    } finally {
      setStartingWorkflow(false);
    }
  };

  const handleNewWorkflowNext = () => {
    if (newWorkflowStep === 0 && !newWorkflowFolder.trim()) {
      message.warning("请先选择或创建流程分组");
      return;
    }
    if (newWorkflowStep === 1 && !newWorkflowName.trim()) {
      message.warning("请先填写流程名称");
      return;
    }
    setNewWorkflowStep((step) => Math.min(step + 1, 2));
  };

  const handleDuplicateWorkflow = async (workflow: WorkflowRecord) => {
    try {
      const copied = await api.duplicateWorkflow(workflow.id);
      setWorkflowReloadKey((value) => value + 1);
      if (isWorkflowEditable) {
        message.success(`流程已复制为「${copied.name}」，当前编排上下文保持不变。`);
        return;
      }
      setActiveWorkflow(copied);
      setCreatingWorkflow(false);
      setEditorMode("locked");
      setActiveFolder(copied.folder || "未分组");
      setYamlValue(copied.workflow_yaml);
      resetComposerState();
      message.success("流程已复制，点击“编排”后可修改副本。");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "复制失败");
    }
  };

  const startRenameWorkflow = (workflow: WorkflowRecord) => {
    setRenamingWorkflowId(workflow.id);
    setRenamingWorkflowValue(workflow.name);
  };

  const cancelRenameWorkflow = () => {
    setRenamingWorkflowId(null);
    setRenamingWorkflowValue("");
  };

  const handleRenameWorkflow = async (workflow: WorkflowRecord) => {
    const nextName = renamingWorkflowValue.trim();
    if (!nextName) {
      message.warning("请输入新的流程名称");
      return;
    }
    try {
      setWorkflowActionLoadingId(workflow.id);
      const workflowYaml = rewriteWorkflowName(workflow.workflow_yaml, nextName);
      const saved = await api.updateWorkflow(workflow.id, workflowYaml, workflow.folder);
      if (activeWorkflow?.id === workflow.id) {
        setActiveWorkflow(saved);
        setYamlValue(saved.workflow_yaml);
        setActiveFolder(saved.folder || "未分组");
      }
      setWorkflowReloadKey((value) => value + 1);
      cancelRenameWorkflow();
      message.success("流程名称已更新");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "流程改名失败");
    } finally {
      setWorkflowActionLoadingId(null);
    }
  };

  const handleMoveWorkflowFolder = async (workflow: WorkflowRecord, folder: string) => {
    if (workflow.folder === folder) {
      return;
    }
    try {
      setWorkflowActionLoadingId(workflow.id);
      const saved = await api.updateWorkflow(workflow.id, workflow.workflow_yaml, folder);
      if (activeWorkflow?.id === workflow.id) {
        setActiveWorkflow(saved);
        setActiveFolder(saved.folder || "未分组");
      }
      setWorkflowReloadKey((value) => value + 1);
      setFolderReloadKey((value) => value + 1);
      message.success(folder === "未分组" ? "流程已移出分组" : "流程分组已更新");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "修改流程分组失败");
    } finally {
      setWorkflowActionLoadingId(null);
    }
  };

  const handleSwitchWorkflowProvider = (workflow: WorkflowRecord, providerType: string) => {
    if (workflow.target_provider_type === providerType) {
      return;
    }
    const currentProviderLabel =
      providerOptions.find((option) => option.value === workflow.target_provider_type)?.label ?? workflow.target_provider_type;
    const nextProviderLabel =
      providerOptions.find((option) => option.value === providerType)?.label ?? providerType;

    Modal.confirm({
      title: "切换流程 Provider？",
      okText: "确认切换",
      cancelText: "取消",
      content: (
        <Space direction="vertical" size={8}>
          <Typography.Text>流程：{workflow.name}</Typography.Text>
          <Typography.Text>
            {currentProviderLabel} → {nextProviderLabel}
          </Typography.Text>
          <Typography.Text type="secondary">
            切换后会清空当前流程已关联的 Profile 组，需要重新点击“Profile 组”选择新 Provider 下的运行分组。
          </Typography.Text>
        </Space>
      ),
      onOk: async () => {
        try {
          setWorkflowActionLoadingId(workflow.id);
          const workflowYaml = rewriteWorkflowProvider(workflow.workflow_yaml, providerType);
          const saved = await api.updateWorkflow(workflow.id, workflowYaml, workflow.folder);
          if (activeWorkflow?.id === workflow.id) {
            setActiveWorkflow(saved);
            setYamlValue(saved.workflow_yaml);
            setEditorMode("locked");
            setSelectedProviderType(saved.target_provider_type);
            setRunGroupIds([]);
            setSelectedGroupId(null);
            setSelectedProfileId(null);
            resetComposerState();
          }
          if (profileGroupModalWorkflow?.id === workflow.id) {
            setProfileGroupModalWorkflow(null);
            setProfileGroupDraftIds([]);
          }
          if (workflowProviderFilter && workflowProviderFilter !== providerType) {
            setWorkflowProviderFilter(providerType);
          }
          setWorkflowReloadKey((value) => value + 1);
          setGroupReloadKey((value) => value + 1);
          setProfileReloadKey((value) => value + 1);
          setSessionReloadKey((value) => value + 1);
          message.success("流程 Provider 已切换，请重新关联 Profile 组。");
        } catch (cause) {
          message.error(cause instanceof Error ? cause.message : "切换 Provider 失败");
        } finally {
          setWorkflowActionLoadingId(null);
        }
      },
    });
  };

  const handleOpenProfileGroupModal = (workflow: WorkflowRecord) => {
    setProfileGroupModalWorkflow(workflow);
    setProfileGroupDraftIds(workflowRunGroupIds(workflow));
    setProfileGroupModalReloadKey((value) => value + 1);
  };

  const handleSaveProfileGroups = async () => {
    if (!profileGroupModalWorkflow) {
      return;
    }
    try {
      setProfileGroupSaving(true);
      const parsed = (YAML.parse(profileGroupModalWorkflow.workflow_yaml) ?? {}) as WorkflowDraftDocument;
      const cleanedGroupIds = Array.from(new Set(profileGroupDraftIds.map(String).filter(Boolean)));
      applySelectedProfilePolicy(parsed, profileGroupModalWorkflow.target_provider_type, cleanedGroupIds);
      const saved = await api.updateWorkflow(
        profileGroupModalWorkflow.id,
        YAML.stringify(parsed),
        profileGroupModalWorkflow.folder,
      );
      if (activeWorkflow?.id === saved.id) {
        setActiveWorkflow(saved);
        setYamlValue(saved.workflow_yaml);
        setRunGroupIds(workflowRunGroupIds(saved));
      }
      setWorkflowReloadKey((value) => value + 1);
      setProfileGroupModalWorkflow(null);
      setProfileGroupDraftIds([]);
      message.success(cleanedGroupIds.length ? "运行 Profile 组已关联" : "已移除运行 Profile 组，流程将不可启动");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "关联 Profile 组失败");
    } finally {
      setProfileGroupSaving(false);
    }
  };

  const handleDeleteWorkflow = async (workflow: WorkflowRecord) => {
    try {
      await api.deleteWorkflow(workflow.id);
      setWorkflowReloadKey((value) => value + 1);
      if (activeWorkflow?.id === workflow.id) {
        setActiveWorkflow(null);
        setCreatingWorkflow(false);
        setEditorMode("locked");
        setYamlValue(DEFAULT_WORKFLOW);
        setActiveFolder("未分组");
        resetComposerState();
        setRunGroupIds([]);
      }
      if (renamingWorkflowId === workflow.id) {
        cancelRenameWorkflow();
      }
      if (profileGroupModalWorkflow?.id === workflow.id) {
        setProfileGroupModalWorkflow(null);
        setProfileGroupDraftIds([]);
      }
      message.success("流程已删除");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "删除失败");
    }
  };

  const confirmDeleteWorkflow = (workflow: WorkflowRecord) => {
    Modal.confirm({
      title: "删除这个流程？",
      content: "如果流程已被历史批次或定时任务引用，系统会阻止删除。",
      okText: "删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: () => void handleDeleteWorkflow(workflow),
    });
  };

  const handleCancelDraft = () => {
    setActiveWorkflow(null);
    setCreatingWorkflow(false);
    setEditorMode("locked");
    setYamlValue(DEFAULT_WORKFLOW);
    resetComposerState();
    setRunGroupIds([]);
    message.info("已取消当前未保存流程草稿");
  };

  const handleExportWorkflow = (workflow?: WorkflowRecord | null) => {
    if (workflow === undefined && !activeWorkflow && !creatingWorkflow) {
      message.warning("请先选择或保存一个流程");
      return;
    }
    const exportingCurrentDraft = workflow === undefined;
    const name = exportingCurrentDraft
      ? activeWorkflow?.name ?? workflowNameFromYaml(yamlValue, "未保存流程")
      : workflow?.name ?? workflowNameFromYaml(yamlValue, "未保存流程");
    const folder = exportingCurrentDraft ? activeFolder : workflow?.folder ?? activeFolder;
    const providerType = exportingCurrentDraft
      ? selectedProviderType || providerTypeFromYaml(yamlValue)
      : workflow?.target_provider_type ?? providerTypeFromYaml(yamlValue, selectedProviderType);
    const workflowYaml = exportingCurrentDraft ? yamlValue : workflow?.workflow_yaml ?? yamlValue;
    const bundle: WorkflowExportBundle = {
      schema_version: "opcontroller.workflow.v1",
      exported_at: new Date().toISOString(),
      name,
      folder,
      provider_type: providerType,
      workflow_yaml: workflowYaml,
    };
    downloadTextFile(`${safeFileName(name, "workflow")}.opflow.json`, JSON.stringify(bundle, null, 2), "application/json");
    message.success("流程已导出");
  };

  const handleImportWorkflowFile = async (file: File) => {
    try {
      setImportingWorkflow(true);
      const text = await file.text();
      const bundle = JSON.parse(text) as Partial<WorkflowExportBundle>;
      if (bundle.schema_version !== "opcontroller.workflow.v1" || typeof bundle.workflow_yaml !== "string") {
        throw new Error("不是有效的 OpController 流程文件");
      }
      const validation = await api.validateWorkflow("import", bundle.workflow_yaml);
      if (!validation.valid) {
        throw new Error(validation.errors?.join("\n") || "导入流程校验失败");
      }
      const targetFolder = typeof bundle.folder === "string" && bundle.folder.trim()
        ? bundle.folder.trim()
        : activeFolder || "未分组";
      await ensureWorkflowFolder(targetFolder);

      const importedName = typeof bundle.name === "string" && bundle.name.trim()
        ? bundle.name.trim()
        : workflowNameFromYaml(bundle.workflow_yaml);
      const existingNames = new Set((workflows.data ?? []).map((workflow) => workflow.name));
      const importSuffix = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
      const finalName = existingNames.has(importedName)
        ? `${importedName} 导入 ${importSuffix}`
        : importedName;
      const workflowYaml = finalName === importedName
        ? bundle.workflow_yaml
        : rewriteWorkflowName(bundle.workflow_yaml, finalName);
      const created = await api.createWorkflow(workflowYaml, targetFolder);
      setWorkflowReloadKey((value) => value + 1);
      setFolderReloadKey((value) => value + 1);
      setWorkflowFolderFilter(targetFolder);
      setActiveWorkflow(created);
      setCreatingWorkflow(false);
      setEditorMode("locked");
      setActiveFolder(created.folder || targetFolder);
      setYamlValue(created.workflow_yaml);
      resetComposerState();
      message.success(`已导入流程：${created.name}，点击“编排”后可修改。`);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "导入流程失败");
    } finally {
      setImportingWorkflow(false);
      if (importInputRef.current) {
        importInputRef.current.value = "";
      }
    }
  };

  const handleSyncProfiles = async () => {
    setSessionActionLoading(true);
    try {
      await api.syncProfiles(selectedProviderType);
      setProfileReloadKey((value) => value + 1);
      setGroupReloadKey((value) => value + 1);
      message.success("分组和测试 Profile 列表已刷新");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "同步 Profile 失败");
    } finally {
      setSessionActionLoading(false);
    }
  };

  const handleOpenTestProfile = async () => {
    if (!selectedProfileId) {
      message.warning("先选择一个测试 Profile");
      return;
    }
    setSessionActionLoading(true);
    try {
      await api.openTestProfile(selectedProviderType, selectedProfileId);
      setSessionReloadKey((value) => value + 1);
      message.success("测试 Profile 已打开，现在可以做真实页面验证了");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "打开测试 Profile 失败");
    } finally {
      setSessionActionLoading(false);
    }
  };

  const handleCloseTestProfile = async () => {
    if (!selectedProfileId) {
      return;
    }
    setSessionActionLoading(true);
    try {
      await api.closeTestProfile(selectedProviderType, selectedProfileId);
      setSessionReloadKey((value) => value + 1);
      message.success("测试 Profile 已关闭");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "关闭测试 Profile 失败");
    } finally {
      setSessionActionLoading(false);
    }
  };

  const handleValidate = async () => {
    try {
      const result = await api.validateWorkflow(activeWorkflow?.id ?? "draft", yamlValue);
      if (result.valid) {
        message.success(`校验通过${result.warnings?.length ? `，警告 ${result.warnings.length} 条` : ""}`);
      } else {
        message.error(result.errors?.join("\n") ?? "校验失败");
      }
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "校验失败");
    }
  };

  const handleSave = async (options?: { silent?: boolean }) => {
    if (!activeWorkflow && !creatingWorkflow) {
      message.warning("请先选择一个流程，或点击新建流程开始编排。");
      return null;
    }
    if (!isWorkflowEditable) {
      message.info("当前流程画布已锁定，请先点击“编排”再保存修改。");
      return null;
    }
    try {
      const parsed = (YAML.parse(yamlValue) ?? {}) as WorkflowDraftDocument;
      applySelectedProfilePolicy(parsed, selectedProviderType, runGroupIds);
      const workflowYaml = YAML.stringify(parsed);
      const saved = activeWorkflow
        ? await api.updateWorkflow(activeWorkflow.id, workflowYaml, activeFolder)
        : await api.createWorkflow(workflowYaml, activeFolder);
      setActiveWorkflow(saved);
      setCreatingWorkflow(false);
      setActiveFolder(saved.folder || activeFolder);
      setYamlValue(saved.workflow_yaml);
      setWorkflowReloadKey((value) => value + 1);
      setFolderReloadKey((value) => value + 1);
      if (!options?.silent) {
        message.success("流程模板已保存");
      }
      return saved;
    } catch (cause) {
      const errorMessage = cause instanceof Error ? cause.message : "保存失败";
      if (activeWorkflow && /workflow not found|404/i.test(errorMessage)) {
        setActiveWorkflow(null);
        setCreatingWorkflow(true);
        message.warning("当前流程已被删除，已转为未保存草稿，请确认后重新保存。");
        return null;
      }
      message.error(errorMessage);
      return null;
    }
  };

  const handleLockEditor = () => {
    if (!isWorkflowEditable) {
      return;
    }
    if (!hasUnsavedWorkflowChanges) {
      setEditorMode("locked");
      resetComposerState();
      message.info("流程画布已锁定。");
      return;
    }
    Modal.confirm({
      title: "保存后锁定画布？",
      okText: "保存并锁定",
      cancelText: "继续编排",
      content: "当前流程还有未保存修改。保存后会回到只读锁定状态。",
      onOk: async () => {
        const saved = await handleSave({ silent: true });
        if (saved) {
          setEditorMode("locked");
          resetComposerState();
          message.success("流程已保存并锁定。");
        }
      },
    });
  };

  const completePendingWorkflowSwitch = (workflow: WorkflowRecord, mode: WorkflowOpenMode) => {
    loadWorkflowIntoCanvas(workflow, mode);
    setPendingWorkflowSwitch(null);
  };

  const handleDiscardAndSwitchWorkflow = () => {
    if (!pendingWorkflowSwitch) {
      return;
    }
    completePendingWorkflowSwitch(pendingWorkflowSwitch.workflow, pendingWorkflowSwitch.mode);
    message.info(
      pendingWorkflowSwitch.mode === "edit"
        ? "已放弃当前修改，并进入新流程编排。"
        : "已放弃当前修改，并切换到新流程预览。",
    );
  };

  const handleSaveAndSwitchWorkflow = async () => {
    if (!pendingWorkflowSwitch) {
      return;
    }
    try {
      setPendingSwitchSaving(true);
      const saved = await handleSave({ silent: true });
      if (!saved) {
        return;
      }
      completePendingWorkflowSwitch(pendingWorkflowSwitch.workflow, pendingWorkflowSwitch.mode);
      message.success(
        pendingWorkflowSwitch.mode === "edit"
          ? "当前流程已保存，并已进入新流程编排。"
          : "当前流程已保存，并已切换到新流程预览。",
      );
    } finally {
      setPendingSwitchSaving(false);
    }
  };

  const handleDiscardAndCreateWorkflow = () => {
    if (activeWorkflow && !creatingWorkflow) {
      loadWorkflowIntoCanvas(activeWorkflow, "preview");
    } else {
      setActiveWorkflow(null);
      setCreatingWorkflow(false);
      setEditorMode("locked");
      setYamlValue(DEFAULT_WORKFLOW);
      setRunGroupIds([]);
      setSelectedGroupId(null);
      setSelectedProfileId(null);
      resetComposerState();
    }
    setPendingNewWorkflowOpen(false);
    openNewWorkflowGuide();
    message.info("已放弃当前编辑，开始新建流程。");
  };

  const handleSaveAndCreateWorkflow = async () => {
    try {
      setPendingNewWorkflowSaving(true);
      const saved = await handleSave({ silent: true });
      if (!saved) {
        return;
      }
      loadWorkflowIntoCanvas(saved, "preview");
      setPendingNewWorkflowOpen(false);
      openNewWorkflowGuide();
      message.success("当前流程已保存，可以开始新建流程。");
    } finally {
      setPendingNewWorkflowSaving(false);
    }
  };

  const handleLocatorValidate = async (values: StepComposerValues) => {
    const result = await api.validateLocator(buildLocatorPayload(values));
    const preview: LocatorPreview = {
      valid: result.valid,
      warnings: result.warnings,
      uniqueness_score: result.uniqueness_score,
      stability_score: result.stability_score,
      locator: result.locator,
    };
    if (selectedSession && selectedProfileId) {
      try {
        const live = await api.previewLocatorLive({
          provider_type: selectedProviderType,
          external_profile_id: selectedProfileId,
          locator: result.locator,
        });
        preview.live_preview = live;
      } catch (cause) {
        preview.warnings = [
          ...preview.warnings,
          cause instanceof Error ? `真实页面验证失败: ${cause.message}` : "真实页面验证失败",
        ];
      }
    }
    return preview;
  };

  const handleLocatorPick = async (values: StepComposerValues): Promise<LocatorPickResult> => {
    if (!selectedProfileId || !selectedSession) {
      throw new Error("请先打开一个测试 Profile，再从页面点选元素");
    }
    return api.pickLocatorOnce({
      provider_type: selectedProviderType,
      external_profile_id: selectedProfileId,
      timeout_sec: values.timeoutSec ?? 30,
    });
  };

  const handlePreviewStep = async (
    values: StepComposerValues,
    locatorPreview: LocatorPreview | null,
  ): Promise<StepLivePreviewResult> => {
    if (!selectedCard) {
      throw new Error("当前没有选中的动作卡片");
    }
    if (!selectedProfileId || !selectedSession) {
      throw new Error("请先打开一个测试 Profile，再执行单步试跑");
    }
      const stepPayload = buildStepPayload(selectedCard, values, {
      stepId: `${selectedCard.type}-preview`,
      selectorKey: stepRequiresLocator(selectedCard.type, values) ? "preview_locator" : undefined,
    });
    return api.previewWorkflowStep({
      provider_type: selectedProviderType,
      external_profile_id: selectedProfileId,
      step: stepPayload,
      locator: locatorPreview?.locator ?? null,
      row_payload: {
        keyword: "Bags",
        status: "enabled",
      },
    });
  };

  const handleDryRunWorkflow = async () => {
    if (!selectedProfileId || !selectedSession) {
      message.warning("请先打开一个测试 Profile，再做整条流程试运行。");
      return;
    }
    if (!workflowDraft) {
      message.error("当前 YAML 结构不可解析，先修复高级视图里的语法。");
      return;
    }
    try {
      setDryRunLoading(true);
      setDryRunResult(null);
      const result = await api.dryRunWorkflow(activeWorkflow?.id ?? "draft", {
        provider_type: selectedProviderType,
        external_profile_id: selectedProfileId,
        workflow_yaml: yamlValue,
        stop_on_failure: true,
        row_payload: {
          search_keyword: "Bags",
          keyword: "Bags",
          status: "enabled",
        },
      });
      setDryRunResult(result);
      if (result.success) {
        message.success(`整条流程试运行成功：${result.succeeded_steps}/${result.total_steps} 步通过`);
      } else {
        message.error(result.error_message ?? "整条流程试运行失败，请查看步骤时间线。");
      }
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "整条流程试运行失败");
    } finally {
      setDryRunLoading(false);
    }
  };

  const handleStepConfigured = async (values: StepComposerValues, locatorPreview: LocatorPreview | null) => {
    if (!ensureWorkflowEditable()) {
      throw new Error("当前流程画布已锁定，请先点击“编排”再修改节点。");
    }
    if (!selectedCard) {
      throw new Error("当前没有选中的动作卡片");
    }
    try {
      const parsed = (YAML.parse(yamlValue) ?? {}) as WorkflowDraftDocument;
      applySelectedProfilePolicy(parsed, selectedProviderType, runGroupIds);
      parsed.steps = parsed.steps ?? [];
      parsed.locators = parsed.locators ?? {};
      const editIndex = editingStepIndex;
      const insertAfterIndex = insertAfterStepIndex;
      const existingStep = editIndex === null ? null : parsed.steps[editIndex];
      const nextIndex = editIndex !== null && existingStep
        ? editIndex + 1
        : nextOrdinal(parsed.steps, parsed.locators, selectedCard.type);
      const nextStep = buildStepPayload(selectedCard, values, {
        stepId: existingStep?.id ?? buildStepId(selectedCard.type, nextIndex),
      });

      if (stepRequiresLocator(selectedCard.type, values)) {
        if (!locatorPreview) {
          throw new Error("请先生成定位规则，再保存这个动作。");
        }
        const selectorKey = existingStep?.selector_key ?? buildSelectorKey(selectedCard.type, nextIndex);
        nextStep.selector_key = selectorKey;
        parsed.locators[selectorKey] = locatorPreview.locator;
      }

      if (editIndex === null) {
        if (insertAfterIndex !== null && parsed.steps[insertAfterIndex]) {
          parsed.steps.splice(insertAfterIndex + 1, 0, nextStep as WorkflowDraftStep);
        } else {
          parsed.steps.push(nextStep as WorkflowDraftStep);
        }
      } else {
        if (!existingStep) {
          throw new Error("找不到要更新的步骤");
        }
        parsed.steps[editIndex] = nextStep as WorkflowDraftStep;
      }
      pruneUnusedLocators(parsed);
      setYamlValue(YAML.stringify(parsed));
      setSelectedCard(null);
      setEditingStepIndex(null);
      setInsertAfterStepIndex(null);
      message.success(
        editIndex === null
          ? insertAfterIndex !== null
            ? "步骤已插入到指定位置，后续步骤已自动顺延。"
            : "步骤已写入流程，系统也已经把元素定位规则写进 YAML。"
          : "步骤已更新，参数和定位规则已经同步到 YAML。",
      );
    } catch (cause) {
      throw new Error(cause instanceof Error ? cause.message : "步骤配置失败");
    }
  };

  const editingStep = editingStepIndex === null ? null : draftSteps[editingStepIndex] ?? null;
  const insertAfterStep = insertAfterStepIndex === null ? null : draftSteps[insertAfterStepIndex] ?? null;
  const editingLocator = editingStep?.selector_key ? draftLocators[editingStep.selector_key] : null;
  const composerInitialValues = useMemo(
    () =>
      editingStep && selectedCard
        ? stepToComposerValues(editingStep, selectedCard, editingLocator)
        : null,
    [editingLocator, editingStep, selectedCard],
  );
  const composerInitialLocatorPreview = useMemo(
    () => locatorToInitialPreview(editingLocator),
    [editingLocator],
  );

  const activeWorkflowName = activeWorkflow?.name ?? (creatingWorkflow ? workflowNameFromYaml(yamlValue, "未保存流程") : "请选择或新建流程");
  const editorStatusText = creatingWorkflow
    ? "草稿编排中"
    : activeWorkflow
      ? isWorkflowEditable
        ? `编排中：${activeWorkflow.name}`
        : `只读查看：${activeWorkflow.name}`
      : "未选择流程";
  const canExportCurrentWorkflow = Boolean(activeWorkflow || creatingWorkflow);
  const workflowTableColumns: TableColumnsType<WorkflowRecord> = [
      {
        title: "流程名称",
        dataIndex: "name",
        key: "name",
        width: 340,
        render: (_, item) => (
          <div className="workflow-table-name">
            {renamingWorkflowId === item.id ? (
              <Space.Compact style={{ width: "100%" }}>
                <Input
                  size="small"
                  value={renamingWorkflowValue}
                  onChange={(event) => setRenamingWorkflowValue(event.target.value)}
                  onPressEnter={() => void handleRenameWorkflow(item)}
                />
                <Button
                  size="small"
                  type="primary"
                  icon={<Check size={13} />}
                  loading={workflowActionLoadingId === item.id}
                  onClick={() => void handleRenameWorkflow(item)}
                />
                <Button size="small" icon={<X size={13} />} onClick={cancelRenameWorkflow} />
              </Space.Compact>
            ) : (
              <>
                <div className="workflow-table-name__row">
                  <Button type="link" className="workflow-table-name__link" onClick={() => handleOpenWorkflow(item, "preview")}>
                    {item.name}
                  </Button>
                  <Button
                    size="small"
                    type="text"
                    icon={<Pencil size={13} />}
                    onClick={() => startRenameWorkflow(item)}
                  />
                </div>
                {item.description ? (
                  <Typography.Text className="workflow-table-description" type="secondary">
                    {item.description}
                  </Typography.Text>
                ) : null}
              </>
            )}
          </div>
        ),
      },
      {
        title: "流程分组",
        dataIndex: "folder",
        key: "folder",
        width: 180,
        render: (_, item) => (
          <Select
            size="small"
            showSearch
            optionFilterProp="label"
            style={{ width: "100%" }}
            value={item.folder || "未分组"}
            options={folderOptions}
            loading={workflowActionLoadingId === item.id}
            onChange={(value) => void handleMoveWorkflowFolder(item, value)}
          />
        ),
      },
      {
        title: "Provider",
        dataIndex: "target_provider_type",
        key: "provider",
        width: 170,
        render: (value: string, item) => (
          <Select
            size="small"
            style={{ width: "100%" }}
            value={value}
            options={providerOptions}
            loading={workflowActionLoadingId === item.id}
            disabled={workflowActionLoadingId === item.id}
            onChange={(nextProviderType) => handleSwitchWorkflowProvider(item, nextProviderType)}
          />
        ),
      },
      {
        title: "Profile 组状态",
        key: "profile_groups",
        width: 260,
        render: (_, item) => {
          const bindingStatus = workflowProfileBindingStatus(item);
          return (
            <Space direction="vertical" size={2} className="workflow-table-profile">
              <StatusBadge
                status={bindingStatus.usable ? "configured" : "unbound"}
                tone={bindingStatus.usable && bindingStatus.profileCount === null ? "info" : undefined}
                label={bindingStatus.label}
              />
              <Typography.Text type="secondary">{bindingStatus.detail}</Typography.Text>
            </Space>
          );
        },
      },
      {
        title: "类型",
        dataIndex: "is_builtin",
        key: "type",
        width: 90,
        render: (value: boolean) => <Tag>{value ? "内置" : "自定义"}</Tag>,
      },
      {
        title: "操作",
        key: "actions",
        width: 168,
        fixed: "right",
        render: (_, item) => (
          <TableActionMenu
            loading={workflowActionLoadingId === item.id}
            primary={{
              key: "edit",
              label: activeWorkflow?.id === item.id && editorMode === "editing" ? "编排中" : "编排",
              disabled: activeWorkflow?.id === item.id && editorMode === "editing",
              onClick: () => handleOpenWorkflow(item, "edit"),
            }}
            actions={[
              {
                key: "profile-groups",
                label: "Profile 组",
                icon: <Link2 size={14} />,
                onClick: () => handleOpenProfileGroupModal(item),
              },
              {
                key: "export",
                label: "导出",
                icon: <Download size={14} />,
                onClick: () => handleExportWorkflow(item),
              },
              {
                key: "duplicate",
                label: "复制",
                icon: <Copy size={14} />,
                onClick: () => void handleDuplicateWorkflow(item),
              },
              {
                key: "delete",
                label: "删除",
                icon: <Trash2 size={14} />,
                danger: true,
                onClick: () => confirmDeleteWorkflow(item),
              },
            ]}
          />
        ),
      },
    ];
  const testSessionPanel = (
    <Space direction="vertical" size={14} style={{ width: "100%" }}>
      <div className="workflow-panel-heading">
        <div>
          <Typography.Text className="section-eyebrow">测试会话</Typography.Text>
          <Typography.Title level={5} style={{ margin: 0 }}>
            {selectedSession ? "已连接测试窗口" : "选择窗口并打开"}
          </Typography.Title>
        </div>
        <StatusBadge status={selectedSession ? "attachable" : "unbound"} label={selectedSession ? "已就绪" : "未连接"} />
      </div>
      <Alert
        type={selectedSession ? "success" : "info"}
        showIcon
        message={selectedSession ? "测试 Profile 已就绪" : "先打开一个测试 Profile"}
        description={
          selectedSession
            ? selectedProfile?.display_name ?? selectedProfileId
            : "打开后进入目标页面，再从左侧添加动作并做单步试跑。"
        }
      />
      {groups.error ? (
        <Alert type="warning" showIcon message="分组读取失败" description={groups.error} />
      ) : null}
      <div className="workflow-field">
        <Typography.Text type="secondary">Provider</Typography.Text>
        <Select
          style={{ width: "100%" }}
          value={selectedProviderType}
          options={providerOptions}
          disabled={!isWorkflowEditable}
          onChange={(value) => {
            setSelectedProviderType(value);
            setSelectedGroupId(null);
            setSelectedProfileId(null);
            setRunGroupIds([]);
            setGroupReloadKey((current) => current + 1);
            setProfileReloadKey((current) => current + 1);
            setSessionReloadKey((current) => current + 1);
          }}
        />
      </div>
      <div className="workflow-field">
        <Typography.Text type="secondary">指纹浏览器分组</Typography.Text>
        <Select
          showSearch
          optionFilterProp="label"
          style={{ width: "100%" }}
          value={selectedGroupId ?? "__all__"}
          options={groupOptions}
          onChange={(value) => {
            setSelectedGroupId(value === "__all__" ? null : value);
            setSelectedProfileId(null);
          }}
        />
      </div>
      <div className="workflow-field">
        <Typography.Text type="secondary">测试窗口 / Profile</Typography.Text>
        <Select
          showSearch
          optionFilterProp="label"
          style={{ width: "100%" }}
          value={selectedProfileId ?? undefined}
          options={profileOptions}
          onChange={(value) => setSelectedProfileId(value)}
          placeholder="选择测试 Profile"
        />
      </div>
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <Button block loading={sessionActionLoading} onClick={() => void handleSyncProfiles()}>
          刷新 Profiles
        </Button>
        <Button block type="primary" loading={sessionActionLoading} onClick={() => void handleOpenTestProfile()}>
          打开测试 Profile
        </Button>
        <Button block danger loading={sessionActionLoading} disabled={!selectedSession} onClick={() => void handleCloseTestProfile()}>
          关闭测试 Profile
        </Button>
      </Space>
      <Space wrap>
        <Tag>
          {selectedGroup ? selectedGroup.display_name : "全部分组"}
        </Tag>
        <Tag>Profiles {filteredProfiles.length}</Tag>
        <Tag>会话 {(openedSessions.data ?? []).length}</Tag>
      </Space>
    </Space>
  );

  if (providers.loading || workflows.loading || folders.loading || actionCards.loading || profiles.loading || groups.loading || providerScope.loading || openedSessions.loading) {
    return <Spin size="large" />;
  }

  return (
    <div className="app-page workflows-page">
      <input
        ref={importInputRef}
        type="file"
        accept=".opflow.json,application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void handleImportWorkflowFile(file);
          }
        }}
      />

      <SectionCard
        title="流程工作台"
        extra={
          <Space wrap>
            <Button
              icon={<Upload size={16} />}
              loading={importingWorkflow}
              onClick={() => importInputRef.current?.click()}
            >
              导入流程
            </Button>
            <Button type="primary" icon={<FilePlus2 size={16} />} onClick={handleNewWorkflow}>
              新建流程
            </Button>
          </Space>
        }
      >
        <div className="workflow-library-layout">
          <aside className="workflow-group-rail">
            <div className="workflow-panel-heading">
              <Typography.Text className="section-eyebrow">流程分组</Typography.Text>
              <Tag>{folderRecords.length}</Tag>
            </div>
            <button
              type="button"
              className={`workflow-group-button${workflowFolderFilter === null ? " is-active" : ""}`}
              onClick={() => setWorkflowFolderFilter(null)}
            >
              <span>全部流程</span>
              <small>{(workflows.data ?? []).length} 条</small>
            </button>
            {folderRecords.map((folder) => {
              const isDefaultFolder = folder.name === "未分组";
              const isEditing = editingFolderName === folder.name;
              return (
                <div
                  className={`workflow-group-item${workflowFolderFilter === folder.name ? " is-active" : ""}`}
                  key={folder.name}
                >
                  {isEditing ? (
                    <Space.Compact className="workflow-group-edit">
                      <Input
                        size="small"
                        value={editingFolderValue}
                        onChange={(event) => setEditingFolderValue(event.target.value)}
                        onPressEnter={() => void handleRenameFolder()}
                      />
                      <Button
                        size="small"
                        type="primary"
                        icon={<Check size={13} />}
                        loading={folderActionLoading}
                        onClick={() => void handleRenameFolder()}
                      />
                      <Button size="small" icon={<X size={13} />} onClick={cancelEditFolder} />
                    </Space.Compact>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="workflow-group-button"
                        onClick={() => {
                          setWorkflowFolderFilter(folder.name);
                          setActiveFolder(folder.name);
                        }}
                      >
                        <span>{folder.name}</span>
                        <small>{folder.workflow_count} 条</small>
                      </button>
                      {!isDefaultFolder ? (
                        <Space size={2} className="workflow-group-actions">
                          <Button
                            size="small"
                            type="text"
                            icon={<Pencil size={13} />}
                            onClick={() => startEditFolder(folder.name)}
                          />
                          <Popconfirm
                            title="删除这个流程分组？"
                            description="分组下的流程会移动到未分组，不会删除流程。"
                            okText="删除分组"
                            cancelText="取消"
                            okButtonProps={{ danger: true }}
                            onConfirm={() => void handleDeleteFolder(folder.name)}
                          >
                            <Button
                              size="small"
                              type="text"
                              danger
                              icon={<Trash2 size={13} />}
                              loading={folderActionLoading && editingFolderName === folder.name}
                            />
                          </Popconfirm>
                        </Space>
                      ) : null}
                    </>
                  )}
                </div>
              );
            })}
            <div className="workflow-create-group">
              <Input
                placeholder="新流程分组"
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
                onPressEnter={() => void handleCreateFolder()}
              />
              <Button block icon={<FolderPlus size={15} />} onClick={() => void handleCreateFolder()}>
                创建分组
              </Button>
            </div>
          </aside>

          <main className="workflow-library-main">
            <div className="workflow-library-toolbar">
              <Space wrap>
                <Select
                  allowClear
                  style={{ width: 180 }}
                  value={workflowProviderFilter ?? undefined}
                  options={providerOptions}
                  placeholder="Provider"
                  onChange={(value) => setWorkflowProviderFilter(value ?? null)}
                />
                <Input.Search
                  allowClear
                  style={{ width: 300 }}
                  placeholder="搜索流程名称或描述"
                  value={workflowSearch}
                  onChange={(event) => setWorkflowSearch(event.target.value)}
                />
              </Space>
              <span className={`workflow-editor-state ${isWorkflowEditable ? "is-editing" : "is-locked"}`}>
                {isWorkflowEditable ? <Pencil size={14} /> : <LockKeyhole size={14} />}
                {editorStatusText}
              </span>
            </div>
            <Table<WorkflowRecord>
              className="workflow-record-table"
              rowKey="id"
              size="small"
              dataSource={workflows.data ?? []}
              columns={workflowTableColumns}
              locale={{ emptyText: <Empty description="当前筛选下没有流程" /> }}
              pagination={false}
              scroll={{ x: 1350, y: "100%" }}
              rowClassName={(item) => {
                const bindingStatus = workflowProfileBindingStatus(item);
                const isActiveItem = activeWorkflow?.id === item.id;
                return [
                  "workflow-table-row",
                  isActiveItem ? "is-active" : "",
                  isActiveItem && editorMode === "editing" ? "is-editing" : "",
                  bindingStatus.usable ? "" : "is-unusable",
                ].filter(Boolean).join(" ");
              }}
              onRow={(item) => ({
                onDoubleClick: () => handleOpenWorkflow(item, "preview"),
              })}
            />
          </main>
        </div>
      </SectionCard>

      <SectionCard
        title="流程编排工作台"
        extra={
          <Space wrap>
            <span className={`workflow-editor-state ${isWorkflowEditable ? "is-editing" : "is-locked"}`}>
              {isWorkflowEditable ? <Pencil size={14} /> : <LockKeyhole size={14} />}
              {editorStatusText}
            </span>
            {activeWorkflow && !isWorkflowEditable ? (
              <Button type="primary" icon={<Pencil size={15} />} onClick={() => handleOpenWorkflow(activeWorkflow, "edit")}>
                进入编排
              </Button>
            ) : null}
            {isWorkflowEditable ? (
              <Button icon={<LockKeyhole size={15} />} onClick={handleLockEditor}>
                锁定画布
              </Button>
            ) : null}
            <Select
              showSearch
              optionFilterProp="label"
              style={{ width: 220 }}
              value={activeFolder}
              options={folderOptions}
              disabled={!isWorkflowEditable}
              onChange={setActiveFolder}
            />
            <Button onClick={handleValidate}>校验</Button>
            <Button
              icon={<Download size={15} />}
              disabled={!canExportCurrentWorkflow}
              onClick={() => handleExportWorkflow()}
            >
              导出
            </Button>
            {creatingWorkflow ? (
              <Button danger onClick={handleCancelDraft}>
                取消草稿
              </Button>
            ) : null}
            <Button type="primary" disabled={!isWorkflowEditable || (!activeWorkflow && !creatingWorkflow)} onClick={() => void handleSave()}>
              保存当前流程
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={14} style={{ width: "100%" }}>
          <Tabs
            className="workflow-editor-tabs"
            items={[
              {
                key: "operator",
                label: "运营视图",
                children: (
                  <WorkflowWizard
                    cards={actionCards.data ?? []}
                    steps={draftSteps}
                    locators={draftLocators}
                    workflowName={activeWorkflowName}
                    readOnly={!isWorkflowEditable}
                    canvasActions={
                      <Popconfirm
                        title="全流程测试？"
                        description="会在当前打开的测试 Profile 中按顺序真实执行全部节点。"
                        okText="开始测试"
                        cancelText="取消"
                        onConfirm={() => void handleDryRunWorkflow()}
                      >
                        <Button type="primary" loading={dryRunLoading} disabled={!selectedSession}>
                          全流程测试
                        </Button>
                      </Popconfirm>
                    }
                    testPanel={testSessionPanel}
                    onSelectCard={openStepComposer}
                    onEditStep={handleEditStep}
                    onDeleteStep={handleDeleteStep}
                    onDuplicateStep={handleDuplicateStep}
                    onMoveStep={handleMoveStep}
                  />
                ),
              },
              {
                key: "advanced",
                label: "高级 YAML",
                children: (
                  <Row gutter={[20, 20]} className="workflow-advanced-layout">
                    <Col xs={24} xl={17}>
                      <Suspense fallback={<Spin />}>
                        <MonacoEditor
                          height="100%"
                          defaultLanguage="yaml"
                          value={yamlValue}
                          onChange={(value) => {
                            if (isWorkflowEditable) {
                              setYamlValue(value ?? "");
                            }
                          }}
                          options={{ minimap: { enabled: false }, fontSize: 14, readOnly: !isWorkflowEditable }}
                        />
                      </Suspense>
                    </Col>
                    <Col xs={24} xl={7}>
                      <SectionCard title="高级工具">
                        <Space direction="vertical" size={12} style={{ width: "100%" }}>
                          <Button type="primary" onClick={handleValidate}>
                            校验流程
                          </Button>
                          <Button disabled={!isWorkflowEditable || (!activeWorkflow && !creatingWorkflow)} onClick={() => void handleSave()}>保存当前流程</Button>
                          <Button icon={<Download size={15} />} disabled={!canExportCurrentWorkflow} onClick={() => handleExportWorkflow()}>
                            导出 .opflow.json
                          </Button>
                        </Space>
                      </SectionCard>
                    </Col>
                  </Row>
                ),
              },
            ]}
          />
        </Space>
      </SectionCard>

      <Modal
        title="新建流程前确认"
        open={pendingNewWorkflowOpen}
        onCancel={() => {
          if (!pendingNewWorkflowSaving) {
            setPendingNewWorkflowOpen(false);
          }
        }}
        footer={
          <Space>
            <Button disabled={pendingNewWorkflowSaving} onClick={() => setPendingNewWorkflowOpen(false)}>
              取消
            </Button>
            <Button danger disabled={pendingNewWorkflowSaving} onClick={handleDiscardAndCreateWorkflow}>
              放弃编辑并新建
            </Button>
            <Button type="primary" loading={pendingNewWorkflowSaving} onClick={() => void handleSaveAndCreateWorkflow()}>
              保存当前并新建
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Text>
            当前流程：{creatingWorkflow ? workflowNameFromYaml(yamlValue, "未保存草稿") : activeWorkflow?.name ?? "未选择"}
          </Typography.Text>
          <Alert
            type={hasUnsavedWorkflowChanges ? "warning" : "info"}
            showIcon
            message={hasUnsavedWorkflowChanges ? "当前流程正在编排且有未保存内容" : "当前流程仍处于编排模式"}
            description={
              hasUnsavedWorkflowChanges
                ? "直接新建会离开当前编排上下文。请选择保存当前修改、放弃当前编辑，或取消新建。"
                : "为了避免误操作，新建流程前需要先确认是否结束当前编排。"
            }
          />
        </Space>
      </Modal>

      <Modal
        title="切换流程前确认"
        open={Boolean(pendingWorkflowSwitch)}
        onCancel={() => {
          if (!pendingSwitchSaving) {
            setPendingWorkflowSwitch(null);
          }
        }}
        footer={
          <Space>
            <Button disabled={pendingSwitchSaving} onClick={() => setPendingWorkflowSwitch(null)}>
              取消
            </Button>
            {hasUnsavedWorkflowChanges ? (
              <Button danger disabled={pendingSwitchSaving} onClick={handleDiscardAndSwitchWorkflow}>
                放弃修改并切换
              </Button>
            ) : null}
            <Button
              type="primary"
              loading={pendingSwitchSaving}
              onClick={() => {
                if (hasUnsavedWorkflowChanges) {
                  void handleSaveAndSwitchWorkflow();
                  return;
                }
                if (pendingWorkflowSwitch) {
                  completePendingWorkflowSwitch(pendingWorkflowSwitch.workflow, pendingWorkflowSwitch.mode);
                }
              }}
            >
              {hasUnsavedWorkflowChanges ? "保存并切换" : "确认切换"}
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Text>
            当前流程：{creatingWorkflow ? workflowNameFromYaml(yamlValue, "未保存草稿") : activeWorkflow?.name ?? "未选择"}
          </Typography.Text>
          <Typography.Text>
            目标流程：{pendingWorkflowSwitch?.workflow.name ?? "-"}
          </Typography.Text>
          <Alert
            type={hasUnsavedWorkflowChanges ? "warning" : "info"}
            showIcon
            message={hasUnsavedWorkflowChanges ? "当前流程有未保存修改" : "将切换下方流程画布"}
            description={
              hasUnsavedWorkflowChanges
                ? "请先选择保存当前修改，或放弃修改后再切换。"
                : pendingWorkflowSwitch?.mode === "edit"
                  ? "确认后会进入目标流程的编排模式。"
                  : "确认后会以只读锁定状态查看目标流程。"
            }
          />
        </Space>
      </Modal>

      <Modal
        title="新建流程引导"
        open={newWorkflowModalOpen}
        onCancel={() => setNewWorkflowModalOpen(false)}
        footer={
          <Space>
            <Button disabled={startingWorkflow} onClick={() => setNewWorkflowModalOpen(false)}>
              取消
            </Button>
            <Button disabled={newWorkflowStep === 0 || startingWorkflow} onClick={() => setNewWorkflowStep((step) => Math.max(step - 1, 0))}>
              上一步
            </Button>
            {newWorkflowStep < 2 ? (
              <Button type="primary" onClick={handleNewWorkflowNext}>
                下一步
              </Button>
            ) : (
              <Button type="primary" loading={startingWorkflow} onClick={() => void handleStartNewWorkflow()}>
                开始编排
              </Button>
            )}
          </Space>
        }
      >
        <Space direction="vertical" size={20} style={{ width: "100%" }}>
          <Steps
            current={newWorkflowStep}
            items={[
              { title: "选择分组" },
              { title: "命名流程" },
              { title: "开始编排" },
            ]}
          />
          {newWorkflowStep === 0 ? (
            <Space direction="vertical" size={14} style={{ width: "100%" }}>
              <div className="workflow-field">
                <Typography.Text type="secondary">选择已有流程分组</Typography.Text>
                <Select
                  showSearch
                  optionFilterProp="label"
                  style={{ width: "100%" }}
                  value={newWorkflowFolder}
                  options={folderOptions}
                  onChange={setNewWorkflowFolder}
                />
              </div>
              <div className="workflow-field">
                <Typography.Text type="secondary">或创建一个新流程分组</Typography.Text>
                <Space.Compact style={{ width: "100%" }}>
                  <Input
                    placeholder="例如：Poshmark 日常运营"
                    value={newWorkflowFolderInput}
                    onChange={(event) => setNewWorkflowFolderInput(event.target.value)}
                    onPressEnter={handleUseNewWorkflowFolder}
                  />
                  <Button onClick={handleUseNewWorkflowFolder}>使用新分组</Button>
                </Space.Compact>
              </div>
            </Space>
          ) : null}
          {newWorkflowStep === 1 ? (
            <Space direction="vertical" size={14} style={{ width: "100%" }}>
              <div className="workflow-field">
                <Typography.Text type="secondary">流程名称</Typography.Text>
                <Input
                  value={newWorkflowName}
                  onChange={(event) => setNewWorkflowName(event.target.value)}
                  placeholder="例如：筛选 Bags 并进入详情"
                />
              </div>
              <div className="workflow-field">
                <Typography.Text type="secondary">Provider</Typography.Text>
                <Select
                  style={{ width: "100%" }}
                  value={newWorkflowProviderType}
                  options={providerOptions}
                  onChange={setNewWorkflowProviderType}
                />
              </div>
            </Space>
          ) : null}
          {newWorkflowStep === 2 ? (
            <div className="workflow-new-summary">
              <Typography.Text className="section-eyebrow">即将创建草稿</Typography.Text>
              <Typography.Title level={4}>{newWorkflowName || "未命名流程"}</Typography.Title>
              <Space wrap>
                <Tag>{newWorkflowFolder || "未分组"}</Tag>
                <Tag>{newWorkflowProviderType}</Tag>
              </Space>
            </div>
          ) : null}
        </Space>
      </Modal>

      <Modal
        title="关联运行 Profile 组"
        open={Boolean(profileGroupModalWorkflow)}
        onCancel={() => {
          if (profileGroupSaving) {
            return;
          }
          setProfileGroupModalWorkflow(null);
          setProfileGroupDraftIds([]);
        }}
        okText="保存关联"
        cancelText="取消"
        confirmLoading={profileGroupSaving}
        onOk={() => void handleSaveProfileGroups()}
      >
        <Space direction="vertical" size={14} style={{ width: "100%" }}>
          <Alert
            type={profileGroupDraftIds.length ? "info" : "warning"}
            showIcon
            message={profileGroupDraftIds.length ? "这些 Profile 组会作为批次/定时的运行池" : "未关联 Profile 组时，流程无法启动批次或定时"}
            description={
              profileGroupModalWorkflow
                ? `流程：${profileGroupModalWorkflow.name}；Provider：${profileGroupModalWorkflow.target_provider_type}`
                : undefined
            }
          />
          {profileGroupModalGroups.error || profileGroupModalScope.error ? (
            <Alert
              type="warning"
              showIcon
              message="Provider 管理范围读取失败"
              description={profileGroupModalGroups.error ?? profileGroupModalScope.error}
            />
          ) : null}
          <div className="workflow-field">
            <Typography.Text type="secondary">只展示 Provider 管理范围内的 Profile 组</Typography.Text>
            <Select
              mode="multiple"
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: "100%" }}
              loading={profileGroupModalGroups.loading || profileGroupModalScope.loading}
              disabled={profileGroupModalGroups.loading || profileGroupModalScope.loading}
              value={profileGroupDraftIds}
              options={modalGroupOptions}
              placeholder="选择一个或多个已加白的指纹浏览器分组"
              onChange={(values) => setProfileGroupDraftIds(values)}
            />
          </div>
          <Space wrap>
            <Tag color={profileGroupDraftIds.length ? "default" : "red"}>
              已选 {profileGroupDraftIds.length} 组
            </Tag>
            <Tag color={modalProfileCount > 0 ? "green" : "red"}>
              命中 {modalProfileCount} Profiles
            </Tag>
            <Button
              size="small"
              onClick={() => setProfileGroupModalReloadKey((value) => value + 1)}
            >
              刷新分组
            </Button>
          </Space>
        </Space>
      </Modal>

      <Drawer
        title="整条流程试运行结果"
        width={860}
        open={Boolean(dryRunResult)}
        onClose={() => setDryRunResult(null)}
      >
        {dryRunResult ? (
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Alert
              type={dryRunResult.success ? "success" : "error"}
              showIcon
              message={
                dryRunResult.success
                  ? `试运行成功：${dryRunResult.succeeded_steps}/${dryRunResult.total_steps} 步通过`
                  : `试运行失败：${dryRunResult.succeeded_steps}/${dryRunResult.total_steps} 步通过`
              }
              description={
                dryRunResult.error_message
                  ? `${dryRunResult.error_code ?? "error"}: ${dryRunResult.error_message}`
                  : `总耗时 ${Math.round(dryRunResult.elapsed_ms / 1000)} 秒，当前页面 ${dryRunResult.current_url ?? "--"}`
              }
            />
            <Space wrap>
              <StatusBadge
                status={dryRunResult.success ? "success" : "failed"}
                label={dryRunResult.success ? "全部通过" : "存在失败"}
              />
              <Tag>成功 {dryRunResult.succeeded_steps}</Tag>
              <Tag color="red">失败 {dryRunResult.failed_steps}</Tag>
              <Tag>耗时 {dryRunResult.elapsed_ms}ms</Tag>
            </Space>
            <Table
              rowKey="step_id"
              dataSource={dryRunResult.steps}
              pagination={false}
              expandable={{
                expandedRowRender: (step) => (
                  <Space direction="vertical" size={8} style={{ width: "100%" }}>
                    <Typography.Text type="secondary">当前 URL: {step.current_url ?? "--"}</Typography.Text>
	                    {step.error_message ? (
	                      <Alert
	                        type={isAmbiguousClickStep(step) ? "warning" : "error"}
	                        showIcon
	                        message={step.error_code ?? "步骤失败"}
	                        description={
	                          isAmbiguousClickStep(step)
	                            ? `${step.error_message}。这个节点命中了多个商品/图片，如果业务允许“随机打开一个商品详情”，建议改为随机点击 1 个。`
	                            : step.error_message
	                        }
	                        action={
	                          isAmbiguousClickStep(step) ? (
	                            <Button size="small" type="primary" onClick={() => handleConvertStepToRandomClick(step.step_id)}>
	                              改为随机点击 1 个
	                            </Button>
	                          ) : undefined
	                        }
	                      />
	                    ) : null}
                    <pre className="payload-preview">
                      {JSON.stringify(
                        {
                          outputs: step.outputs,
                          selector_used: step.selector_used,
                          locator_count: step.locator_count,
                          matched_texts: step.matched_texts,
                          artifact_path: step.artifact_path,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </Space>
                ),
              }}
              columns={[
                { title: "步骤", render: (_, step, index) => `#${index + 1} ${step.label || step.step_id}` },
                {
                  title: "状态",
                  dataIndex: "status",
                  width: 110,
                  render: (value: string) => <StatusBadge status={value} />,
                },
                { title: "动作", dataIndex: "action_type", width: 120 },
                { title: "耗时", dataIndex: "elapsed_ms", width: 110, render: (value: number) => `${value}ms` },
                { title: "命中数", dataIndex: "locator_count", width: 96 },
	                {
	                  title: "错误",
	                  render: (_, step) =>
	                    step.error_message ? (
	                      <Space direction="vertical" size={6}>
	                        <Typography.Text type={isAmbiguousClickStep(step) ? "warning" : "danger"}>
	                          {step.error_message}
	                        </Typography.Text>
	                        {isAmbiguousClickStep(step) ? (
	                          <Button size="small" type="link" onClick={() => handleConvertStepToRandomClick(step.step_id)}>
	                            改为随机点击 1 个
	                          </Button>
	                        ) : null}
	                      </Space>
	                    ) : (
	                      <Typography.Text type="secondary">--</Typography.Text>
	                    ),
	                },
	              ]}
            />
          </Space>
        ) : null}
      </Drawer>

      <WorkflowStepComposer
        open={Boolean(selectedCard)}
        card={selectedCard}
        mode={editingStepIndex !== null ? "edit" : insertAfterStepIndex !== null ? "insert" : "create"}
        insertAfterLabel={
          insertAfterStep ? `第 ${insertAfterStepIndex! + 1} 步「${insertAfterStep.label || insertAfterStep.id}」` : null
        }
        initialValues={composerInitialValues}
        initialLocatorPreview={composerInitialLocatorPreview}
        testSessionLabel={selectedProfile ? `${selectedProfile.display_name} (#${selectedProfile.external_profile_id})` : null}
        previewAvailable={Boolean(selectedSession)}
        onCancel={() => {
          setSelectedCard(null);
          setEditingStepIndex(null);
          setInsertAfterStepIndex(null);
        }}
        validateLocator={handleLocatorValidate}
        pickLocator={handleLocatorPick}
        onPreviewStep={handlePreviewStep}
        onSubmit={handleStepConfigured}
      />
    </div>
  );
}
