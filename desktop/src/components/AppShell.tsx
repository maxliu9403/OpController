import { Layout, Menu, Space, Typography } from "antd";
import {
  Activity,
  CalendarClock,
  Command,
  Layers3,
  LayoutDashboard,
  RadioTower,
  ScanSearch,
} from "lucide-react";
import { Link, Outlet, useLocation } from "react-router-dom";

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
        <Menu theme="dark" mode="inline" selectedKeys={[selectedKey]} items={items} />
      </Sider>
      <Layout>
        <Header className="app-header">
          <Space direction="vertical" size={0}>
            <Typography.Text className="header-chip">Desktop V1</Typography.Text>
            <Typography.Title level={4}>指纹浏览器编排与批处理平台</Typography.Title>
          </Space>
        </Header>
        <Content className="app-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}

