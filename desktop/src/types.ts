export type ProviderCapability = {
  supports_profile_sync: boolean;
  supports_window_arrange: boolean;
  supports_group_tag_sync: boolean;
  supports_cookie_read: boolean;
  supports_cookie_write: boolean;
  supports_proxy_sync: boolean;
  supports_local_api_port_config: boolean;
  supports_native_opened_list: boolean;
  supports_download_dir_control: boolean;
};

export type ProviderHealth = {
  installed: boolean;
  healthy: boolean;
  message: string;
  api_base?: string;
  version?: string | null;
  details: Record<string, unknown>;
};

export type ProviderInfo = {
  provider_type: string;
  display_name: string;
  default_port?: number | null;
  capabilities: ProviderCapability;
  health: ProviderHealth;
};

export type ProviderConfigField = {
  key: string;
  label: string;
  type: string;
  required: boolean;
  secret: boolean;
  placeholder?: string | null;
  help_text?: string | null;
  default_value?: string | null;
};

export type ProviderCredentialStatus = {
  configured: boolean;
  masked_fields: Record<string, string>;
  missing_required_fields: string[];
};

export type ProviderConfig = {
  provider_type: string;
  fields: ProviderConfigField[];
  values: Record<string, unknown>;
  credential_status: ProviderCredentialStatus;
};

export type ProviderConfigSecret = {
  key: string;
  value: string;
};

export type ProviderSessionRecord = {
  provider_type: string;
  provider_profile_id: string;
  provider_session_id?: string | null;
  browser_pid?: number | null;
  ws_endpoint?: string | null;
  debugging_address?: string | null;
  open_time?: string | null;
  metadata: Record<string, unknown>;
};

export type ProviderGroupRecord = {
  provider_type: string;
  external_group_id: string;
  display_name: string;
  profile_count?: number | null;
  provider_payload_json: Record<string, unknown>;
};

export type ProviderScope = {
  provider_type: string;
  managed_group_ids: string[];
  include_profile_ids: string[];
  exclude_profile_ids: string[];
  is_configured: boolean;
};

export type ProfileRecord = {
  id: string;
  provider_type: string;
  external_profile_id: string;
  display_name: string;
  remark?: string | null;
  group_summary: { id?: string | number; name?: string };
  tag_summary: Array<{ id?: string | number; raw?: string }>;
  proxy_summary: { type?: string; ip?: string; port?: string };
  enabled: boolean;
  managed: boolean;
  managed_reason: string;
  last_sync_at?: string | null;
};

export type WorkflowRecord = {
  id: string;
  name: string;
  version: string;
  description?: string | null;
  folder: string;
  target_provider_type: string;
  workflow_yaml: string;
  normalized_workflow_json: Record<string, unknown>;
  selector_catalog_json: Record<string, unknown>;
  is_builtin: boolean;
};

export type WorkflowFolderRecord = {
  id?: string | null;
  name: string;
  description?: string | null;
  workflow_count: number;
};

export type WorkflowActionCard = {
  type: string;
  label: string;
  description: string;
  category: string;
};

export type LocatorLivePreview = {
  success: boolean;
  selector_used?: string | null;
  match_count: number;
  matched_texts: string[];
  current_url?: string | null;
  page_title?: string | null;
  error_code?: string | null;
  error_message?: string | null;
};

export type PickedElementSummary = {
  tag_name: string;
  text?: string | null;
  attributes: Record<string, string>;
  frame_path: string[];
  neighbor_anchor: Record<string, unknown>;
  list_context: Record<string, unknown>;
  bounding_box: Record<string, number>;
  screenshot_data_url?: string | null;
};

export type LocatorPickResult = {
  success: boolean;
  element?: PickedElementSummary | null;
  locator?: Record<string, unknown> | null;
  warnings: string[];
  uniqueness_score: number;
  stability_score: number;
  live_preview?: LocatorLivePreview | null;
  current_url?: string | null;
  page_title?: string | null;
  error_code?: string | null;
  error_message?: string | null;
};

