import { ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
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

export default function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: "#f4a300",
          borderRadius: 18,
          colorBgBase: "#101114",
          colorTextBase: "#f6f1e8",
          fontFamily: "'IBM Plex Sans', 'PingFang SC', sans-serif",
        },
      }}
    >
      <RuntimeBootstrap>
        <RouterProvider router={router} />
      </RuntimeBootstrap>
    </ConfigProvider>
  );
}
