import { ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useEffect, useMemo, useState } from "react";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { RuntimeBootstrap } from "./components/RuntimeBootstrap";
import { BatchesPage } from "./pages/BatchesPage";
import { DashboardPage } from "./pages/DashboardPage";
import { MonitorPage } from "./pages/MonitorPage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { ResultsPage } from "./pages/ResultsPage";
import { SchedulesPage } from "./pages/SchedulesPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";
import { ThemeModeContext, type ThemeMode } from "./themeMode";

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "providers", element: <ProvidersPage /> },
      { path: "workflows", element: <WorkflowsPage /> },
      { path: "batches", element: <BatchesPage /> },
      { path: "monitor", element: <MonitorPage /> },
      { path: "schedules", element: <SchedulesPage /> },
      { path: "results", element: <ResultsPage /> },
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
