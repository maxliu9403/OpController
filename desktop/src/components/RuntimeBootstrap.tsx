import { Button, Result, Space, Spin, Typography } from "antd";
import { PropsWithChildren, useEffect, useState } from "react";
import { api, initializeRuntimeClient } from "../api/client";

const STARTUP_TIMEOUT_MS = 90000;
const RETRY_INTERVAL_MS = 1200;

function describeBootstrapError(cause: unknown) {
  if (cause instanceof Error) {
    return cause.message;
  }
  return "本地 Runtime 启动失败";
}

export function RuntimeBootstrap({ children }: PropsWithChildren) {
  const [ready, setReady] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const startedAt = Date.now();

    const probe = async () => {
      setAttempts((value) => value + 1);
      try {
        await initializeRuntimeClient();
        await api.health();
        if (!cancelled) {
          setReady(true);
          setTimedOut(false);
          setError(null);
        }
        return;
      } catch (cause) {
        if (cancelled) {
          return;
        }
        const nextError = describeBootstrapError(cause);
        const reachedTimeout = Date.now() - startedAt >= STARTUP_TIMEOUT_MS;
        setError(nextError);
        setTimedOut(reachedTimeout);
        if (!reachedTimeout) {
          timer = window.setTimeout(() => void probe(), RETRY_INTERVAL_MS);
        }
      }
    };

    void probe();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  if (ready) {
    return <>{children}</>;
  }

  if (!timedOut) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 32 }}>
        <Space direction="vertical" size={18} align="center">
          <Spin size="large" />
          <Typography.Title level={3} style={{ margin: 0 }}>
            正在启动本地 Runtime
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ maxWidth: 560, textAlign: "center", margin: 0 }}>
            桌面程序正在拉起本地执行引擎并检查指纹浏览器接入状态。首次启动通常需要几秒钟。
          </Typography.Paragraph>
          <Typography.Text type="secondary">探活次数：{attempts}</Typography.Text>
        </Space>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 32 }}>
      <Result
        status="warning"
        title="本地 Runtime 未能在预期时间内就绪"
        subTitle={error ?? "请确认桌面程序已完成 sidecar 启动，然后重试。"}
        extra={
          <Button type="primary" onClick={() => window.location.reload()}>
            重新检测
          </Button>
        }
      />
    </div>
  );
}
