import { Card, Empty, List, Space, Tag, Typography } from "antd";
import { useEffect, useState } from "react";
import { api } from "../api/client";

type MonitorEvent = {
  type: string;
  payload: Record<string, unknown>;
};

export function MonitorPage() {
  const [events, setEvents] = useState<MonitorEvent[]>([]);

  useEffect(() => {
    const socket = new WebSocket(api.monitorStreamUrl());
    socket.onmessage = (event) => {
      const parsed = JSON.parse(event.data) as MonitorEvent;
      setEvents((current) => [parsed, ...current].slice(0, 40));
    };
    return () => socket.close();
  }, []);

  return (
    <Space direction="vertical" size={24} style={{ width: "100%" }}>
      <Card className="section-card">
        <Typography.Title level={3}>运行监控</Typography.Title>
        <Typography.Paragraph type="secondary">
          这里展示 sidecar 通过 WebSocket 推送的批次、任务、定时和 Provider 事件流。
        </Typography.Paragraph>
      </Card>
      {events.length ? (
        <List
          dataSource={events}
          renderItem={(item) => (
            <List.Item className="monitor-event">
              <Space align="start" size={18}>
                <Tag color="cyan">{item.type}</Tag>
                <pre>{JSON.stringify(item.payload, null, 2)}</pre>
              </Space>
            </List.Item>
          )}
        />
      ) : (
        <Empty description="等待第一条运行事件..." />
      )}
    </Space>
  );
}
