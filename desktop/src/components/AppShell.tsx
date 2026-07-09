import { Button, Layout, Menu, Typography, message } from "antd";
import {
  Activity,
  ArrowDownToLine,
  CalendarClock,
  CheckCircle2,
  Command,
  DownloadCloud,
  LayoutDashboard,
  Moon,
  RadioTower,
  RefreshCw,
  ScanSearch,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { api } from "../api/client";
import { primePollingCache } from "../hooks/usePolling";
import { useThemeMode } from "../themeMode";
import { checkForUpdates, installUpdate, type UpdateStatus } from "../updater";

const { Content, Sider } = Layout;
const SKIPPED_UPDATE_STORAGE_KEY = "opcontroller.skipped_update_version";

const items = [
  { key: "/", label: <Link to="/">概览</Link>, icon: <LayoutDashboard size={16} /> },
  { key: "/providers", label: <Link to="/providers">指纹窗口</Link>, icon: <RadioTower size={16} /> },
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

function normalizeVersion(version?: string | null) {
  return version?.replace(/^v/i, "") ?? "";
}

function versionLabel(version?: string | null, fallback = "未知版本") {
  const normalized = normalizeVersion(version);
  return normalized ? `v${normalized}` : fallback;
}

function readSkippedUpdateVersion() {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem(SKIPPED_UPDATE_STORAGE_KEY) ?? "";
}

function rememberSkippedUpdateVersion(version: string) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(SKIPPED_UPDATE_STORAGE_KEY, normalizeVersion(version));
  }
}

function renderInlineMarkdown(value: string): ReactNode {
  const segments = value.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return segments.map((segment, index) => {
    const bold = segment.match(/^\*\*([^*]+)\*\*$/);
    if (bold) {
      return <strong key={`${segment}-${index}`}>{bold[1]}</strong>;
    }
    return <Fragment key={`${segment}-${index}`}>{segment}</Fragment>;
  });
}

function renderReleaseNotes(body?: string | null) {
  const lines = body?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) ?? [];
  if (!lines.length) {
    return (
      <div className="update-dialog-empty">
        <Sparkles size={18} />
        <span>本次更新包含稳定性改进与体验优化，建议尽快升级。</span>
      </div>
    );
  }

  return lines.map((line, index) => {
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      return (
        <Typography.Text key={`${line}-${index}`} className={level <= 2 ? "update-dialog-section" : "update-dialog-subsection"}>
          {heading[2]}
        </Typography.Text>
      );
    }

    const listItem = line.match(/^[-*]\s+(.+)$/);
    if (listItem) {
      return (
        <div key={`${line}-${index}`} className="update-dialog-note">
          <span aria-hidden="true" />
          <Typography.Text>{renderInlineMarkdown(listItem[1])}</Typography.Text>
        </div>
      );
    }

    return (
      <Typography.Paragraph key={`${line}-${index}`} className="update-dialog-paragraph">
        {renderInlineMarkdown(line)}
      </Typography.Paragraph>
    );
  });
}

export function AppShell() {
  const location = useLocation();
  const { mode, setMode } = useThemeMode();
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const selectedKey =
    items.find((item) => item.key !== "/" && location.pathname.startsWith(item.key))?.key ??
    (location.pathname === "/" ? "/" : location.pathname);
  const visibleVersion = updateStatus?.current_version ?? currentVersion;
  const currentVersionLabel = versionLabel(visibleVersion);
  const hasUpdate = Boolean(updateStatus?.update_available);
  const nextVersionLabel = versionLabel(updateStatus?.version, "新版本");
  const updateTitle = hasUpdate ? `可更新至 ${nextVersionLabel}` : updateStatus ? "已是最新版本" : "检查更新";
  const updateSubtitle: string | null = installingUpdate
    ? "正在安装更新"
    : checkingUpdate
      ? "正在连接更新通道"
      : hasUpdate
        ? "安装完成后自动重启"
        : updateStatus
          ? null
          : "等待检查";
  const updateActionLabel = hasUpdate ? "安装并重启" : "检查更新";
  const shouldShowUpdateDialog = hasUpdate && updateStatus?.version;

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
          if (result.update_available && normalizeVersion(result.version) !== readSkippedUpdateVersion()) {
            setUpdateDialogOpen(true);
          }
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
      if (result.update_available) {
        setUpdateDialogOpen(true);
      }
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

  const handleSkipUpdate = () => {
    const version = updateStatus?.version;
    if (!version) {
      setUpdateDialogOpen(false);
      return;
    }
    rememberSkippedUpdateVersion(version);
    setUpdateDialogOpen(false);
    message.info(`已跳过 ${versionLabel(version)}`);
  };

  const handleUpdateCardAction = () => {
    if (hasUpdate) {
      setUpdateDialogOpen(true);
      return;
    }
    void handleCheckUpdate();
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
              <Typography.Text className="app-update-current">{currentVersionLabel}</Typography.Text>
            </div>
            <div className="app-update-main">
              <div className="app-update-icon" aria-hidden="true">
                {hasUpdate ? <DownloadCloud size={16} /> : updateStatus ? <CheckCircle2 size={16} /> : <RefreshCw size={16} />}
              </div>
              <div className="app-update-copy">
                <Typography.Text className="app-update-title">{updateTitle}</Typography.Text>
                {updateSubtitle ? <Typography.Text className="app-update-subtitle">{updateSubtitle}</Typography.Text> : null}
              </div>
            </div>
            <Button
              className="app-update-action"
              size="small"
              block
              type={hasUpdate ? "primary" : "default"}
              onClick={handleUpdateCardAction}
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
      {updateDialogOpen && shouldShowUpdateDialog ? (
        <div className="update-dialog-layer" role="presentation">
          <div className="update-dialog-backdrop" />
          <section className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title">
            <header className="update-dialog-header">
              <div className="update-dialog-titleline">
                <div className="update-dialog-icon" aria-hidden="true">
                  <ArrowDownToLine size={20} />
                </div>
                <div>
                  <Typography.Title id="update-dialog-title" level={3}>
                    发现新版本
                  </Typography.Title>
                  <Typography.Text>安装完成后会自动重启 OpController。</Typography.Text>
                </div>
              </div>
              <button
                className="update-dialog-close"
                type="button"
                aria-label="关闭更新弹窗"
                onClick={() => setUpdateDialogOpen(false)}
              >
                <X size={18} />
              </button>
            </header>
            <div className="update-dialog-body">
              <Typography.Text className="update-dialog-version">{nextVersionLabel}</Typography.Text>
              <Typography.Paragraph className="update-dialog-summary">
                当前版本 {currentVersionLabel}，新版本已可用。
              </Typography.Paragraph>
              <div className="update-dialog-divider" />
              <Typography.Text className="update-dialog-section">更新内容</Typography.Text>
              <div className="update-dialog-notes">{renderReleaseNotes(updateStatus.body)}</div>
            </div>
            <footer className="update-dialog-footer">
              <Button disabled={installingUpdate} onClick={() => setUpdateDialogOpen(false)}>
                取消
              </Button>
              <Button disabled={installingUpdate} onClick={handleSkipUpdate}>
                跳过此版本
              </Button>
              <Button
                type="primary"
                loading={installingUpdate}
                icon={<ArrowDownToLine size={15} />}
                onClick={() => void handleInstallUpdate()}
              >
                立即更新
              </Button>
            </footer>
          </section>
        </div>
      ) : null}
    </Layout>
  );
}
