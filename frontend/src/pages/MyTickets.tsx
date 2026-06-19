import { useEffect, useState, useCallback } from 'react';
import { formatUnits } from 'ethers';
import { useAccount } from 'wagmi';
import { useTotoRead, useTotoWrite } from '../hooks/useToto';
import { readProvider } from '../hooks/useEthers';
import { DEPLOY_BLOCK } from '../config/contract';
import { multicall } from '../hooks/multicall';
import { formatError } from '../utils/errors';
import { fmtUsdc } from '../utils/format';
import LotteryBall from '../components/LotteryBall';

const STATE_LABELS = ['Open', 'Drawing', 'Tallying', 'Claimable', 'Expired'];
const STATE_BADGE  = ['badge-open', 'badge-awaiting', 'badge-tallying', 'badge-claimable', 'badge-expired'];

// Public RPCs cap `eth_getLogs` block ranges (publicnode ~10k). Scan the user's
// Claimed history in chunks starting from the deploy block.
const LOG_CHUNK = 9_000;

/** Lightweight ticket data fetched for every ticket up front (cheap calls). */
interface BaseTicket {
  id: number;
  owner: string;
  roundId: number;
  game: number;
  k: number;
  claimed: boolean;
  refunded: boolean;
  picksMask: bigint;
}

/** Winner / payout info - resolved lazily per round when it is expanded. */
interface WinInfo { isWinner: boolean; payout: string; }

interface RoundDetail {
  loading: boolean;
  loaded: boolean;
  wins: Record<number, WinInfo>;
}

function maskToNumbers(mask: bigint, max: number): number[] {
  const nums: number[] = [];
  for (let i = 1; i <= max; i++) {
    if ((mask >> BigInt(i)) & 1n) nums.push(i);
  }
  return nums;
}

function ticketStatus(
  t: BaseTicket,
  roundState: number,
  win: WinInfo | undefined,
): { label: string; badge: string } {
  if (t.refunded) return { label: 'Refunded', badge: 'badge-refunded' };
  if (t.claimed)  return { label: 'Claimed',  badge: 'badge-claimed' };
  if (win?.isWinner) return { label: 'Winner', badge: 'badge-winner' };
  if (win && roundState >= 3) return { label: 'No win', badge: 'badge-refunded' };
  if (roundState >= 3) return { label: 'See result', badge: 'badge-pending' };
  if (roundState === 1 || roundState === 2) return { label: 'Awaiting result', badge: 'badge-pending' };
  return { label: 'Pending', badge: 'badge-pending' };
}

// Session-level cache (survives route changes / component unmount-remount) so
// re-entering "My Tickets" renders instantly from the last known data and
// only refreshes silently in the background. Keyed by wallet address.
const ticketCache: {
  address?: string;
  base: BaseTicket[];
  roundStates: Record<number, number>;
  details: Record<number, RoundDetail>;
  // ticketId -> claimed payout (formatted USDC). Sourced from Claimed events,
  // since previewClaim() returns 0 once a ticket has been claimed.
  claimedAmounts: Record<number, string>;
} = { base: [], roundStates: {}, details: {}, claimedAmounts: {} };

