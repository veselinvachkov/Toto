// Tiny localStorage wrapper. Survives reloads so returning visitors don't
// re-scan the whole chain history on every page load (the single biggest
// per-client RPC cost). All access is defensive: private-mode / quota / corrupt
// JSON never throws into the UI - it falls back to the provided default.

export function loadCache<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveCache(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or quota exceeded - cache is best-effort only */
  }
}
