import { useEffect, useState } from "react";

export function usePolling<T>(factory: () => Promise<T>, intervalMs = 8000) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let timer: number | undefined;

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
      if (mounted) {
        timer = window.setTimeout(() => void load(), intervalMs);
      }
    };

    void load();
    return () => {
      mounted = false;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [factory, intervalMs]);

  return { data, loading, error };
}
