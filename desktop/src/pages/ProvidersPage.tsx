import { Alert, Button, Form, Input, Select, Space, Spin, Table, Tag, Typography, message } from "antd";
import type { Key } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { ProviderIcon } from "../components/ProviderIcon";
import { SectionCard } from "../components/SectionCard";
import { StatusBadge } from "../components/StatusBadge";
import { setPollingCache, usePolling } from "../hooks/usePolling";
import type { ProfileRecord, ProviderConfig, ProviderHealth, ProviderInfo, ProviderScope } from "../types";

const STARTED_PROVIDERS_SESSION_KEY = "opcontroller.started_providers";

function profileGroupId(profile: ProfileRecord) {
  const raw = profile.group_summary?.id;
  return raw === null || raw === undefined || raw === "" ? "__ungrouped__" : String(raw);
}

function normalizeScope(scope: ProviderScope | null, providerType: string): ProviderScope {
  return scope ?? {
    provider_type: providerType,
    managed_group_ids: [],
    include_profile_ids: [],
    exclude_profile_ids: [],
    is_configured: false,
  };
}

function evaluateDraftManagement(profile: ProfileRecord, scope: ProviderScope) {
  const profileId = String(profile.external_profile_id);
  if (scope.exclude_profile_ids.includes(profileId)) {
    return { managed: false, reason: "profile_excluded" };
  }
  if (!scope.is_configured) {
    return { managed: true, reason: "default_all_profiles" };
  }
  if (scope.include_profile_ids.includes(profileId)) {
    return { managed: true, reason: "profile_included" };
  }
  if (scope.managed_group_ids.includes(profileGroupId(profile))) {
    return { managed: true, reason: "group_whitelist" };
  }
  return { managed: false, reason: "group_not_managed" };
}

function reasonLabel(reason: string) {
  const labels: Record<string, string> = {
    default_all_profiles: "默认全部管理",
    group_whitelist: "分组白名单",
    profile_included: "窗口例外纳入",
    profile_excluded: "窗口例外排除",
    group_not_managed: "分组未纳入",
  };
  return labels[reason] ?? reason;
}

function dedupe(values: string[]) {
  return Array.from(new Set(values.filter(Boolean).map(String)));
}

function readStartedProviders() {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(STARTED_PROVIDERS_SESSION_KEY) ?? "[]");
    return Array.isArray(parsed) ? dedupe(parsed.map(String)) : [];
  } catch {
    return [];
  }
}

function writeStartedProviders(providerTypes: string[]) {
  if (typeof window === "undefined") {
    return;
  }
  window.sessionStorage.setItem(STARTED_PROVIDERS_SESSION_KEY, JSON.stringify(dedupe(providerTypes)));
}

const MASKED_SECRET = "********";

function credentialStatusTag(config: ProviderConfig | null | undefined) {
  if (!config?.fields.length) {
    return <StatusBadge status="not_required" />;
  }
  if (config.credential_status.configured) {
    return <StatusBadge status="configured" />;
  }
  return <StatusBadge status="needs_config" />;
}

