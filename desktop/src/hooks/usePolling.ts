import { useEffect, useMemo, useState } from "react";

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
  const options = useMemo(() => normalizeOptions(intervalOrOptions), [intervalOrOptions]);
  const cachedData = options.cacheKey ? (pollingCache.get(options.cacheKey) as T | undefined) : undefined;
  const [data, setData] = useState<T | null>(cachedData ?? null);
  const [loading, setLoading] = useState(options.enabled && cachedData === undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let timer: number | undefined;
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

    const load = async () => {
      try {
        const result = await factory();
        if (mounted) {
          if (options.cacheKey) {
            pollingCache.set(options.cacheKey, result);
          }
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
        timer = window.setTimeout(() => void load(), options.intervalMs);
      }
    };

    void load();
    return () => {
      mounted = false;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [factory, options.cacheKey, options.enabled, options.intervalMs]);

  return { data, loading, error };
}
