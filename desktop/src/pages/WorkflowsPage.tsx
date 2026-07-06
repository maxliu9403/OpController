import Editor from "@monaco-editor/react";
import { Alert, Button, Col, Drawer, Input, Popconfirm, Row, Select, Space, Spin, Table, Tabs, Tag, Typography, message } from "antd";
import { Copy, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import YAML from "yaml";
import { api } from "../api/client";
import { SectionCard } from "../components/SectionCard";
import {
  type LocatorPreview,
  type StepComposerValues,
  WorkflowStepComposer,
} from "../components/WorkflowStepComposer";
import { type WorkflowDraftStep, WorkflowWizard } from "../components/WorkflowWizard";
import { usePolling } from "../hooks/usePolling";
import type {
  LocatorPickResult,
  StepLivePreviewResult,
  WorkflowActionCard,
  WorkflowDryRunStepResult,
  WorkflowDryRunResult,
  WorkflowFolderRecord,
  WorkflowRecord,
} from "../types";

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

function statusColor(status: string) {
  if (status === "succeeded" || status === "completed") {
    return "green";
  }
  if (status === "failed" || status === "error") {
    return "red";
  }
  return "gold";
}

function isAmbiguousClickStep(step: WorkflowDryRunStepResult) {
  return step.action_type === "click" && step.error_code === "locator_ambiguous";
}

function profileGroupId(profile: { group_summary?: { id?: string | number | null } }) {
  const raw = profile.group_summary?.id;
  return raw === null || raw === undefined || raw === "" ? "__ungrouped__" : String(raw);
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
  groupId: string | null,
  profileId: string | null,
) {
  parsed.profile_policy = parsed.profile_policy ?? {};
  parsed.profile_policy.provider_type = providerType;
  if (groupId) {
    parsed.profile_policy.selection_mode = "by_group";
    parsed.profile_policy.group_ids = [groupId];
    parsed.profile_policy.profile_ids = profileId ? [profileId] : [];
    return;
  }
  parsed.profile_policy.selection_mode = profileId ? "explicit_profiles" : "all_profiles";
  parsed.profile_policy.group_ids = [];
  parsed.profile_policy.profile_ids = profileId ? [profileId] : [];
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
  const providers = usePolling(api.listProviders, 12000);
  const actionCards = usePolling(api.listActionCards, 12000);
  const [workflowReloadKey, setWorkflowReloadKey] = useState(0);
  const [folderReloadKey, setFolderReloadKey] = useState(0);
  const [workflowFolderFilter, setWorkflowFolderFilter] = useState<string | null>(null);
  const [workflowProviderFilter, setWorkflowProviderFilter] = useState<string | null>(null);
  const [workflowSearch, setWorkflowSearch] = useState("");
  const [activeFolder, setActiveFolder] = useState("未分组");
  const [creatingWorkflow, setCreatingWorkflow] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [activeWorkflow, setActiveWorkflow] = useState<WorkflowRecord | null>(null);
  const [yamlValue, setYamlValue] = useState(DEFAULT_WORKFLOW);
  const [selectedCard, setSelectedCard] = useState<WorkflowActionCard | null>(null);
  const [editingStepIndex, setEditingStepIndex] = useState<number | null>(null);
  const [insertAfterStepIndex, setInsertAfterStepIndex] = useState<number | null>(null);
  const [selectedProviderType, setSelectedProviderType] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [profileReloadKey, setProfileReloadKey] = useState(0);
  const [groupReloadKey, setGroupReloadKey] = useState(0);
  const [sessionReloadKey, setSessionReloadKey] = useState(0);
  const [sessionActionLoading, setSessionActionLoading] = useState(false);
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<WorkflowDryRunResult | null>(null);

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
  const sessionsFetcher = useCallback(
    () => (selectedProviderType ? api.listProviderSessions(selectedProviderType) : Promise.resolve([])),
    [selectedProviderType, sessionReloadKey],
  );
  const workflows = usePolling(workflowsFetcher, 12000);
  const folders = usePolling(foldersFetcher, 12000);
  const profiles = usePolling(profilesFetcher, 10000);
  const groups = usePolling(groupsFetcher, 10000);
  const openedSessions = usePolling(sessionsFetcher, 6000);

  useEffect(() => {
    if (!selectedProviderType && providers.data?.length) {
      setSelectedProviderType(providers.data[0].provider_type);
    }
  }, [providers.data, selectedProviderType]);

  useEffect(() => {
    if (!activeWorkflow && !creatingWorkflow && workflows.data?.length) {
      setActiveWorkflow(workflows.data[0]);
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
        setSelectedGroupId(groupIds[0] === undefined ? null : String(groupIds[0]));
        setSelectedProfileId(profileIds[0] === undefined ? null : String(profileIds[0]));
      } catch {
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

  const folderOptions = useMemo(
    () =>
      (folders.data?.length ? folders.data : [{ name: "未分组", workflow_count: 0 } as WorkflowFolderRecord])
        .map((folder) => ({
          value: folder.name,
          label: `${folder.name} (${folder.workflow_count})`,
        })),
    [folders.data],
  );

  const workflowDraft = useMemo(() => {
    try {
      return YAML.parse(yamlValue) as WorkflowDraftDocument;
    } catch {
      return null;
    }
  }, [yamlValue]);

  const draftSteps = workflowDraft?.steps ?? [];
  const draftLocators = workflowDraft?.locators ?? {};
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
    () => (groups.data ?? []).find((item) => item.external_group_id === selectedGroupId) ?? null,
    [groups.data, selectedGroupId],
  );
  const providerOptions = useMemo(
    () =>
      (providers.data ?? []).map((item) => ({ value: item.provider_type, label: item.display_name })),
    [providers.data],
  );
  const groupOptions = useMemo(
    () => [
      { value: "__all__", label: "全部分组" },
      ...(groups.data ?? []).map((group) => ({
        value: group.external_group_id,
        label: `${group.display_name}${group.profile_count === null || group.profile_count === undefined ? "" : ` (${group.profile_count})`}`,
      })),
    ],
    [groups.data],
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

  const openStepComposer = (card: WorkflowActionCard, options?: { insertAfterIndex?: number }) => {
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

  const handleSelectWorkflow = (workflow: WorkflowRecord) => {
    setActiveWorkflow(workflow);
    setCreatingWorkflow(false);
    setActiveFolder(workflow.folder || "未分组");
    setYamlValue(workflow.workflow_yaml);
    setSelectedCard(null);
    setEditingStepIndex(null);
    setInsertAfterStepIndex(null);
  };

  const handleNewWorkflow = () => {
    const now = new Date();
    const name = `新建运营流程 ${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;
    const folder = workflowFolderFilter || activeFolder || "未分组";
    setActiveWorkflow(null);
    setCreatingWorkflow(true);
    setActiveFolder(folder);
    setYamlValue(buildDefaultWorkflow(name, selectedProviderType || providers.data?.[0]?.provider_type || "ixbrowser"));
    setSelectedCard(null);
    setEditingStepIndex(null);
    setInsertAfterStepIndex(null);
  };

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) {
      message.warning("请输入业务文件夹名称");
      return;
    }
    try {
      await api.createWorkflowFolder(name);
      setNewFolderName("");
      setFolderReloadKey((value) => value + 1);
      setWorkflowFolderFilter(name);
      setActiveFolder(name);
      message.success("业务文件夹已创建");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "创建文件夹失败");
    }
  };

  const handleDuplicateWorkflow = async (workflow: WorkflowRecord) => {
    try {
      const copied = await api.duplicateWorkflow(workflow.id);
      setWorkflowReloadKey((value) => value + 1);
      setActiveWorkflow(copied);
      setCreatingWorkflow(false);
      setActiveFolder(copied.folder || "未分组");
      setYamlValue(copied.workflow_yaml);
      message.success("流程已复制");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "复制失败");
    }
  };

  const handleDeleteWorkflow = async (workflow: WorkflowRecord) => {
    try {
      await api.deleteWorkflow(workflow.id);
      setWorkflowReloadKey((value) => value + 1);
      if (activeWorkflow?.id === workflow.id) {
        setActiveWorkflow(null);
        setCreatingWorkflow(false);
        setYamlValue(DEFAULT_WORKFLOW);
      }
      message.success("流程已删除");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "删除失败");
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

  const handleSave = async () => {
    try {
      const parsed = (YAML.parse(yamlValue) ?? {}) as WorkflowDraftDocument;
      applySelectedProfilePolicy(parsed, selectedProviderType, selectedGroupId, selectedProfileId);
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
      message.success("流程模板已保存");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "保存失败");
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
    if (!selectedCard) {
      throw new Error("当前没有选中的动作卡片");
    }
    try {
      const parsed = (YAML.parse(yamlValue) ?? {}) as WorkflowDraftDocument;
      applySelectedProfilePolicy(parsed, selectedProviderType, selectedGroupId, selectedProfileId);
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

  if (providers.loading || workflows.loading || folders.loading || actionCards.loading || profiles.loading || groups.loading || openedSessions.loading) {
    return <Spin size="large" />;
  }

  return (
    <Space direction="vertical" size={24} style={{ width: "100%" }}>
      <SectionCard
        title="流程库管理"
        subtitle="按业务文件夹管理多组运营流程。先从列表选择一个流程，再进入下方编排器编辑动作。"
        extra={
          <Space wrap>
            <Input
              style={{ width: 220 }}
              placeholder="新业务文件夹"
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
              onPressEnter={() => void handleCreateFolder()}
            />
            <Button onClick={() => void handleCreateFolder()}>创建文件夹</Button>
            <Button type="primary" icon={<Plus size={16} />} onClick={handleNewWorkflow}>
              新建流程
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Space wrap>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: 240 }}
              value={workflowFolderFilter ?? undefined}
              options={folderOptions}
              placeholder="按业务文件夹筛选"
              onChange={(value) => setWorkflowFolderFilter(value ?? null)}
            />
            <Select
              allowClear
              style={{ width: 180 }}
              value={workflowProviderFilter ?? undefined}
              options={providerOptions}
              placeholder="按 Provider 筛选"
              onChange={(value) => setWorkflowProviderFilter(value ?? null)}
            />
            <Input.Search
              allowClear
              style={{ width: 280 }}
              placeholder="搜索流程名称或描述"
              value={workflowSearch}
              onChange={(event) => setWorkflowSearch(event.target.value)}
            />
            <Tag color={creatingWorkflow ? "gold" : activeWorkflow ? "green" : "default"}>
              {creatingWorkflow ? "正在新建流程" : activeWorkflow ? `正在编辑 ${activeWorkflow.name}` : "未选择流程"}
            </Tag>
          </Space>

          <Table
            rowKey="id"
            size="middle"
            dataSource={workflows.data ?? []}
            pagination={{ pageSize: 6 }}
            onRow={(record) => ({
              onDoubleClick: () => handleSelectWorkflow(record),
            })}
            columns={[
              {
                title: "流程",
                render: (_, item) => (
                  <Space direction="vertical" size={2}>
                    <Typography.Text strong>{item.name}</Typography.Text>
                    <Typography.Text type="secondary">{item.description || "无描述"}</Typography.Text>
                  </Space>
                ),
              },
              { title: "业务文件夹", dataIndex: "folder", width: 160 },
              { title: "Provider", dataIndex: "target_provider_type", width: 130 },
              { title: "版本", dataIndex: "version", width: 100 },
              {
                title: "类型",
                width: 110,
                render: (_, item) => <Tag color={item.is_builtin ? "blue" : "gold"}>{item.is_builtin ? "内置" : "自定义"}</Tag>,
              },
              {
                title: "动作",
                width: 260,
                render: (_, item) => (
                  <Space wrap>
                    <Button size="small" onClick={() => handleSelectWorkflow(item)}>
                      查看/编辑
                    </Button>
                    <Button size="small" icon={<Copy size={14} />} onClick={() => void handleDuplicateWorkflow(item)}>
                      复制
                    </Button>
                    <Popconfirm
                      title="删除这个流程？"
                      description="如果流程已被历史批次或定时任务引用，系统会阻止删除。"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => void handleDeleteWorkflow(item)}
                    >
                      <Button size="small" danger icon={<Trash2 size={14} />}>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        </Space>
      </SectionCard>

      <SectionCard
        title="测试会话"
        subtitle="先选一个测试 Profile 并打开它，再去配置动作和做单步试跑。这样运营同学可以对着真实页面完成流程搭建。"
      >
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Alert
            type={selectedSession ? "success" : "info"}
            showIcon
            message={selectedSession ? "测试会话已就绪" : "建议先打开测试 Profile"}
            description={
              selectedSession
                ? `当前测试 Profile: ${selectedProfile?.display_name ?? selectedProfileId}。${selectedGroup ? `流程范围已绑定分组“${selectedGroup.display_name}”。` : "流程范围将绑定当前 Profile。"}请先在指纹浏览器窗口里手动登录并进入目标页面，再回来配置动作和做单步试跑。`
                : "打开后，先在指纹浏览器里进入目标页面；随后定位规则会额外在真实页面做命中检查，点击/输入/等待等动作也能单步试跑。"
            }
          />
          {groups.error ? (
            <Alert
              type="warning"
              showIcon
              message="分组读取失败，已尝试使用本地缓存"
              description={groups.error}
            />
          ) : null}
          <Space align="start" size={16} wrap>
            <div>
              <Typography.Text type="secondary">Provider</Typography.Text>
              <Select
                style={{ width: 180, display: "block", marginTop: 8 }}
                value={selectedProviderType}
                options={providerOptions}
                onChange={(value) => {
                  setSelectedProviderType(value);
                  setSelectedGroupId(null);
                  setSelectedProfileId(null);
                  setGroupReloadKey((current) => current + 1);
                  setProfileReloadKey((current) => current + 1);
                  setSessionReloadKey((current) => current + 1);
                }}
              />
            </div>
            <div>
              <Typography.Text type="secondary">指纹浏览器分组</Typography.Text>
              <Select
                showSearch
                optionFilterProp="label"
                style={{ width: 260, display: "block", marginTop: 8 }}
                value={selectedGroupId ?? "__all__"}
                options={groupOptions}
                onChange={(value) => {
                  setSelectedGroupId(value === "__all__" ? null : value);
                  setSelectedProfileId(null);
                }}
                placeholder="先选择分组"
              />
            </div>
            <div>
              <Typography.Text type="secondary">测试窗口 / Profile</Typography.Text>
              <Select
                showSearch
                optionFilterProp="label"
                style={{ width: 360, display: "block", marginTop: 8 }}
                value={selectedProfileId ?? undefined}
                options={profileOptions}
                onChange={(value) => setSelectedProfileId(value)}
                placeholder={selectedGroupId ? "选择这个分组里的测试 Profile" : "选择一个用于制作流程的测试 Profile"}
              />
            </div>
            <Space style={{ marginTop: 30 }} wrap>
              <Button loading={sessionActionLoading} onClick={() => void handleSyncProfiles()}>
                刷新 Profiles
              </Button>
              <Button type="primary" loading={sessionActionLoading} onClick={() => void handleOpenTestProfile()}>
                打开测试 Profile
              </Button>
              <Button danger loading={sessionActionLoading} disabled={!selectedSession} onClick={() => void handleCloseTestProfile()}>
                关闭测试 Profile
              </Button>
            </Space>
          </Space>

          <Space wrap>
            <Tag color={selectedSession ? "green" : "default"}>
              {selectedSession ? "测试会话已连接" : "尚未连接测试会话"}
            </Tag>
            <Tag color={selectedGroup ? "geekblue" : "default"}>
              {selectedGroup ? `当前分组 ${selectedGroup.display_name}` : "全部分组"}
            </Tag>
            <Tag color="purple">已读取分组 {(groups.data ?? []).length}</Tag>
            <Tag color="cyan">已管理 Profiles {(profiles.data ?? []).length}</Tag>
            <Tag color="blue">当前可选窗口 {filteredProfiles.length}</Tag>
            <Tag color="gold">已打开会话 {(openedSessions.data ?? []).length}</Tag>
            {selectedSession?.debugging_address ? <Tag>{selectedSession.debugging_address}</Tag> : null}
          </Space>
        </Space>
      </SectionCard>

      <SectionCard
        title="当前流程编排"
        subtitle="选中或新建一个流程后，在这里用运营视图管理动作；高级 YAML 仍作为可选检查层。"
        extra={
          <Space wrap>
            <Typography.Text type="secondary">业务文件夹</Typography.Text>
            <Select
              showSearch
              optionFilterProp="label"
              style={{ width: 220 }}
              value={activeFolder}
              options={folderOptions}
              onChange={setActiveFolder}
            />
	            <Button onClick={() => void handleSave()}>
	              保存当前流程
	            </Button>
	          </Space>
	        }
	      >
	        <Space direction="vertical" size={16} style={{ width: "100%" }}>
	          <div className="workflow-test-toolbar">
	            <div>
	              <Typography.Text className="section-eyebrow">流程完整性测试</Typography.Text>
	              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
	                在当前打开的测试 Profile 中，从第 1 步到最后一步真实执行整条流程，并返回步骤时间线。
	                {selectedSession ? " 当前测试窗口已连接，可以开始。" : " 请先在上方打开测试 Profile。"}
	              </Typography.Paragraph>
	            </div>
	            <Popconfirm
	              title="整条流程试运行？"
	              description="会在当前打开的测试 Profile 中按顺序真实执行全部节点，建议先确认这是测试窗口。"
	              okText="开始试运行"
	              cancelText="取消"
	              onConfirm={() => void handleDryRunWorkflow()}
	            >
	              <Button type="primary" size="large" loading={dryRunLoading} disabled={!selectedSession}>
	                整条流程试运行
	              </Button>
	            </Popconfirm>
	          </div>
	          <Tabs
	            items={[
	              {
	                key: "operator",
	                label: "运营视图",
	                children: (
	                  <WorkflowWizard
	                    cards={actionCards.data ?? []}
	                    steps={draftSteps}
	                    locators={draftLocators}
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
	                  <Row gutter={[20, 20]}>
	                    <Col xs={24} xl={16}>
	                      <Editor
	                        height="720px"
	                        defaultLanguage="yaml"
	                        value={yamlValue}
	                        onChange={(value) => setYamlValue(value ?? "")}
	                        options={{ minimap: { enabled: false }, fontSize: 14 }}
	                      />
	                    </Col>
	                    <Col xs={24} xl={8}>
	                      <Space direction="vertical" size={16} style={{ width: "100%" }}>
	                        <SectionCard title="校验与保存">
	                          <Space direction="vertical" size={12} style={{ width: "100%" }}>
	                            <Typography.Paragraph type="secondary">
	                              保存前先跑静态校验，确认 Locator 和步骤结构没有明显问题。
	                            </Typography.Paragraph>
	                            <Button type="primary" onClick={handleValidate}>
	                              校验流程
	                            </Button>
	                            <Button onClick={handleSave}>保存模板</Button>
	                          </Space>
	                        </SectionCard>
	                        <SectionCard title="操作建议">
	                          <Typography.Paragraph>
	                            1. 先在运营视图点击动作卡片并完成步骤配置。
	                            <br />
	                            2. 系统会自动把 selector_key 和 locators 写进 YAML。
	                            <br />
	                            3. 保存后再去批次页绑定 CSV/Excel。
	                          </Typography.Paragraph>
	                        </SectionCard>
	                      </Space>
	                    </Col>
	                  </Row>
	                ),
	              },
	            ]}
	          />
	        </Space>
	      </SectionCard>

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
              <Tag color={dryRunResult.success ? "green" : "red"}>
                {dryRunResult.success ? "全部通过" : "存在失败"}
              </Tag>
              <Tag color="blue">成功 {dryRunResult.succeeded_steps}</Tag>
              <Tag color="red">失败 {dryRunResult.failed_steps}</Tag>
              <Tag color="gold">耗时 {dryRunResult.elapsed_ms}ms</Tag>
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
                  render: (value: string) => <Tag color={statusColor(value)}>{value}</Tag>,
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
    </Space>
  );
}
