import { env } from "../config/env.js";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

/**
 * Stable cache key from a request.
 * Order-independent for object keys (JSON.stringify order matters, so we sort top-level keys).
 */
export function cacheKey(prefix: string, payload: unknown): string {
  return `${prefix}::${stableStringify(payload)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

export function cacheSet<T>(key: string, value: T): void {
  if (env.ROUTE_CACHE_TTL_MS <= 0) return;
  if (store.size >= env.ROUTE_CACHE_MAX_ENTRIES) {
    // Evict the oldest entry (Map preserves insertion order)
    const oldestKey = store.keys().next().value;
    if (oldestKey) store.delete(oldestKey);
  }
  store.set(key, {
    value,
    expiresAt: Date.now() + env.ROUTE_CACHE_TTL_MS,
  });
}

export function cacheClear(): void {
  store.clear();
}

/** For tests */
export function cacheSize(): number {
  return store.size;
}