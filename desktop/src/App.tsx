import { ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { RuntimeBootstrap } from "./components/RuntimeBootstrap";
import { ThemeModeContext, type ThemeMode } from "./themeMode";

const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const ProvidersPage = lazy(() => import("./pages/ProvidersPage").then((module) => ({ default: module.ProvidersPage })));
const WorkflowsPage = lazy(() => import("./pages/WorkflowsPage").then((module) => ({ default: module.WorkflowsPage })));
const TaskManagementPage = lazy(() => import("./pages/TaskManagementPage").then((module) => ({ default: module.TaskManagementPage })));
const MonitorPage = lazy(() => import("./pages/MonitorPage").then((module) => ({ default: module.MonitorPage })));
const ResultsPage = lazy(() => import("./pages/ResultsPage").then((module) => ({ default: module.ResultsPage })));

function LazyPage({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="page-loading">页面加载中...</div>}>{children}</Suspense>;
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <LazyPage><DashboardPage /></LazyPage> },
      { path: "providers", element: <LazyPage><ProvidersPage /></LazyPage> },
      { path: "workflows", element: <LazyPage><WorkflowsPage /></LazyPage> },
      { path: "tasks", element: <LazyPage><TaskManagementPage /></LazyPage> },
      { path: "batches", element: <Navigate to="/tasks?tab=instant" replace /> },
      { path: "monitor", element: <LazyPage><MonitorPage /></LazyPage> },
      { path: "schedules", element: <Navigate to="/tasks?tab=scheduled" replace /> },
      { path: "results", element: <LazyPage><ResultsPage /></LazyPage> },
    ],
  },
]);

const THEME_STORAGE_KEY = "opcontroller.theme_mode";

function readInitialThemeMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "light";
  }
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "light";
}

export default function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(readInitialThemeMode);
  const themeContextValue = useMemo(
    () => ({ mode: themeMode, setMode: setThemeMode }),
    [themeMode],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [themeMode]);

  const isLight = themeMode === "light";

  return (
    <ThemeModeContext.Provider value={themeContextValue}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: isLight ? theme.defaultAlgorithm : theme.darkAlgorithm,
          token: {
            colorPrimary: isLight ? "#007aff" : "#0a84ff",
            borderRadius: 14,
            colorBgBase: isLight ? "#f5f5f7" : "#1c1c1e",
            colorTextBase: isLight ? "#1d1d1f" : "#f5f5f7",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Avenir Next', 'PingFang SC', sans-serif",
          },
        }}
      >
        <RuntimeBootstrap>
          <RouterProvider router={router} />
        </RuntimeBootstrap>
      </ConfigProvider>
    </ThemeModeContext.Provider>
  );
}