export type StepLivePreviewResult = {
  success: boolean;
  current_url?: string | null;
  page_title?: string | null;
  selector_used?: string | null;
  locator_count: number;
  matched_texts: string[];
  outputs: Record<string, unknown>;
  artifact_path?: string | null;
  error_code?: string | null;
  error_message?: string | null;
};

export type WorkflowDryRunStepResult = {
  step_id: string;
  label?: string | null;
  action_type: string;
  status: string;
  elapsed_ms: number;
  selector_used?: string | null;
  locator_count: number;
  matched_texts: string[];
  outputs: Record<string, unknown>;
  current_url?: string | null;
  page_title?: string | null;
  artifact_path?: string | null;
  error_code?: string | null;
  error_message?: string | null;
};

export type WorkflowDryRunResult = {
  success: boolean;
  total_steps: number;
  succeeded_steps: number;
  failed_steps: number;
  elapsed_ms: number;
  current_url?: string | null;
  page_title?: string | null;
  outputs: Record<string, unknown>;
  steps: WorkflowDryRunStepResult[];
  error_code?: string | null;
  error_message?: string | null;
};

export type BatchSummary = {
  id: string;
  name: string;
  provider_type: string;
  workflow_id: string;
  status: string;
  runtime_mode: string;
  total_rows: number;
  success_count: number;
  failure_count: number;
  average_duration_ms: number;
  created_at?: string | null;
  updated_at?: string | null;
};

export type BatchDetail = BatchSummary & {
  profile_policy_snapshot: Record<string, unknown>;
  result_summary_json: Record<string, unknown>;
  rows: Array<{
    id?: string | null;
    row_index: number;
    dedupe_key?: string | null;
    payload: Record<string, unknown>;
    mapped_profile_id?: string | null;
  }>;
  tasks: Array<{
    id: string;
    batch_id: string;
    batch_row_id: string;
    row_index?: number | null;
    provider_type: string;
    provider_profile_id: string;
    status: string;
    slot_index?: number | null;
    error_code?: string | null;
    error_message?: string | null;
    outputs_json: Record<string, unknown>;
    started_at?: string | null;
    finished_at?: string | null;
  }>;
};

export type InputFileParseResult = {
  total_rows: number;
  detected_columns: string[];
  preview_rows: Record<string, unknown>[];
  rows: Record<string, unknown>[];
};

export type InputProfileMappingValidation = {
  valid: boolean;
  total_rows: number;
  matched_count: number;
  skipped_count: number;
  detected_columns: string[];
  preview_rows: Record<string, unknown>[];
  rows: Record<string, unknown>[];
  missing_profile_ids: string[];
  duplicate_profile_ids: string[];
  out_of_scope_profile_ids: string[];
  invalid_rows: Array<Record<string, unknown>>;
  warnings: string[];
};

export type ScheduleRecord = {
  id: string;
  name: string;
  status: string;
  workflow_id: string;
  provider_type: string;
  profile_policy_snapshot: Record<string, unknown>;
  schedule_type: string;
  schedule_expr: string;
  timezone: string;
  max_concurrency: number;
  retry_once_on_failure: boolean;
  input_source: Record<string, unknown>;
  next_run_at?: string | null;
  last_run_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type TaskRunDetail = {
  id: string;
  batch_id: string;
  batch_row_id?: string | null;
  provider_type: string;
  provider_profile_id: string;
  status: string;
  slot_index?: number | null;
  error_code?: string | null;
  error_message?: string | null;
  outputs_json: Record<string, unknown>;
  step_runs: Array<{
    id: string;
    step_id: string;
    label?: string | null;
    action_type: string;
	    status: string;
	    error_code?: string | null;
	    error_message?: string | null;
	    output_payload_json: Record<string, unknown>;
	    locator_summary_json: Record<string, unknown>;
	    artifact_path?: string | null;
	  }>;
};

export type SystemCheckResult = {
  app_name: string;
  runtime_origin: string;
  paths: Record<string, string>;
  runtime_health: {
    healthy: boolean;
    message: string;
    details: Record<string, unknown>;
  };
  providers: ProviderInfo[];
  diagnostics: Record<string, unknown>;
};