export function ProvidersPage() {
  const providers = usePolling(api.listProviders, { intervalMs: 10000, cacheKey: "providers:list" });
  const [selectedProviderType, setSelectedProviderType] = useState("ixbrowser");
  const [startedProviderTypes, setStartedProviderTypes] = useState<string[]>(readStartedProviders);
  const [manualHealth, setManualHealth] = useState<Record<string, ProviderHealth>>({});
  const [profileReloadKey, setProfileReloadKey] = useState(0);
  const [scopeReloadKey, setScopeReloadKey] = useState(0);
  const [groupReloadKey, setGroupReloadKey] = useState(0);
  const [configReloadKey, setConfigReloadKey] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [savingScope, setSavingScope] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [secretVisible, setSecretVisible] = useState<Record<string, boolean>>({});
  const [secretLoadingKey, setSecretLoadingKey] = useState<string | null>(null);
  const [draftScope, setDraftScope] = useState<ProviderScope | null>(null);
  const [configForm] = Form.useForm();
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [profileSearch, setProfileSearch] = useState("");
  const [selectedProfileIds, setSelectedProfileIds] = useState<Key[]>([]);

  const groupsFetcher = useCallback(
    () => api.listProviderGroups(selectedProviderType),
    [selectedProviderType, groupReloadKey],
  );
  const profilesFetcher = useCallback(
    () => api.listProfiles(selectedProviderType),
    [selectedProviderType, profileReloadKey],
  );
  const scopeFetcher = useCallback(
    () => api.getProviderScope(selectedProviderType),
    [selectedProviderType, scopeReloadKey],
  );
  const configFetcher = useCallback(
    () => api.getProviderConfig(selectedProviderType),
    [selectedProviderType, configReloadKey],
  );
  const isSelectedProviderStarted = startedProviderTypes.includes(selectedProviderType);
  const groups = usePolling(groupsFetcher, {
    intervalMs: 10000,
    cacheKey: `provider:${selectedProviderType}:groups`,
    enabled: Boolean(selectedProviderType && isSelectedProviderStarted),
  });
  const profiles = usePolling(profilesFetcher, {
    intervalMs: 10000,
    cacheKey: `provider:${selectedProviderType}:profiles:all`,
    enabled: Boolean(selectedProviderType && isSelectedProviderStarted),
  });
  const scope = usePolling(scopeFetcher, {
    intervalMs: 10000,
    cacheKey: `provider:${selectedProviderType}:scope`,
    enabled: Boolean(selectedProviderType && isSelectedProviderStarted),
  });
  const providerConfig = usePolling(configFetcher, {
    intervalMs: 10000,
    cacheKey: `provider:${selectedProviderType}:config`,
    enabled: Boolean(selectedProviderType),
  });

  useEffect(() => {
    if (!providers.data?.length) {
      return;
    }
    if (!providers.data.some((item) => item.provider_type === selectedProviderType)) {
      setSelectedProviderType(providers.data[0].provider_type);
    }
  }, [providers.data, selectedProviderType]);

  useEffect(() => {
    writeStartedProviders(startedProviderTypes);
  }, [startedProviderTypes]);

  useEffect(() => {
    const healthyProviderTypes = (providers.data ?? [])
      .filter((provider) => provider.health.healthy)
      .map((provider) => provider.provider_type);
    if (!healthyProviderTypes.length) {
      return;
    }
    setStartedProviderTypes((current) => {
      const next = dedupe([...current, ...healthyProviderTypes]);
      return next.length === current.length ? current : next;
    });
  }, [providers.data]);

  useEffect(() => {
    setDraftScope(normalizeScope(scope.data, selectedProviderType));
    setSelectedProfileIds([]);
  }, [scope.data, selectedProviderType]);

  useEffect(() => {
    configForm.resetFields();
    configForm.setFieldsValue(providerConfig.data?.values ?? {});
    setSecretVisible({});
    setSecretLoadingKey(null);
  }, [configForm, providerConfig.data]);

  const providerOptions = useMemo(
    () => (providers.data ?? []).map((item) => ({ value: item.provider_type, label: item.display_name })),
    [providers.data],
  );
  const groupOptions = useMemo(
    () =>
      (groups.data ?? []).map((group) => ({
        value: group.external_group_id,
        label: `${group.display_name}${group.profile_count === null || group.profile_count === undefined ? "" : ` (${group.profile_count})`}`,
      })),
    [groups.data],
  );

  const effectiveScope = normalizeScope(draftScope, selectedProviderType);
  const profileListGroupOptions = useMemo(() => {
    if (!effectiveScope.is_configured) {
      return groupOptions;
    }
    return groupOptions.filter((option) => effectiveScope.managed_group_ids.includes(String(option.value)));
  }, [effectiveScope.is_configured, effectiveScope.managed_group_ids, groupOptions]);

  const filteredProfiles = useMemo(() => {
    const search = profileSearch.trim().toLowerCase();
    return (profiles.data ?? []).filter((profile) => {
      const currentGroupId = profileGroupId(profile);
      if (effectiveScope.is_configured && !effectiveScope.managed_group_ids.includes(currentGroupId)) {
        return false;
      }
      if (groupFilter && profileGroupId(profile) !== groupFilter) {
        return false;
      }
      if (search) {
        const haystack = [
          profile.display_name,
          profile.remark,
          profile.external_profile_id,
          profile.group_summary?.name,
          profile.proxy_summary?.ip,
          profile.proxy_summary?.port,
        ].join(" ").toLowerCase();
        if (!haystack.includes(search)) {
          return false;
        }
      }
      return true;
    });
  }, [effectiveScope, groupFilter, profileSearch, profiles.data]);

  const managedCount = useMemo(
    () => (profiles.data ?? []).filter((profile) => evaluateDraftManagement(profile, effectiveScope).managed).length,
    [effectiveScope, profiles.data],
  );

  const updateDraftScope = (mutator: (current: ProviderScope) => ProviderScope) => {
    setDraftScope((current) => mutator(normalizeScope(current, selectedProviderType)));
  };

  useEffect(() => {
    if (!groupFilter) {
      return;
    }
    if (!profileListGroupOptions.some((option) => option.value === groupFilter)) {
      setGroupFilter(null);
    }
  }, [groupFilter, profileListGroupOptions]);

  const selectedProfileIdStrings = selectedProfileIds.map(String);
  const selectedProviderInfo = useMemo(
    () => (providers.data ?? []).find((item) => item.provider_type === selectedProviderType) ?? null,
    [providers.data, selectedProviderType],
  );
  const selectedProviderHealth = manualHealth[selectedProviderType] ?? selectedProviderInfo?.health ?? null;
  const updateProviderHealthCache = (providerType: string, health: ProviderHealth) => {
    if (!providers.data?.length) {
      return;
    }
    const nextProviders: ProviderInfo[] = providers.data.map((provider) =>
      provider.provider_type === providerType ? { ...provider, health } : provider,
    );
    setPollingCache("providers:list", nextProviders);
  };
  const selectProvider = (providerType: string) => {
    setSelectedProviderType(providerType);
    setGroupFilter(null);
    setSelectedProfileIds([]);
  };

  const handleIncludeSelected = () => {
    updateDraftScope((current) => ({
      ...current,
      is_configured: true,
      include_profile_ids: dedupe([...current.include_profile_ids, ...selectedProfileIdStrings]),
      exclude_profile_ids: current.exclude_profile_ids.filter((id) => !selectedProfileIdStrings.includes(id)),
    }));
  };

  const handleExcludeSelected = () => {
    updateDraftScope((current) => ({
      ...current,
      is_configured: true,
      include_profile_ids: current.include_profile_ids.filter((id) => !selectedProfileIdStrings.includes(id)),
      exclude_profile_ids: dedupe([...current.exclude_profile_ids, ...selectedProfileIdStrings]),
    }));
  };

  const handleClearExceptions = () => {
    updateDraftScope((current) => ({
      ...current,
      include_profile_ids: current.include_profile_ids.filter((id) => !selectedProfileIdStrings.includes(id)),
      exclude_profile_ids: current.exclude_profile_ids.filter((id) => !selectedProfileIdStrings.includes(id)),
    }));
  };

  const handleSync = useCallback(async () => {
    if (!isSelectedProviderStarted) {
      message.warning("请先启动当前 Provider，再同步指纹窗口。");
      return;
    }
    setSyncing(true);
    try {
      await api.syncProfiles(selectedProviderType);
      setProfileReloadKey((value) => value + 1);
      setGroupReloadKey((value) => value + 1);
      message.success("分组和指纹窗口已从指纹浏览器同步");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "同步失败");
    } finally {
      setSyncing(false);
    }
  }, [isSelectedProviderStarted, selectedProviderType]);

  const handleSaveConfig = async () => {
    if (!providerConfig.data?.fields.length) {
      return;
    }
    setSavingConfig(true);
    try {
      const values = await configForm.validateFields();
      await api.updateProviderConfig(selectedProviderType, values);
      setConfigReloadKey((value) => value + 1);
      message.success("Provider 配置已保存");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "保存配置失败");
    } finally {
      setSavingConfig(false);
    }
  };

  const runProviderHealthCheck = async () => {
    setCheckingHealth(true);
    try {
      if (providerConfig.data?.fields.length) {
        const values = await configForm.validateFields();
        await api.updateProviderConfig(selectedProviderType, values);
      }
      const result = await api.providerHealthCheck(selectedProviderType);
      setManualHealth((current) => ({ ...current, [selectedProviderType]: result }));
      updateProviderHealthCache(selectedProviderType, result);
      if (result.healthy) {
        message.success(result.message || "Provider 可用");
      } else {
        message.warning(result.message || "Provider 未就绪");
      }
      setConfigReloadKey((value) => value + 1);
      return result;
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "连通性测试失败");
      return null;
    } finally {
      setCheckingHealth(false);
    }
  };

  const handleHealthCheck = async () => {
    await runProviderHealthCheck();
  };

  const handleStartProvider = async (providerType: string) => {
    if (providerType !== selectedProviderType) {
      selectProvider(providerType);
      message.info("已切换 Provider，请确认下方配置后再次点击启动。");
      return;
    }
    const result = await runProviderHealthCheck();
    if (!result) {
      return;
    }
    setManualHealth((current) => ({ ...current, [providerType]: result }));
    updateProviderHealthCache(providerType, result);
    if (!result.healthy) {
      setStartedProviderTypes((current) => current.filter((item) => item !== providerType));
      return;
    }
    setStartedProviderTypes((current) => (current.includes(providerType) ? current : [...current, providerType]));
    setGroupReloadKey((value) => value + 1);
    setProfileReloadKey((value) => value + 1);
    setScopeReloadKey((value) => value + 1);
  };

  const handleSecretVisibleChange = async (fieldKey: string, visible: boolean) => {
    if (!visible) {
      setSecretVisible((current) => ({ ...current, [fieldKey]: false }));
      return;
    }

    const currentValue = configForm.getFieldValue(fieldKey);
    if (currentValue && currentValue !== MASKED_SECRET) {
      setSecretVisible((current) => ({ ...current, [fieldKey]: true }));
      return;
    }

    setSecretLoadingKey(fieldKey);
    try {
      const result = await api.getProviderConfigSecret(selectedProviderType, fieldKey);
      if (!result.value) {
        message.warning("当前还没有保存该密钥，请先填写并保存");
        return;
      }
      configForm.setFieldValue(fieldKey, result.value);
      setSecretVisible((current) => ({ ...current, [fieldKey]: true }));
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "读取密钥失败");
    } finally {
      setSecretLoadingKey(null);
    }
  };

  const handleSaveScope = async () => {
    setSavingScope(true);
    try {
      await api.updateProviderScope(selectedProviderType, {
        ...effectiveScope,
        provider_type: selectedProviderType,
        is_configured: true,
      });
      setScopeReloadKey((value) => value + 1);
      setProfileReloadKey((value) => value + 1);
      message.success("Provider 管理范围已保存");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSavingScope(false);
    }
  };

  const handleResetScope = async () => {
    setSavingScope(true);
    try {
      await api.updateProviderScope(selectedProviderType, {
        provider_type: selectedProviderType,
        managed_group_ids: [],
        include_profile_ids: [],
        exclude_profile_ids: [],
        is_configured: false,
      });
      setScopeReloadKey((value) => value + 1);
      setProfileReloadKey((value) => value + 1);
      message.success("已恢复默认：全部指纹窗口纳入管理");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "恢复失败");
    } finally {
      setSavingScope(false);
    }
  };

  if (
    providers.loading ||
    providerConfig.loading ||
    (isSelectedProviderStarted && (groups.loading || profiles.loading || scope.loading)) ||
    !draftScope
  ) {
    return <Spin size="large" />;
  }

  return (
    <Space direction="vertical" size={24} style={{ width: "100%" }}>
      <SectionCard
        title="Provider 启动"
        subtitle="先选择要接入的指纹浏览器。需要 API Key 或本地地址的 Provider，先配置参数再启动。"
        extra={
          <Space wrap>
            <Select
              style={{ width: 220 }}
              value={selectedProviderType}
              options={providerOptions}
              onChange={(value) => {
                selectProvider(value);
              }}
            />
            <Button type="primary" loading={syncing} onClick={() => void handleSync()}>
              同步指纹窗口
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <div className="provider-start-grid">
            {(providers.data ?? []).map((provider) => {
              const health = manualHealth[provider.provider_type] ?? provider.health;
              const started = startedProviderTypes.includes(provider.provider_type);
              const needsConfig = health.details?.status === "idle" && provider.provider_type !== "ixbrowser";
              return (
                <article
                  key={provider.provider_type}
                  role="button"
                  tabIndex={0}
                  className={[
                    "provider-start-card",
                    provider.provider_type === selectedProviderType ? "is-selected" : "",
                    started ? "is-started" : "",
                  ].filter(Boolean).join(" ")}
                  onClick={() => selectProvider(provider.provider_type)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectProvider(provider.provider_type);
                    }
                  }}
                >
                  <div className="provider-start-card__head">
                    <ProviderIcon providerType={provider.provider_type} displayName={provider.display_name} />
                    <div>
                      <strong>{provider.display_name}</strong>
                      <span>{provider.provider_type}</span>
                    </div>
                    <StatusBadge
                      status={started ? "healthy" : health.healthy ? "healthy" : "pending"}
                      label={started ? "已启动" : health.healthy ? "可用" : "未启动"}
                    />
                  </div>
                  {provider.provider_type === selectedProviderType ? (
                    <Tag color={effectiveScope.is_configured ? "gold" : "blue"}>
                      {effectiveScope.is_configured ? "已设管理范围" : "默认全部管理"}
                    </Tag>
                  ) : null}
                  <p>{needsConfig ? "需要参数配置后启动" : health.message}</p>
                  <Button
                    size="small"
                    type={started ? "default" : "primary"}
                    loading={checkingHealth && selectedProviderType === provider.provider_type}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleStartProvider(provider.provider_type);
                    }}
                  >
                    {started ? "重新检查" : "启动"}
                  </Button>
                </article>
              );
            })}
          </div>
          {!isSelectedProviderStarted ? (
            <Alert
              type="warning"
              showIcon
              message="请先启动 Provider"
              description="启动后才会读取该 Provider 的分组、指纹窗口和会话状态。"
            />
          ) : null}
          <Space wrap>
            <Tag color="cyan">已同步指纹窗口 {(profiles.data ?? []).length}</Tag>
            <Tag color="blue">当前纳入管理 {managedCount}</Tag>
            <Tag color="purple">分组 {(groups.data ?? []).length}</Tag>
            <Tag color="gold">显式纳入 {effectiveScope.include_profile_ids.length}</Tag>
            <Tag color="red">显式排除 {effectiveScope.exclude_profile_ids.length}</Tag>
          </Space>
        </Space>
      </SectionCard>

      <SectionCard
        title="Provider 配置"
        subtitle={
          providerConfig.data?.fields.length
            ? "按当前指纹浏览器要求配置本地 API 地址、端口或密钥；密钥字段会脱敏展示。"
            : "当前 Provider 使用默认本地配置。"
        }
        extra={
          <Space wrap>
            {credentialStatusTag(providerConfig.data)}
            {selectedProviderHealth ? (
              <StatusBadge
                status={selectedProviderHealth.healthy ? "healthy" : "unhealthy"}
                label={selectedProviderHealth.healthy ? "已连通" : "未连通"}
              />
            ) : null}
            <Button loading={checkingHealth} onClick={() => void handleHealthCheck()}>
              测试连通性
            </Button>
            {providerConfig.data?.fields.length ? (
              <Button type="primary" loading={savingConfig} onClick={() => void handleSaveConfig()}>
                保存配置
              </Button>
            ) : null}
          </Space>
        }
      >
        {providerConfig.data?.fields.length ? (
          <Form form={configForm} layout="vertical">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
              {providerConfig.data.fields.map((field) => (
                <Form.Item
                  key={field.key}
                  name={field.key}
                  label={field.label}
                  help={field.help_text}
                  rules={field.required ? [{ required: true, message: `请填写${field.label}` }] : undefined}
                >
                  {field.secret ? (
                    <Input.Password
                      autoComplete="new-password"
                      disabled={secretLoadingKey === field.key}
                      placeholder={
                        providerConfig.data?.credential_status.masked_fields[field.key]
                          ? `已保存：${providerConfig.data.credential_status.masked_fields[field.key]}`
                          : field.placeholder ?? undefined
                      }
                      visibilityToggle={{
                        visible: Boolean(secretVisible[field.key]),
                        onVisibleChange: (visible) => void handleSecretVisibleChange(field.key, visible),
                      }}
                    />
                  ) : (
                    <Input placeholder={field.placeholder ?? undefined} />
                  )}
                </Form.Item>
              ))}
            </div>
            {!providerConfig.data.credential_status.configured ? (
              <Alert
                type="warning"
                showIcon
                message="Provider 尚未完成配置"
                description={`缺少字段：${providerConfig.data.credential_status.missing_required_fields.join("、") || "未知"}`}
              />
            ) : null}
          </Form>
        ) : null}
      </SectionCard>

      <SectionCard
        title="管理范围配置"
        subtitle="推荐先选择可管理分组，再用窗口例外处理少数特殊账号。"
        extra={
          <Space wrap>
            <Button loading={savingScope} onClick={() => void handleResetScope()}>
              恢复全部管理
            </Button>
            <Button type="primary" loading={savingScope} onClick={() => void handleSaveScope()}>
              保存管理范围
            </Button>
          </Space>
        }
      >
        {!isSelectedProviderStarted ? (
          <Alert
            type="warning"
            showIcon
            message="请先启动 Provider"
            description="启动成功后才能读取分组并保存管理范围。"
          />
        ) : null}
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <div>
            <Typography.Text type="secondary">分组白名单</Typography.Text>
            <Select
              mode="multiple"
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: "100%", marginTop: 8 }}
              value={effectiveScope.is_configured ? effectiveScope.managed_group_ids : []}
              options={groupOptions}
              placeholder="选择允许 OpController 管理的指纹浏览器分组"
              disabled={!isSelectedProviderStarted}
              onChange={(values) =>
                updateDraftScope((current) => ({
                  ...current,
                  is_configured: true,
                  managed_group_ids: dedupe(values),
                }))
              }
            />
          </div>
          <Space wrap>
            <Button disabled={!isSelectedProviderStarted || !selectedProfileIds.length} onClick={handleIncludeSelected}>
              纳入所选窗口
            </Button>
            <Button danger disabled={!isSelectedProviderStarted || !selectedProfileIds.length} onClick={handleExcludeSelected}>
              排除所选窗口
            </Button>
            <Button disabled={!isSelectedProviderStarted || !selectedProfileIds.length} onClick={handleClearExceptions}>
              清除所选窗口例外
            </Button>
          </Space>
        </Space>
      </SectionCard>

      <SectionCard
        title="指纹窗口管理清单"
        subtitle={effectiveScope.is_configured ? "这里只展示管理范围配置中的分组指纹窗口。" : "尚未配置范围，当前展示全部已同步指纹窗口。"}
      >
        {!isSelectedProviderStarted ? (
          <Alert
            type="warning"
            showIcon
            message="当前 Provider 未启动，暂不加载指纹窗口"
            description="这能避免 NSTBrowser、BitBrowser 等需要参数的 Provider 在未配置前自动报错。"
          />
        ) : null}
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Space wrap>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: 260 }}
              value={groupFilter ?? undefined}
              options={profileListGroupOptions}
              placeholder={effectiveScope.is_configured ? "在管理分组内筛选" : "按分组过滤"}
              onChange={(value) => setGroupFilter(value ?? null)}
            />
            <Input.Search
              allowClear
              style={{ width: 280 }}
              placeholder="搜索名称、备注、ID、分组、代理"
              value={profileSearch}
              onChange={(event) => setProfileSearch(event.target.value)}
            />
            <Tag color="blue">当前清单 {filteredProfiles.length}</Tag>
          </Space>
          <Table
            rowKey="external_profile_id"
            dataSource={filteredProfiles}
            locale={{ emptyText: isSelectedProviderStarted ? "暂无指纹窗口" : "请先启动 Provider" }}
            rowSelection={{
              selectedRowKeys: selectedProfileIds,
              onChange: setSelectedProfileIds,
            }}
            pagination={{ pageSize: 12, showSizeChanger: true }}
            columns={[
              { title: "名称", dataIndex: "display_name" },
              {
                title: "备注",
                dataIndex: "remark",
                ellipsis: true,
                render: (value?: string | null) => value || "--",
              },
              { title: "外部 ID", dataIndex: "external_profile_id", width: 120 },
              { title: "分组", render: (_, item) => item.group_summary?.name ?? "--" },
              {
                title: "代理",
                render: (_, item) =>
                  item.proxy_summary?.ip ? `${item.proxy_summary.ip}:${item.proxy_summary.port ?? ""}` : "--",
              },
              {
                title: "管理状态",
                render: (_, item) => {
                  const result = evaluateDraftManagement(item, effectiveScope);
                  return (
                    <Space direction="vertical" size={2}>
                      <StatusBadge
                        status={result.managed ? "configured" : "unbound"}
                        label={result.managed ? "已纳入管理" : "未纳入"}
                      />
                      <Typography.Text type="secondary">{reasonLabel(result.reason)}</Typography.Text>
                    </Space>
                  );
                },
              },
              {
                title: "启用",
                dataIndex: "enabled",
                width: 100,
                render: (value: boolean) => <StatusBadge status={value ? "enabled" : "disabled"} />,
              },
            ]}
          />
        </Space>
      </SectionCard>
    </Space>
  );
}
