import { useEffect, useState, useCallback } from 'react';
import { formatUnits } from 'ethers';
import { useTotoRead } from '../hooks/useToto';
import { multicall } from '../hooks/multicall';
import { fmtUsdc } from '../utils/format';
import LotteryBall from '../components/LotteryBall';

const STATE_LABELS = ['Open', 'Drawing', 'Tallying', 'Claimable', 'Expired'];
const STATE_BADGE  = ['badge-open', 'badge-awaiting', 'badge-tallying', 'badge-claimable', 'badge-expired'];

/** Count set bits of a uint64 picks/draw mask (returned by ethers as bigint). */
function popcountBig(x: bigint): number {
  let c = 0;
  while (x > 0n) { c += Number(x & 1n); x >>= 1n; }
  return c;
}

/** Drawn numbers array -> bitmask (bit n set => number n drawn), matching picksMask. */
function drawnToMask(nums: number[]): bigint {
  return nums.reduce((m, n) => m | (1n << BigInt(n)), 0n);
}

/** Integer binomial coefficient for small n,k (n <= 8 here). Mirrors _binom() on-chain. */
function binom(n: number, k: number): number {
  if (k < 0 || n < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

interface RoundData {
  id: number;
  drawTime: number;
  expiryTime: number;
  poolSnapshot: string;
  stake5: string;
  stake6: string;
  state: number;
  drawn5: number[];
  drawn6: number[];
  ticketCount: number;
}

interface TierData {
  totalHits: string;
  budget: string;
  remaining: string;
}

type TierBundle = {
  t5: TierData[];
  t6: TierData[];
  w5: number[];
  w6: number[];
  winnersOk: boolean;
};

// Session-level cache (survives route changes) so re-entering "History"
// renders the round list and any previously-opened tier tables instantly,
// refreshing silently in the background instead of blanking to a spinner.
const historyCache: { rounds: RoundData[]; tiers: Record<number, TierBundle> } = {
  rounds: [],
  tiers: {},
};

// Bound the per-round tier cache so expanding many rounds over a long session
// can't grow it without limit. Keep the highest (newest) round ids.
const TIERS_CAP = 30;
function capTiers(t: Record<number, TierBundle>): Record<number, TierBundle> {
  const keys = Object.keys(t).map(Number);
  if (keys.length <= TIERS_CAP) return t;
  const keep = keys.sort((a, b) => b - a).slice(0, TIERS_CAP);
  const out: Record<number, TierBundle> = {};
  for (const k of keep) out[k] = t[k];
  return out;
}

export default function RoundHistory() {
  const toto = useTotoRead();
  const [rounds, setRounds] = useState<RoundData[]>(historyCache.rounds);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [tiers, setTiers] = useState<TierBundle | null>(null);
  const [tiersLoading, setTiersLoading] = useState(false);
  const [tiersError, setTiersError] = useState(false);
  const [loading, setLoading] = useState(historyCache.rounds.length === 0);

  const fetchRounds = useCallback(async () => {
    try {
      const current = Number(await toto.currentRoundId());
      const ids: number[] = [];
      for (let i = current; i >= 0 && i > current - 20; i--) ids.push(i);

      // Fetch getRoundInfo for all 20 rounds in a single batched eth_call.
      const calls = ids.map((i) => ({ fn: 'getRoundInfo', args: [i] }));
      const res = await multicall(toto, calls);

      const data: RoundData[] = ids.map((i, idx) => {
        const info = res[idx];
        return {
          id: i,
          drawTime: Number(info.drawTime),
          expiryTime: Number(info.expiryTime),
          poolSnapshot: formatUnits(info.poolSnapshot, 6),
          stake5: formatUnits(info.stake5, 6),
          stake6: formatUnits(info.stake6, 6),
          state: Number(info.state),
          drawn5: info.drawn5.map(Number),
          drawn6: info.drawn6.map(Number),
          ticketCount: Number(info.ticketCount),
        };
      });
      historyCache.rounds = data;
      setRounds(data);
    } catch { /* keep cached data instead of blanking */ }
    setLoading(false);
  }, [toto]);

  useEffect(() => { fetchRounds(); }, [fetchRounds]);

  const toggleExpand = async (id: number) => {
    if (expanded === id) { setExpanded(null); setTiers(null); setTiersError(false); return; }
    setExpanded(id);
    setTiersError(false);
    const cached = historyCache.tiers[id];
    if (cached) {
      // Show the previously-loaded table instantly, refresh silently below.
      setTiers(cached);
      setTiersLoading(false);
    } else {
      setTiers(null);
      setTiersLoading(true);
    }
    try {
      const [t5Raw, t6Raw] = await toto.getRoundTiers(id);
      const fmt = (t: any): TierData => ({
        totalHits: t.totalHits.toString(),
        budget: formatUnits(t.budget, 6),
        remaining: formatUnits(t.remaining, 6),
      });

      // Count actual WINNING TICKETS per tier (off-chain): the contract only
      // stores aggregate combination hits, so we enumerate the round's tickets
      // by index (roundTicketCount + roundTicketAt - plain eth_calls, robust on
      // any RPC) and replay the same binomial tier test the contract uses in
      // _tallyOne / _claimSingle.
      const round = rounds.find((rd) => rd.id === id);
      const w5 = [0, 0, 0];      // tiers 3,4,5 (5/35)
      const w6 = [0, 0, 0, 0];   // tiers 3,4,5,6 (6/49)
      let winnersOk = false;
      if (round) {
        try {
          const n = Number(await toto.roundTicketCount(id));
          // Resolve the round's ticket ids, then their ticket structs, in two
          // batched eth_calls instead of 2N sequential requests.
          const tids: bigint[] = await multicall(
            toto,
            Array.from({ length: n }, (_, i) => ({ fn: 'roundTicketAt', args: [id, i] })),
          );
          const tix = (await multicall(
            toto,
            tids.map((tid) => ({ fn: 'tickets', args: [tid] })),
          )).map((t: any) =>
            t
              ? {
                  game: Number(t.game),
                  k: Number(t.k),
                  picksMask: t.picksMask as bigint,
                  refunded: t.refunded as boolean,
                }
              : null,
          );
          const mask5 = drawnToMask(round.drawn5);
          const mask6 = drawnToMask(round.drawn6);
          for (const t of tix) {
            if (!t || t.refunded) continue;          // refunded tickets never win
            const isG5 = t.game === 0;
            const Rg = isG5 ? 5 : 6;                  // numbers drawn for this game
            const m = popcountBig(t.picksMask & (isG5 ? mask5 : mask6));
            const arr = isG5 ? w5 : w6;
            for (let j = 3; j <= Rg; j++) {
              if (binom(m, j) * binom(t.k - m, Rg - j) > 0) arr[j - 3] += 1;
            }
          }
          winnersOk = true;
        } catch { /* leave winnersOk false -> table shows "—" */ }
      }

      const bundle: TierBundle = { t5: t5Raw.map(fmt), t6: t6Raw.map(fmt), w5, w6, winnersOk };
      historyCache.tiers[id] = bundle;
      historyCache.tiers = capTiers(historyCache.tiers);
      // Ignore a slow response if the user collapsed/expanded another round.
      setExpanded((cur) => {
        if (cur === id) setTiers(bundle);
        return cur;
      });
    } catch {
      if (!cached) setTiersError(true); // keep showing cached table on refresh failure
    } finally {
      setTiersLoading(false);
    }
  };

  const fmtDate = (ts: number) => ts === 0 ? '-' : new Date(ts * 1000).toLocaleString();

  if (loading && rounds.length === 0) return <p className="muted">Loading rounds...</p>;

  return (
    <>
      <h2 className="mb-2">
        Round History
        {loading && rounds.length > 0 && (
          <span className="muted" style={{ fontSize: '0.8rem', fontWeight: 400, marginLeft: 10 }}>
            refreshing...
          </span>
        )}
      </h2>

      {rounds.length === 0 && <div className="card text-center"><p className="muted">No rounds yet</p></div>}

      {rounds.map((r) => (
        <div key={r.id} className="card round-card" onClick={() => toggleExpand(r.id)}>
          <div className="round-header">
            <div>
              <strong>Round #{r.id}</strong>
              <span className="muted" style={{ marginLeft: 12, fontSize: '0.85rem' }}>
                {fmtDate(r.drawTime)}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <span className="muted">{r.ticketCount} tickets</span>
              <span className={`badge ${STATE_BADGE[r.state]}`}>{STATE_LABELS[r.state]}</span>
            </div>
          </div>

          {r.drawn5.length > 0 && (
            <>
              <div className="round-drawn-label">Draw 5/35</div>
              <div className="round-drawn">
                {r.drawn5.map((n) => <LotteryBall key={n} number={n} size="md" />)}
              </div>
            </>
          )}

          {r.drawn6.length > 0 && (
            <>
              <div className="round-drawn-label">Draw 6/49</div>
              <div className="round-drawn">
                {r.drawn6.map((n) => <LotteryBall key={n} number={n} size="md" />)}
              </div>
            </>
          )}

          {expanded === r.id && (
            <div className="mt-2" onClick={(e) => e.stopPropagation()}>
              {tiersLoading && <p className="muted" style={{ fontSize: '0.85rem' }}>Loading tiers...</p>}
              {tiersError && !tiersLoading && (
                <p className="muted" style={{ fontSize: '0.85rem' }}>
                  Tiers could not be loaded. Tap the round to try again.
                </p>
              )}
              {tiers && !tiersLoading && (
                <>
                  <p className="muted" style={{ fontSize: '0.85rem', marginBottom: 8 }}>
                    5/35 stakes: <strong>{fmtUsdc(r.stake5)} USDC</strong> &middot;{' '}
                    6/49 stakes: <strong>{fmtUsdc(r.stake6)} USDC</strong> &middot;{' '}
                    Jackpot pool at draw: <strong>{fmtUsdc(r.poolSnapshot)} USDC</strong>
                  </p>
                  <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 4 }}>
                    "Winning tickets" is the number of actual winning tickets in the tier -
                    a single system ticket can win in several tiers.
                  </p>
                  <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 8 }}>
                    "Won" is the total prize for the tier, and "Unclaimed" is the part of it
                    that has not yet been paid out; after the round expires it returns to the general pool.
                  </p>
                  <h4>Tiers 5/35</h4>
                  <table className="tier-table">
                    <thead><tr><th>Tier</th><th>Winning tickets</th><th>Won (USDC)</th><th>Unclaimed</th></tr></thead>
                    <tbody>
                      {[3, 4, 5].map((tier, i) => (
                        <tr key={tier}>
                          <td>Tier {tier}{tier === 5 ? ' (Jackpot)' : ''}</td>
                          <td>{tiers.winnersOk ? tiers.w5[i] : '—'}</td>
                          <td>{fmtUsdc(tiers.t5[i].budget)}</td>
                          <td>{fmtUsdc(tiers.t5[i].remaining)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <h4 className="mt-2">Tiers 6/49</h4>
                  <table className="tier-table">
                    <thead><tr><th>Tier</th><th>Winning tickets</th><th>Won (USDC)</th><th>Unclaimed</th></tr></thead>
                    <tbody>
                      {[3, 4, 5, 6].map((tier, i) => (
                        <tr key={tier}>
                          <td>Tier {tier}{tier === 6 ? ' (Jackpot)' : ''}</td>
                          <td>{tiers.winnersOk ? tiers.w6[i] : '—'}</td>
                          <td>{fmtUsdc(tiers.t6[i].budget)}</td>
                          <td>{fmtUsdc(tiers.t6[i].remaining)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
