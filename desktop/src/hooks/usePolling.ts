import { useEffect, useState } from "react";

export function usePolling<T>(factory: () => Promise<T>, intervalMs = 8000) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      try {
        const result = await factory();
        if (mounted) {
          setData(result);
          setError(null);
        }
      } catch (cause) {
        if (mounted) {
          setError(cause instanceof Error ? cause.message : "Unknown error");
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), intervalMs);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [factory, intervalMs]);

  return { data, loading, error };
}

