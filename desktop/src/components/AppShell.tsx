import { Button, Layout, Menu, Typography, message } from "antd";
import {
  Activity,
  CalendarClock,
  CheckCircle2,
  Command,
  DownloadCloud,
  LayoutDashboard,
  Moon,
  RadioTower,
  RefreshCw,
  ScanSearch,
  Sun,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { api } from "../api/client";
import { primePollingCache } from "../hooks/usePolling";
import { useThemeMode } from "../themeMode";
import { checkForUpdates, installUpdate, type UpdateStatus } from "../updater";

const { Content, Sider } = Layout;

const items = [
  { key: "/", label: <Link to="/">概览</Link>, icon: <LayoutDashboard size={16} /> },
  { key: "/providers", label: <Link to="/providers">Provider</Link>, icon: <RadioTower size={16} /> },
  { key: "/workflows", label: <Link to="/workflows">流程编排</Link>, icon: <Command size={16} /> },
  { key: "/tasks", label: <Link to="/tasks">任务管理</Link>, icon: <CalendarClock size={16} /> },
  { key: "/monitor", label: <Link to="/monitor">监控</Link>, icon: <Activity size={16} /> },
  { key: "/results", label: <Link to="/results">结果</Link>, icon: <ScanSearch size={16} /> },
];

function AppLogo() {
  return (
    <div className="app-logo-mark" aria-hidden="true">
      <svg viewBox="0 0 36 36" role="img">
        <rect x="4" y="4" width="28" height="28" rx="9" />
        <path d="M12 18c0-4 2.7-7 6.2-7 3.4 0 5.9 2.6 5.9 6.1v.5h-4.8" />
        <path d="M24 18c0 4-2.7 7-6.2 7-3.4 0-5.9-2.6-5.9-6.1v-.5h4.8" />
        <circle cx="18" cy="18" r="2.2" />
      </svg>
    </div>
  );
}

export function AppShell() {
  const location = useLocation();
  const { mode, setMode } = useThemeMode();
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const selectedKey =
    items.find((item) => item.key !== "/" && location.pathname.startsWith(item.key))?.key ??
    (location.pathname === "/" ? "/" : location.pathname);
  const visibleVersion = updateStatus?.current_version ?? currentVersion;
  const versionLabel = visibleVersion ? `v${visibleVersion.replace(/^v/i, "")}` : "未知版本";
  const hasUpdate = Boolean(updateStatus?.update_available);
  const nextVersionLabel = updateStatus?.version ? `v${updateStatus.version.replace(/^v/i, "")}` : "新版本";
  const updateTitle = hasUpdate ? `可更新至 ${nextVersionLabel}` : updateStatus ? "已是最新版本" : "检查更新";
  const updateSubtitle = installingUpdate
    ? "正在安装更新"
    : checkingUpdate
      ? "正在连接更新通道"
      : hasUpdate
        ? "安装完成后自动重启"
        : updateStatus
          ? "更新通道正常"
          : "等待检查";
  const updateActionLabel = hasUpdate ? "安装并重启" : "检查更新";

  useEffect(() => {
    let cancelled = false;

    const warmCommonData = async () => {
      try {
        void primePollingCache("providers:list", api.listProviders).catch(() => undefined);
        void primePollingCache("system:check", api.systemCheck).catch(() => undefined);
        void primePollingCache("workflows:list:all", api.listWorkflows).catch(() => undefined);
        void primePollingCache("workflows:action-cards", api.listActionCards).catch(() => undefined);
        void primePollingCache("workflow-folders:list", api.listWorkflowFolders).catch(() => undefined);
        void primePollingCache("batches:list", api.listBatches).catch(() => undefined);
        void primePollingCache("schedules:list", api.listSchedules).catch(() => undefined);
        if (cancelled) return;
      } catch {
        // 页面本身仍会按需加载；预热失败不影响正常使用。
      }
    };

    void warmCommonData();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        const result = await checkForUpdates();
        if (!cancelled) {
          setCurrentVersion(result.current_version);
          setUpdateStatus(result);
        }
      } catch {
        // 自动检查失败不阻塞界面，保留手动重试入口。
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const result = await checkForUpdates();
      setCurrentVersion(result.current_version);
      setUpdateStatus(result);
      message.success(result.update_available ? `发现新版本 ${result.version}` : "当前已是最新版本");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "检查更新失败");
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleInstallUpdate = async () => {
    setInstallingUpdate(true);
    try {
      await installUpdate();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "安装更新失败");
      setInstallingUpdate(false);
    }
  };

  return (
    <Layout className="app-layout">
      <Sider width={280} className="app-sider">
        <div className="brand-panel">
          <div className="brand-lockup">
            <AppLogo />
            <div>
              <Typography.Text className="brand-kicker">OpController</Typography.Text>
              <Typography.Title level={2}>运营控制台</Typography.Title>
            </div>
            <Button
              className="theme-switch brand-theme-switch"
              size="large"
              shape="circle"
              aria-label={mode === "light" ? "switch to dark theme" : "switch to light theme"}
              icon={mode === "light" ? <Moon size={17} /> : <Sun size={17} />}
              onClick={() => setMode(mode === "light" ? "dark" : "light")}
            />
          </div>
          <Typography.Paragraph>
            多浏览器编排、可视群控与批次复盘工作台。
          </Typography.Paragraph>
          <div className={`app-update-card${hasUpdate ? " is-available" : ""}`}>
            <div className="app-update-meta">
              <Typography.Text className="app-update-eyebrow">
                <span className="app-update-status-dot" aria-hidden="true" />
                更新
              </Typography.Text>
              <Typography.Text className="app-update-current">{versionLabel}</Typography.Text>
            </div>
            <div className="app-update-main">
              <div className="app-update-icon" aria-hidden="true">
                {hasUpdate ? <DownloadCloud size={16} /> : updateStatus ? <CheckCircle2 size={16} /> : <RefreshCw size={16} />}
              </div>
              <div className="app-update-copy">
                <Typography.Text className="app-update-title">{updateTitle}</Typography.Text>
                <Typography.Text className="app-update-subtitle">{updateSubtitle}</Typography.Text>
              </div>
            </div>
            <Button
              className="app-update-action"
              size="small"
              block
              type={hasUpdate ? "primary" : "default"}
              onClick={() => void (hasUpdate ? handleInstallUpdate() : handleCheckUpdate())}
              loading={checkingUpdate || installingUpdate}
              icon={hasUpdate ? <DownloadCloud size={14} /> : <RefreshCw size={14} />}
            >
              {updateActionLabel}
            </Button>
          </div>
        </div>
        <Menu theme={mode === "dark" ? "dark" : "light"} mode="inline" selectedKeys={[selectedKey]} items={items} />
      </Sider>
      <Layout>
        <Content className="app-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
