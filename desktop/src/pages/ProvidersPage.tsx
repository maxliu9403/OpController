import { Alert, Button, Input, Select, Space, Spin, Table, Tag, Typography, message } from "antd";
import type { Key } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { SectionCard } from "../components/SectionCard";
import { usePolling } from "../hooks/usePolling";
import type { ProfileRecord, ProviderScope } from "../types";

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

export function ProvidersPage() {
  const providers = usePolling(api.listProviders, 10000);
  const [selectedProviderType, setSelectedProviderType] = useState("ixbrowser");
  const [profileReloadKey, setProfileReloadKey] = useState(0);
  const [scopeReloadKey, setScopeReloadKey] = useState(0);
  const [groupReloadKey, setGroupReloadKey] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [savingScope, setSavingScope] = useState(false);
  const [draftScope, setDraftScope] = useState<ProviderScope | null>(null);
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
  const groups = usePolling(groupsFetcher, 10000);
  const profiles = usePolling(profilesFetcher, 10000);
  const scope = usePolling(scopeFetcher, 10000);

  useEffect(() => {
    if (!providers.data?.length) {
      return;
    }
    if (!providers.data.some((item) => item.provider_type === selectedProviderType)) {
      setSelectedProviderType(providers.data[0].provider_type);
    }
  }, [providers.data, selectedProviderType]);

  useEffect(() => {
    setDraftScope(normalizeScope(scope.data, selectedProviderType));
    setSelectedProfileIds([]);
  }, [scope.data, selectedProviderType]);

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
    setSyncing(true);
    try {
      await api.syncProfiles(selectedProviderType);
      setProfileReloadKey((value) => value + 1);
      setGroupReloadKey((value) => value + 1);
      message.success("分组和 Profile 已从指纹浏览器同步");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "同步失败");
    } finally {
      setSyncing(false);
    }
  }, [selectedProviderType]);

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
      message.success("已恢复默认：全部 Profile 纳入管理");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "恢复失败");
    } finally {
      setSavingScope(false);
    }
  };

  if (providers.loading || groups.loading || profiles.loading || scope.loading || !draftScope) {
    return <Spin size="large" />;
  }

  return (
    <Space direction="vertical" size={24} style={{ width: "100%" }}>
      <SectionCard
        title="Provider 管理"
        subtitle="配置哪些指纹浏览器分组和窗口进入 OpController 的批次、定时与流程编排范围。"
        extra={
          <Space wrap>
            <Select
              style={{ width: 220 }}
              value={selectedProviderType}
              options={providerOptions}
              onChange={(value) => {
                setSelectedProviderType(value);
                setGroupFilter(null);
                setSelectedProfileIds([]);
              }}
            />
            <Button type="primary" loading={syncing} onClick={() => void handleSync()}>
              同步指纹浏览器
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Alert
            type={effectiveScope.is_configured ? "warning" : "info"}
            showIcon
            message={effectiveScope.is_configured ? "当前启用了管理范围" : "当前默认管理全部 Profile"}
            description={
              effectiveScope.is_configured
                ? "Profile 管理清单只展示管理分组内的窗口；显式排除仍会显示，方便随时恢复。"
                : "尚未保存自定义范围，所有已同步 Profile 都会被视为可管理。"
            }
          />
          <Space wrap>
            <Tag color="cyan">已同步 Profiles {(profiles.data ?? []).length}</Tag>
            <Tag color="blue">当前纳入管理 {managedCount}</Tag>
            <Tag color="purple">分组 {(groups.data ?? []).length}</Tag>
            <Tag color="gold">显式纳入 {effectiveScope.include_profile_ids.length}</Tag>
            <Tag color="red">显式排除 {effectiveScope.exclude_profile_ids.length}</Tag>
          </Space>
        </Space>
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
            <Button disabled={!selectedProfileIds.length} onClick={handleIncludeSelected}>
              纳入所选窗口
            </Button>
            <Button danger disabled={!selectedProfileIds.length} onClick={handleExcludeSelected}>
              排除所选窗口
            </Button>
            <Button disabled={!selectedProfileIds.length} onClick={handleClearExceptions}>
              清除所选窗口例外
            </Button>
          </Space>
        </Space>
      </SectionCard>

      <SectionCard
        title="Profile 管理清单"
        subtitle={effectiveScope.is_configured ? "这里只展示管理范围配置中的分组 Profile。" : "尚未配置范围，当前展示全部已同步 Profile。"}
      >
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
              placeholder="搜索名称、ID、分组、代理"
              value={profileSearch}
              onChange={(event) => setProfileSearch(event.target.value)}
            />
            <Tag color="blue">当前清单 {filteredProfiles.length}</Tag>
          </Space>
          <Table
            rowKey="external_profile_id"
            dataSource={filteredProfiles}
            rowSelection={{
              selectedRowKeys: selectedProfileIds,
              onChange: setSelectedProfileIds,
            }}
            pagination={{ pageSize: 12, showSizeChanger: true }}
            columns={[
              { title: "名称", dataIndex: "display_name" },
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
                    <Tag color={result.managed ? "green" : "default"}>
                      {result.managed ? "已纳入管理" : "未纳入"} / {reasonLabel(result.reason)}
                    </Tag>
                  );
                },
              },
              {
                title: "启用",
                dataIndex: "enabled",
                width: 100,
                render: (value: boolean) => <Tag color={value ? "green" : "default"}>{value ? "Enabled" : "Disabled"}</Tag>,
              },
            ]}
          />
        </Space>
      </SectionCard>
    </Space>
  );
}
