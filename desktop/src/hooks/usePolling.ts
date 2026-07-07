import { useEffect, useState } from "react";

type PollingOptions = {
  intervalMs?: number;
  cacheKey?: string;
  enabled?: boolean;
};

const pollingCache = new Map<string, unknown>();

export function setPollingCache<T>(cacheKey: string, value: T) {
  pollingCache.set(cacheKey, value);
}

export async function primePollingCache<T>(cacheKey: string, factory: () => Promise<T>) {
  if (pollingCache.has(cacheKey)) {
    return pollingCache.get(cacheKey) as T;
  }
  const value = await factory();
  setPollingCache(cacheKey, value);
  return value;
}

function normalizeOptions(intervalOrOptions: number | PollingOptions): Required<PollingOptions> {
  if (typeof intervalOrOptions === "number") {
    return {
      intervalMs: intervalOrOptions,
      cacheKey: "",
      enabled: true,
    };
  }
  return {
    intervalMs: intervalOrOptions.intervalMs ?? 8000,
    cacheKey: intervalOrOptions.cacheKey ?? "",
    enabled: intervalOrOptions.enabled ?? true,
  };
}

export function usePolling<T>(factory: () => Promise<T>, intervalOrOptions: number | PollingOptions = 8000) {
  const options = normalizeOptions(intervalOrOptions);
  const cachedData = options.cacheKey ? (pollingCache.get(options.cacheKey) as T | undefined) : undefined;
  const [data, setData] = useState<T | null>(cachedData ?? null);
  const [loading, setLoading] = useState(options.enabled && cachedData === undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let timer: number | undefined;
    let failureCount = 0;
    const cached = options.cacheKey ? (pollingCache.get(options.cacheKey) as T | undefined) : undefined;

    if (!options.enabled) {
      setLoading(false);
      return () => {
        mounted = false;
      };
    }

    if (cached !== undefined) {
      setData(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }

    const nextDelay = () => {
      if (document.visibilityState === "hidden") {
        return Math.max(options.intervalMs * 3, 30000);
      }
      if (failureCount > 0) {
        return Math.min(options.intervalMs * 2 ** Math.min(failureCount, 4), 60000);
      }
      return options.intervalMs;
    };

    const scheduleNext = () => {
      if (mounted) {
        timer = window.setTimeout(() => void load(), nextDelay());
      }
    };

    const load = async () => {
      try {
        const result = await factory();
        if (mounted) {
          if (options.cacheKey) {
            pollingCache.set(options.cacheKey, result);
          }
          setData(result);
          setError(null);
          failureCount = 0;
        }
      } catch (cause) {
        if (mounted) {
          setError(cause instanceof Error ? cause.message : "Unknown error");
          failureCount += 1;
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
      scheduleNext();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && mounted) {
        if (timer !== undefined) {
          window.clearTimeout(timer);
        }
        void load();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    void load();
    return () => {
      mounted = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [factory, options.cacheKey, options.enabled, options.intervalMs]);

  return { data, loading, error };
}
