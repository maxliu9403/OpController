import { Button, Layout, Menu, Space, Typography, message } from "antd";
import {
  Activity,
  CalendarClock,
  Command,
  LayoutDashboard,
  LoaderCircle,
  Moon,
  RadioTower,
  ScanSearch,
  Sparkles,
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
          <div className="app-version-panel">
            <Space align="center" size={8} wrap>
              <Typography.Text className="app-version-label">
                桌面端 {updateStatus?.current_version ?? (currentVersion || "未知版本")}
              </Typography.Text>
              {updateStatus?.update_available ? (
                <Typography.Text className="app-update-pill">
                  <Sparkles size={12} />
                  新版本 {updateStatus.version}
                </Typography.Text>
              ) : null}
            </Space>
            <Typography.Paragraph className="app-update-copy">
              {updateStatus?.update_available
                ? "发现可安装的新版本，安装后会自动重启。"
                : "支持在应用内检查新版并完成升级。"}
            </Typography.Paragraph>
            <Space size={8} wrap>
              <Button
                size="small"
                onClick={() => void handleCheckUpdate()}
                loading={checkingUpdate}
                icon={checkingUpdate ? <LoaderCircle size={14} /> : <Sparkles size={14} />}
              >
                检查更新
              </Button>
              {updateStatus?.update_available ? (
                <Button
                  size="small"
                  type="primary"
                  onClick={() => void handleInstallUpdate()}
                  loading={installingUpdate}
                >
                  安装并重启
                </Button>
              ) : null}
            </Space>
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