export default function MyTickets() {
  const { address } = useAccount();
  const toto = useTotoRead();
  const totoW = useTotoWrite();

  const hasCache = !!address && ticketCache.address === address;
  const [baseTickets, setBaseTickets] = useState<BaseTicket[]>(
    hasCache ? ticketCache.base : [],
  );
  const [roundStates, setRoundStates] = useState<Record<number, number>>(
    hasCache ? ticketCache.roundStates : {},
  );
  const [details, setDetails] = useState<Record<number, RoundDetail>>(
    hasCache ? ticketCache.details : {},
  );
  const [claimedAmounts, setClaimedAmounts] = useState<Record<number, string>>(
    hasCache ? ticketCache.claimedAmounts : {},
  );
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'pending'; text: string } | null>(null);

  // Transfer modal
  const [transferId, setTransferId] = useState<number | null>(null);
  const [transferTo, setTransferTo] = useState('');

  /** Fetch the cheap per-ticket data + each round's state. No winner lookups.
   *  Returns the freshly loaded list so callers can act on it without waiting
   *  for the async state update to commit. */
  const fetchBase = useCallback(async (): Promise<BaseTicket[]> => {
    if (!address) return [];
    setLoading(true);
    try {
      const ids: bigint[] = await toto.getUserTickets(address);

      // One batched eth_call for every ticket instead of one request each.
      const ticketResults = await multicall(
        toto,
        ids.map((id) => ({ fn: 'tickets', args: [id] })),
      );
      const raw: BaseTicket[] = ids
        .map((rawId, i) => {
          const t = ticketResults[i];
          if (!t) return null;
          return {
            id: Number(rawId),
            owner: t.owner,
            roundId: Number(t.roundId),
            game: Number(t.game),
            k: Number(t.k),
            claimed: t.claimed,
            refunded: t.refunded,
            picksMask: t.picksMask,
          } as BaseTicket;
        })
        .filter((t): t is BaseTicket => t !== null);
      const mine = raw.filter((t) => t.owner.toLowerCase() === address.toLowerCase());

      // One batched eth_call for every round's state.
      const rids = [...new Set(mine.map((t) => t.roundId))];
      const infos = await multicall(
        toto,
        rids.map((r) => ({ fn: 'getRoundInfo', args: [r] })),
      );
      const rsMap: Record<number, number> = {};
      rids.forEach((r, i) => { rsMap[r] = infos[i] ? Number(infos[i].state) : 0; });

      setBaseTickets(mine);
      setRoundStates(rsMap);
      // Refresh the session cache (and drop a different wallet's stale data).
      ticketCache.address = address;
      ticketCache.base = mine;
      ticketCache.roundStates = rsMap;
      setLoading(false);
      return mine;
    } catch { /* keep previous data instead of blanking */ }
    setLoading(false);
    return baseTickets;
  }, [address, toto, baseTickets]);

  useEffect(() => { fetchBase(); }, [address]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Resolve the payout of every ticket this wallet has CLAIMED. previewClaim()
   *  returns 0 after a claim, so the amount only survives in the Claimed event
   *  (indexed by owner). Scanned in parallel chunks from the deploy block. */
  const fetchClaimedAmounts = useCallback(async () => {
    if (!address) return;
    try {
      const filter = toto.filters.Claimed(undefined, address);
      const latest = await readProvider.getBlockNumber();
      const chunks: Array<{ f: number; t: number }> = [];
      for (let f = DEPLOY_BLOCK; f <= latest; f += LOG_CHUNK + 1) {
        chunks.push({ f, t: Math.min(f + LOG_CHUNK, latest) });
      }
      const amounts: Record<number, string> = {};
      const CONCURRENCY = 6;
      let next = 0;
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (i >= chunks.length) return;
          try {
            const logs = await toto.queryFilter(filter, chunks[i].f, chunks[i].t);
            for (const log of logs as any[]) {
              amounts[Number(log.args[0])] = formatUnits(log.args[2], 6);
            }
          } catch { /* skip window, keep what we have */ }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker),
      );
      setClaimedAmounts(amounts);
      ticketCache.claimedAmounts = amounts;
    } catch { /* keep previous amounts */ }
  }, [address, toto]);

  useEffect(() => { fetchClaimedAmounts(); }, [fetchClaimedAmounts]);

  /** Resolve isWinner / previewClaim for one round's tickets (lazy, cached). */
  const loadRoundDetail = useCallback(async (roundId: number, source?: BaseTicket[]) => {
    setDetails((d) => ({ ...d, [roundId]: { loading: true, loaded: false, wins: d[roundId]?.wins ?? {} } }));
    const tix = (source ?? baseTickets).filter((t) => t.roundId === roundId);
    const wins: Record<number, WinInfo> = {};

    // Claimed/refunded tickets never need a winner lookup.
    const pending = tix.filter((t) => !t.claimed && !t.refunded);
    tix.filter((t) => t.claimed || t.refunded).forEach((t) => { wins[t.id] = { isWinner: false, payout: '0' }; });

    // Batch isWinner for all pending tickets in one call, then batch
    // previewClaim only for the winners in a second call.
    const iwResults = await multicall(toto, pending.map((t) => ({ fn: 'isWinner', args: [t.id] })));
    const winners = pending.filter((_, i) => iwResults[i] === true);
    const payoutResults = await multicall(toto, winners.map((t) => ({ fn: 'previewClaim', args: [t.id] })));
    const payoutById: Record<number, string> = {};
    winners.forEach((t, i) => {
      payoutById[t.id] = payoutResults[i] != null ? formatUnits(payoutResults[i], 6) : '0';
    });
    pending.forEach((t, i) => {
      const iw = iwResults[i] === true;
      wins[t.id] = { isWinner: iw, payout: iw ? (payoutById[t.id] ?? '0') : '0' };
    });
    const done: RoundDetail = { loading: false, loaded: true, wins };
    setDetails((d) => ({ ...d, [roundId]: done }));
    ticketCache.details = { ...ticketCache.details, [roundId]: done };
  }, [baseTickets, toto]);

  // Eagerly resolve winner info for rounds in the "Claimable" state so the
  // round-state badge can reflect whether *this user* still has winnings to
  // collect - it must not show "Claimable" once everything is claimed.
  useEffect(() => {
    const claimable = [...new Set(baseTickets.map((t) => t.roundId))]
      .filter((r) => roundStates[r] === 3 && !details[r]?.loaded && !details[r]?.loading);
    for (const r of claimable) loadRoundDetail(r);
  }, [baseTickets, roundStates]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleRound = (roundId: number) => {
    const willOpen = !expanded[roundId];
    setExpanded((e) => ({ ...e, [roundId]: willOpen }));
    if (willOpen && !details[roundId]?.loaded && !details[roundId]?.loading) {
      loadRoundDetail(roundId);
    }
  };

  /** Re-pull base data and refresh any rounds the user has open. */
  const refresh = useCallback(async () => {
    const fresh = await fetchBase();
    fetchClaimedAmounts(); // pick up the payout of any just-claimed ticket
    const openRounds = Object.entries(expanded).filter(([, v]) => v).map(([k]) => Number(k));
    setDetails({});
    ticketCache.details = {}; // stale after a claim/refund/transfer
    for (const r of openRounds) loadRoundDetail(r, fresh);
  }, [fetchBase, fetchClaimedAmounts, expanded, loadRoundDetail]);

  const runTx = async (id: number, pending: string, ok: string, fn: () => Promise<any>) => {
    if (!totoW) return;
    setBusy(id);
    setMsg({ type: 'pending', text: pending });
    try {
      const tx = await fn();
      setMsg({ type: 'pending', text: 'Waiting for confirmation...' });
      await tx.wait();
      setMsg({ type: 'success', text: ok });
      refresh();
    } catch (e: any) {
      setMsg({ type: 'error', text: formatError(e) });
    } finally {
      setBusy(null);
    }
  };

  const handleClaim = (id: number) =>
    runTx(id, `Claiming winnings from ticket #${id}...`, `Winnings from ticket #${id} claimed!`,
      () => totoW!.claim(id));

  const handleRefund = (id: number) =>
    runTx(id, `Refunding ticket #${id}...`, `Ticket #${id} refunded!`,
      () => totoW!.refund(id));

  const handleClaimRound = (roundId: number, winnerIds: number[]) =>
    runTx(-roundId - 1,
      `Claiming ${winnerIds.length} winnings from round #${roundId}...`,
      `Winnings from ${winnerIds.length} ticket(s) claimed!`,
      () => totoW!.claimBatch(winnerIds));

  const handleTransfer = async () => {
    if (!totoW || transferId === null || !transferTo) return;
    setBusy(transferId);
    setMsg({ type: 'pending', text: `Transferring ticket #${transferId}...` });
    try {
      const tx = await totoW.transferTicket(transferId, transferTo);
      setMsg({ type: 'pending', text: `Waiting for confirmation for ticket #${transferId}...` });
      await tx.wait();
      setMsg({ type: 'success', text: `Ticket #${transferId} transferred!` });
      setTransferId(null);
      setTransferTo('');
      refresh();
    } catch (e: any) {
      setMsg({ type: 'error', text: formatError(e) });
    } finally {
      setBusy(null);
    }
  };

  if (!address) {
    return <div className="card text-center mt-3"><p className="muted">Connect your wallet to see your tickets</p></div>;
  }

  // Group ticket ids by round, newest round first.
  const rounds = [...new Set(baseTickets.map((t) => t.roundId))].sort((a, b) => b - a);

  return (
    <>
      <div className="tickets-header">
        <h2>
          My Tickets ({baseTickets.length})
          {loading && baseTickets.length > 0 && (
            <span className="muted" style={{ fontSize: '0.8rem', fontWeight: 400, marginLeft: 10 }}>
              refreshing...
            </span>
          )}
        </h2>
      </div>

      {msg && <div className={`alert alert-${msg.type}`}>{msg.text}</div>}

      {loading && baseTickets.length === 0 && <p className="muted">Loading tickets...</p>}

      {!loading && baseTickets.length === 0 && (
        <div className="card text-center"><p className="muted">You have no tickets yet</p></div>
      )}

      {rounds.map((roundId) => {
        const roundTickets = baseTickets
          .filter((t) => t.roundId === roundId)
          .sort((a, b) => b.id - a.id);
        const rState = roundStates[roundId] ?? 0;
        const detail = details[roundId];
        const isOpen = !!expanded[roundId];
        const winnerIds = detail?.loaded
          ? roundTickets
              .filter((t) => detail.wins[t.id]?.isWinner && !t.claimed && !t.refunded)
              .map((t) => t.id)
          : [];

        return (
          <div className="card round-card round-group" key={roundId}>
            <div className="round-header" onClick={() => toggleRound(roundId)}>
              <div>
                <span className="round-chevron">{isOpen ? '▾' : '▸'}</span>
                <strong>Round #{roundId}</strong>
                <span className="muted" style={{ marginLeft: 12, fontSize: '0.85rem' }}>
                  {roundTickets.length} tickets
                </span>
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                {detail?.loaded && winnerIds.length > 0 && (
                  <span className="badge badge-winner">{winnerIds.length} winners</span>
                )}
                {(rState !== 3 || winnerIds.length > 0) && (
                  <span className={`badge ${STATE_BADGE[rState]}`}>{STATE_LABELS[rState]}</span>
                )}
              </div>
            </div>

            {isOpen && (
              <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                {detail?.loading && <p className="muted">Loading results...</p>}

                {detail?.loaded && winnerIds.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <button
                      className="btn btn-success btn-sm"
                      disabled={busy !== null}
                      onClick={() => handleClaimRound(roundId, winnerIds)}
                    >
                      {busy === -roundId - 1 ? 'Claiming...' : `Claim all winnings for round #${roundId} (${winnerIds.length})`}
                    </button>
                  </div>
                )}

                {roundTickets.map((t) => {
                  const max = t.game === 0 ? 35 : 49;
                  const nums = maskToNumbers(t.picksMask, max);
                  const win = detail?.wins[t.id];
                  const st = ticketStatus(t, rState, win);
                  const roundOpen = rState === 0;
                  const canRefund = roundOpen && !t.claimed && !t.refunded && !win?.isWinner;
                  const canTransfer = roundOpen && !t.claimed && !t.refunded;

                  return (
                    <div className="ticket-card" key={t.id}>
                      <div className="ticket-info">
                        <h4>
                          Ticket #{t.id}
                          <span className="muted" style={{ fontWeight: 400, fontSize: '0.85rem', marginLeft: 8 }}>
                            {t.game === 0 ? '5/35' : '6/49'}
                          </span>
                        </h4>
                        <div className="ticket-balls">
                          {nums.map((n) => <LotteryBall key={n} number={n} size="sm" />)}
                        </div>
                      </div>

                      <span className={`badge ${st.badge}`}>{st.label}</span>

                      {win?.isWinner && !t.claimed && (
                        <span style={{ fontWeight: 700, color: 'var(--clr-success)' }}>{fmtUsdc(win.payout)} USDC</span>
                      )}

                      {t.claimed && claimedAmounts[t.id] != null && (
                        <span style={{ fontWeight: 700, color: 'var(--clr-success)' }}>{fmtUsdc(claimedAmounts[t.id])} USDC</span>
                      )}

                      <div className="ticket-actions">
                        {win?.isWinner && !t.claimed && (
                          <button className="btn btn-success btn-sm" disabled={busy !== null} onClick={() => handleClaim(t.id)}>
                            {busy === t.id ? '...' : 'Claim'}
                          </button>
                        )}
                        {canRefund && (
                          <button className="btn btn-outline btn-sm" disabled={busy !== null} onClick={() => handleRefund(t.id)}>
                            Refund
                          </button>
                        )}
                        {canTransfer && (
                          <button className="btn btn-outline btn-sm" disabled={busy !== null} onClick={() => { setTransferId(t.id); setTransferTo(''); }}>
                            Transfer
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Transfer modal */}
      {transferId !== null && (
        <div className="modal-overlay" onClick={() => setTransferId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Transfer ticket #{transferId}</h3>
            <div className="admin-field">
              <label>Recipient address</label>
              <input
                type="text"
                placeholder="0x..."
                value={transferTo}
                onChange={(e) => setTransferTo(e.target.value)}
              />
            </div>
            <div className="modal-actions">
              <button className="btn btn-outline" onClick={() => setTransferId(null)}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={busy !== null || !transferTo}
                onClick={handleTransfer}
              >
                {busy === transferId ? 'Transferring...' : 'Transfer'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
