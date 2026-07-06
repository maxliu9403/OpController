import { Button, Layout, Menu, Typography } from "antd";
import {
  Activity,
  CalendarClock,
  Command,
  Layers3,
  LayoutDashboard,
  Moon,
  RadioTower,
  ScanSearch,
  Sun,
} from "lucide-react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useThemeMode } from "../themeMode";

const { Header, Content, Sider } = Layout;

const items = [
  { key: "/", label: <Link to="/">概览</Link>, icon: <LayoutDashboard size={16} /> },
  { key: "/providers", label: <Link to="/providers">Provider</Link>, icon: <RadioTower size={16} /> },
  { key: "/workflows", label: <Link to="/workflows">流程编排</Link>, icon: <Command size={16} /> },
  { key: "/batches", label: <Link to="/batches">批次</Link>, icon: <Layers3 size={16} /> },
  { key: "/monitor", label: <Link to="/monitor">监控</Link>, icon: <Activity size={16} /> },
  { key: "/schedules", label: <Link to="/schedules">定时</Link>, icon: <CalendarClock size={16} /> },
  { key: "/results", label: <Link to="/results">结果</Link>, icon: <ScanSearch size={16} /> },
];

export function AppShell() {
  const location = useLocation();
  const { mode, setMode } = useThemeMode();
  const selectedKey =
    items.find((item) => item.key !== "/" && location.pathname.startsWith(item.key))?.key ??
    (location.pathname === "/" ? "/" : location.pathname);

  return (
    <Layout className="app-layout">
      <Sider width={280} className="app-sider">
        <div className="brand-panel">
          <Typography.Text className="brand-kicker">OpController</Typography.Text>
          <Typography.Title level={2}>运营控制台</Typography.Title>
          <Typography.Paragraph>
            面向内部平台的多浏览器编排、可视群控与批次复盘工作台。
          </Typography.Paragraph>
        </div>
        <Menu theme={mode === "dark" ? "dark" : "light"} mode="inline" selectedKeys={[selectedKey]} items={items} />
      </Sider>
      <Layout>
        <Header className="app-header">
          <Button
            className="theme-switch"
            size="large"
            shape="circle"
            aria-label={mode === "light" ? "switch to dark theme" : "switch to light theme"}
            icon={mode === "light" ? <Moon size={18} /> : <Sun size={18} />}
            onClick={() => setMode(mode === "light" ? "dark" : "light")}
          />
        </Header>
        <Content className="app-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
