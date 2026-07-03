import { useEffect, useRef, useState } from 'react';
import { useTotoRead } from '../hooks/useToto';
import { readProvider } from '../hooks/useEthers';
import { usePolling } from '../hooks/usePolling';
import { CONTRACT_ADDRESS, DEPLOY_BLOCK } from '../config/contract';
import { loadCache, saveCache } from '../utils/persist';
import { fmtUsdc } from '../utils/format';

// Public RPCs cap `eth_getLogs` block ranges (publicnode ~10k). Query the
// Claimed history in chunks starting from the deploy block instead of genesis.
const LOG_CHUNK = 9_000;

// The board only ever shows the top 5. We keep a small bounded buffer of the
// largest distinct wins so the cache CANNOT grow without limit no matter how
// many claims happen over the protocol's lifetime - the previous "Map of every
// Claimed event ever" grew unbounded in browser memory.
const TOP_KEEP = 25;

interface Entry {
  ticketId: string;
  owner: string;
  amount: number; // USDC, parsed
}

const SHORT_ADDR = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

// Persisted, contract-scoped cache. Keyed by contract address so a redeploy
// auto-invalidates stale data. Survives reloads: a returning visitor only
// scans the handful of new blocks since `scannedTo` instead of re-scanning the
// entire history from the deploy block on every load.
type LbCache = { top: Entry[]; scannedTo: number };
const STORAGE_KEY = `toto:lb:${CONTRACT_ADDRESS.toLowerCase()}`;

const cache: LbCache = (() => {
  const c = loadCache<LbCache>(STORAGE_KEY, { top: [], scannedTo: DEPLOY_BLOCK - 1 });
  if (!Array.isArray(c.top) || typeof c.scannedTo !== 'number') {
    return { top: [], scannedTo: DEPLOY_BLOCK - 1 };
  }
  return c;
})();
let inflight: Promise<void> | null = null;

// Collapse by (owner, amount) so one winner who claims many identical tickets
// fills a single slot, then keep only the largest TOP_KEEP. Bounded by design.
function mergeTop(existing: Entry[], incoming: Entry[]): Entry[] {
  const distinct = new Map<string, Entry>();
  for (const e of [...existing, ...incoming]) {
    const key = `${e.owner.toLowerCase()}|${e.amount}`;
    if (!distinct.has(key)) distinct.set(key, e);
  }
  return [...distinct.values()].sort((a, b) => b.amount - a.amount).slice(0, TOP_KEEP);
}

export default function Leaderboard() {
  const toto = useTotoRead();
  const [entries, setEntries] = useState<Entry[]>(() => cache.top.slice(0, 5));
  const [loading, setLoading] = useState(cache.top.length === 0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = async () => {
    const publish = () => {
      if (mounted.current) {
        setEntries(cache.top.slice(0, 5));
        setLoading(false);
      }
    };

    // Coalesce concurrent loads (mount + interval) into one scan.
    if (inflight) { await inflight; publish(); return; }

    inflight = (async () => {
      try {
        const latest = await readProvider.getBlockNumber();
        if (latest <= cache.scannedTo) return;

        const from = cache.scannedTo + 1;
        const filter = toto.filters.Claimed();
        const windows: Array<{ f: number; t: number }> = [];
        for (let f = from; f <= latest; f += LOG_CHUNK + 1) {
          windows.push({ f, t: Math.min(f + LOG_CHUNK, latest) });
        }

        // Bounded-concurrency parallel scan; each window publishes as it returns
        // so the board fills progressively instead of blocking on the whole
        // history. `scannedTo` only advances across the leading run of OK
        // windows, so a failed window is retried on the next refresh.
        const CONCURRENCY = 6;
        const ok = new Array<boolean>(windows.length).fill(false);
        let next = 0;
        const worker = async () => {
          while (mounted.current) {
            const i = next++;
            if (i >= windows.length) return;
            try {
              const logs = await toto.queryFilter(filter, windows[i].f, windows[i].t);
              const fresh: Entry[] = (logs as any[]).map((log) => ({
                ticketId: log.args[0].toString(),
                owner: log.args[1] as string,
                amount: Number(log.args[2]) / 1e6,
              }));
              cache.top = mergeTop(cache.top, fresh);
              ok[i] = true;
              publish();
            } catch { /* leave ok[i] false -> retried on next refresh */ }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, windows.length) }, worker),
        );

        let prefix = 0;
        while (prefix < windows.length && ok[prefix]) prefix++;
        if (prefix > 0) cache.scannedTo = windows[prefix - 1].t;
        saveCache(STORAGE_KEY, cache);
      } catch { /* keep previously loaded entries */ }
    })();

    try { await inflight; } finally { inflight = null; }
    publish();
  };

  // Refreshes only while the tab is visible (see usePolling).
  usePolling(() => { load(); }, 30_000);

  return (
    <aside className="leaderboard card">
      <h3 className="mb-1" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          width="1.2em"
          height="1.2em"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="trophyGold" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#FFE082" />
              <stop offset="50%" stopColor="#FFC107" />
              <stop offset="100%" stopColor="#B8860B" />
            </linearGradient>
          </defs>
          <path
            fill="url(#trophyGold)"
            stroke="#7A5200"
            strokeWidth="0.5"
            d="M7 3h10v2h3a2 2 0 0 1 2 2v2a4 4 0 0 1-4 4h-.4a6 6 0 0 1-4.6 4.9V20h3a1 1 0 0 1 1 1v1H7v-1a1 1 0 0 1 1-1h3v-2.1A6 6 0 0 1 6.4 13H6a4 4 0 0 1-4-4V7a2 2 0 0 1 2-2h3V3zm0 4H4v2a2 2 0 0 0 2 2h1V7zm10 0v4h1a2 2 0 0 0 2-2V7h-3z"
          />
        </svg>
        Top 5 wins
      </h3>
      <p className="muted mb-2" style={{ fontSize: '0.8rem' }}>
        The largest payouts of all time
      </p>

      {loading && <p className="muted" style={{ fontSize: '0.85rem' }}>Loading...</p>}

      {!loading && entries.length === 0 && (
        <p className="muted" style={{ fontSize: '0.85rem' }}>No wins yet</p>
      )}

      {!loading && entries.length > 0 && (
        <ol className="leaderboard-list">
          {entries.map((e, i) => (
            <li key={`${e.ticketId}-${i}`}>
              <span className="lb-rank">#{i + 1}</span>
              <span className="lb-addr" title={e.owner}>{SHORT_ADDR(e.owner)}</span>
              <span className="lb-amount">{fmtUsdc(e.amount)} USDC</span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
