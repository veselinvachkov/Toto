import { useEffect, useState, useCallback } from 'react';
import { formatUnits, parseUnits } from 'ethers';
import { useAccount } from 'wagmi';
import { useTotoRead, useTotoWrite, useUsdcRead, useUsdcWrite } from '../hooks/useToto';
import { multicall } from '../hooks/multicall';
import { formatError } from '../utils/errors';
import { fmtUsdc, fmtUsdcSmart } from '../utils/format';

interface Tranche {
  index: number;
  shares: bigint;
  unlockRoundId: number;
  liveValue: string;        // value at the current LIVE rate (live totalAssets / totalShares)
  snapshotValue: string;    // value at the current round's SNAPSHOT rate (what withdraw uses)
}

const STATE_LABELS = ['Open', 'Drawing', 'Tallying', 'Claimable', 'Expired'];

/// Mirror of `LP_VIRTUAL_SHARES` constant in `BulgarianTotoStorage.sol`.
const LP_VIRTUAL_SHARES = 1_000_000n;

export default function LP() {
  const { address } = useAccount();
  const toto = useTotoRead();
  const totoW = useTotoWrite();
  const usdcR = useUsdcRead();
  const usdcW = useUsdcWrite();

  const [currentRoundId, setCurrentRoundId] = useState(0);
  const [currentRoundState, setCurrentRoundState] = useState(0);
  const [unfinalizedRounds, setUnfinalizedRounds] = useState(0);
  const [availablePool, setAvailablePool] = useState(0n);
  const [lpMinPool, setLpMinPool] = useState(0n);
  const [totalLpAssets, setTotalLpAssets] = useState('0');
  const [totalLpShares, setTotalLpShares] = useState(0n);
  const [snapAssets, setSnapAssets] = useState('0');
  const [snapShares, setSnapShares] = useState(0n);
  const [tranches, setTranches] = useState<Tranche[]>([]);

  const [depositAmt, setDepositAmt] = useState('');
  const [previewShares, setPreviewShares] = useState<bigint>(0n);
  const [withdrawUsdc, setWithdrawUsdc] = useState<{ [idx: number]: string }>({});

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'pending'; text: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      // Pool-level globals in one batched eth_call.
      const [rid, ufr, tla, tls, ap, minPool] = await multicall(toto, [
        { fn: 'currentRoundId' },
        { fn: 'unfinalizedRounds' },
        { fn: 'totalLpAssets' },
        { fn: 'totalLpShares' },
        { fn: 'availablePool' },
        { fn: 'LP_MIN_POOL' },
      ]);
      const ridNum = Number(rid);
      setCurrentRoundId(ridNum);
      setUnfinalizedRounds(Number(ufr));
      setTotalLpAssets(formatUnits(tla, 6));
      setTotalLpShares(BigInt(tls));
      setAvailablePool(BigInt(ap));
      setLpMinPool(BigInt(minPool));

      // Round state, snapshot, and the user's tranche count in one more batch.
      const [info, snap, trancheCountRaw] = await multicall(toto, [
        { fn: 'getRoundInfo', args: [rid] },
        { fn: 'lpSnapshot', args: [rid] },
        ...(address ? [{ fn: 'lpTrancheCount', args: [address] }] : []),
      ]);
      setCurrentRoundState(Number(info.state));
      setSnapAssets(formatUnits(snap.assets, 6));
      setSnapShares(BigInt(snap.shares));

      if (address) {
        const count = Number(trancheCountRaw);
        const tList: Tranche[] = [];
        const liveAssets = BigInt(tla);
        const liveShares = BigInt(tls);
        const snapAssetsBI = BigInt(snap.assets);
        const snapSharesBI = BigInt(snap.shares);
        // All tranches in one batched eth_call instead of one request each.
        const trancheResults = await multicall(
          toto,
          Array.from({ length: count }, (_, i) => ({ fn: 'lpTrancheAt', args: [address, i] })),
        );
        for (let i = 0; i < count; i++) {
          const t = trancheResults[i];
          if (!t) continue;
          const sharesBI = BigInt(t.shares);
          if (sharesBI === 0n) continue; // skip fully-withdrawn tranches
          const liveVal = (sharesBI * (liveAssets + 1n)) / (liveShares + LP_VIRTUAL_SHARES);
          const snapVal = (sharesBI * (snapAssetsBI + 1n)) / (snapSharesBI + LP_VIRTUAL_SHARES);
          tList.push({
            index: i,
            shares: sharesBI,
            unlockRoundId: Number(t.unlockRoundId),
            liveValue: formatUnits(liveVal, 6),
            snapshotValue: formatUnits(snapVal, 6),
          });
        }
        setTranches(tList);
      } else {
        setTranches([]);
      }
    } catch { /* not deployed */ }
    setLoading(false);
  }, [toto, address]);

  useEffect(() => { fetchData(); const id = setInterval(fetchData, 15000); return () => clearInterval(id); }, [fetchData]);

  // Live preview of shares for the typed deposit amount.
  useEffect(() => {
    if (!depositAmt || Number(depositAmt) <= 0) { setPreviewShares(0n); return; }
    let cancelled = false;
    (async () => {
      try {
        const amt = parseUnits(depositAmt, 6);
        const s = await toto.previewLpDeposit(amt);
        if (!cancelled) setPreviewShares(BigInt(s));
      } catch {
        if (!cancelled) setPreviewShares(0n);
      }
    })();
    return () => { cancelled = true; };
  }, [depositAmt, toto]);

  const handleDeposit = async () => {
    if (!totoW || !usdcW || !usdcR || !address || !depositAmt) return;
    setBusy(true);
    setMsg(null);
    try {
      const amt = parseUnits(depositAmt, 6);
      const spender = await totoW.getAddress();

      const [bal, currentAllowance] = await Promise.all([
        usdcR.balanceOf(address),
        usdcR.allowance(address, spender),
      ]);
      if (bal < amt) {
        setMsg({ type: 'error', text: `Insufficient USDC balance: you have ${formatUnits(bal, 6)}, need ${depositAmt}` });
        setBusy(false);
        return;
      }

      if (currentAllowance < amt) {
        setMsg({ type: 'pending', text: 'Approving USDC...' });
        const approveTx = await usdcW.approve(spender, amt);
        await approveTx.wait();
      }

      setMsg({ type: 'pending', text: 'Depositing...' });
      const tx = await totoW.depositLp(amt);
      await tx.wait();
      setMsg({ type: 'success', text: 'Deposit successful!' });
      setDepositAmt('');
      fetchData();
    } catch (e: any) {
      setMsg({ type: 'error', text: formatError(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleWithdraw = async (trancheIndex: number, maxShares: bigint) => {
    if (!totoW) return;
    const raw = withdrawUsdc[trancheIndex];
    let burnAmt: bigint;
    if (!raw || raw.trim() === '') {
      // Empty input => withdraw all of this tranche.
      burnAmt = maxShares;
    } else {
      // User typed a USDC amount. Convert to shares using the SNAPSHOT rate
      // (the rate withdrawLp uses on-chain), then clamp to the tranche size.
      let usdcAmt: bigint;
      try {
        usdcAmt = parseUnits(raw, 6);
      } catch {
        setMsg({ type: 'error', text: 'Invalid USDC amount' });
        return;
      }
      if (usdcAmt === 0n) { setMsg({ type: 'error', text: 'Amount must be > 0' }); return; }
      // shares = usdcAmt * (snapShares + virtualShares) / (snapAssets + 1)
      const snapAssetsBI = parseUnits(snapAssets, 6);
      burnAmt = (usdcAmt * (snapShares + LP_VIRTUAL_SHARES)) / (snapAssetsBI + 1n);
      if (burnAmt > maxShares) burnAmt = maxShares;
    }
    if (burnAmt === 0n) {
      setMsg({ type: 'error', text: 'Amount is too small - it would burn 0 shares' });
      return;
    }
    setBusy(true);
    setMsg({ type: 'pending', text: `Withdrawing from tranche #${trancheIndex}...` });
    try {
      const tx = await totoW.withdrawLp(trancheIndex, burnAmt);
      setMsg({ type: 'pending', text: `Waiting for confirmation for tranche #${trancheIndex}...` });
      await tx.wait();
      setMsg({ type: 'success', text: `Successful withdrawal from tranche #${trancheIndex}` });
      setWithdrawUsdc({ ...withdrawUsdc, [trancheIndex]: '' });
      fetchData();
    } catch (e: any) {
      setMsg({ type: 'error', text: formatError(e) });
    } finally {
      setBusy(false);
    }
  };

  // Withdrawal allowed only when current round is Open AND no unfinalized prior rounds.
  const canWithdraw = currentRoundState === 0 && unfinalizedRounds === 0;
  const blockedReason = currentRoundState !== 0
    ? `The current round is "${STATE_LABELS[currentRoundState]}" - withdrawals are allowed only when Open`
    : unfinalizedRounds > 0
      ? `${unfinalizedRounds} previous round(s) have not been fully tallied yet - wait for them to finish`
      : '';

  // Live deposit rate as a percentage of LP pool the user would own after deposit.
  const ownershipPctAfterDeposit = (() => {
    if (previewShares === 0n) return 0;
    const totalAfter = totalLpShares + previewShares;
    if (totalAfter === 0n) return 0;
    return Number((previewShares * 1_000_000n) / totalAfter) / 10_000; // 4 decimal precision
  })();

  return (
    <>
      <h2 className="mb-2">Liquidity Provider Vault</h2>

      <div className="card mb-2">
        <p style={{ fontSize: '0.95rem', lineHeight: 1.5 }}>
          Deposit USDC to backstop the prize pool. Your shares grow when
          tickets are bought (and on donations), and shrink when winners claim their prizes.
          Funds are locked for <strong>2 rounds</strong> after the deposit, after which
          they can be withdrawn at the rate snapshotted at the start of the current round.
        </p>
      </div>

      <div className="game-cards mb-2">
        <div className="card text-center">
          <div className="muted">Total LP assets</div>
          <div className="pool-display" style={{ fontSize: '1.6rem' }}>
            {fmtUsdc(totalLpAssets)} USDC
          </div>
        </div>
        <div className="card text-center">
          <div className="muted">Withdrawal snapshot (Round #{currentRoundId})</div>
          <div className="pool-display" style={{ fontSize: '1.6rem' }}>
            {snapShares > 0n
              ? `${fmtUsdc(snapAssets)} USDC`
              : '- (snapshot pending)'}
          </div>
          <div className="muted" style={{ fontSize: '0.8rem' }}>
            {snapShares > 0n
              ? 'Total assets backing existing LP shares'
              : 'Set when a round opens, from the state of previous LPs'}
          </div>
        </div>
      </div>

      {msg && <div className={`alert alert-${msg.type}`}>{msg.text}</div>}

      <div className="card mb-2">
        <h3 className="mb-1">Deposit</h3>
        <p className="muted mb-2" style={{ fontSize: '0.85rem' }}>
          Shares are created at the current asset/share rate. The lock ends in round #{currentRoundId + 2}.
        </p>
        {lpMinPool > 0n && availablePool < lpMinPool && (
          <div className="alert alert-error" style={{ marginBottom: 12 }}>
            LP deposits open once the prize pool reaches{' '}
            <strong>{fmtUsdc(formatUnits(lpMinPool, 6))} USDC</strong>.
            {' '}Currently <strong>{fmtUsdc(formatUnits(availablePool, 6))} USDC</strong>
            {' '}({(Number(availablePool * 10000n / lpMinPool) / 100).toFixed(2)}%).
            Buy tickets or donate to kick-start the pool.
          </div>
        )}
        <div className="donate-row">
          <input
            type="number"
            placeholder="Amount (USDC)"
            value={depositAmt}
            onChange={(e) => setDepositAmt(e.target.value)}
            min="0"
            step="1"
            disabled={lpMinPool > 0n && availablePool < lpMinPool}
          />
          <button
            className="btn btn-primary"
            disabled={busy || !address || !depositAmt || (lpMinPool > 0n && availablePool < lpMinPool)}
            onClick={handleDeposit}
          >
            {busy ? 'Processing...' : 'Deposit'}
          </button>
        </div>
        {previewShares > 0n && (
          <p className="muted mt-1" style={{ fontSize: '0.85rem' }}>
            Your share of the LP pool after deposit: <strong>{ownershipPctAfterDeposit.toFixed(4)}%</strong>
          </p>
        )}
      </div>

      <div className="card">
        <h3 className="mb-1">Your tranches</h3>
        {!address && <p className="muted">Connect a wallet to see your tranches.</p>}
        {address && loading && <p className="muted">Loading...</p>}
        {address && !loading && tranches.length === 0 && (
          <p className="muted">No active deposits.</p>
        )}

        {!canWithdraw && tranches.length > 0 && (
          <div className="alert alert-error" style={{ marginTop: 8 }}>
            Withdrawals are blocked: {blockedReason}
          </div>
        )}

        {tranches.map((t) => {
          const unlocked = currentRoundId >= t.unlockRoundId;
          return (
            <div key={t.index} className="ticket-card" style={{ flexWrap: 'wrap' }}>
              <div className="ticket-info">
                <h4>
                  Tranche #{t.index}
                  <span className="muted" style={{ fontWeight: 400, fontSize: '0.85rem', marginLeft: 8 }}>
                    {unlocked ? 'Unlocked' : `Unlocks in round #${t.unlockRoundId}`}
                  </span>
                </h4>
                <div style={{ fontSize: '0.9rem', marginTop: 4 }}>
                  <span className="muted">Current value: </span>
                  <strong>{fmtUsdcSmart(t.liveValue)} USDC</strong>
                  <span className="muted"> &middot; available to withdraw now: <strong>{fmtUsdcSmart(t.snapshotValue)} USDC</strong></span>
                </div>
              </div>

              <div className="ticket-actions" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                <input
                  type="number"
                  placeholder={`USDC amount (max. ${fmtUsdcSmart(t.snapshotValue)})`}
                  value={withdrawUsdc[t.index] || ''}
                  onChange={(e) => setWithdrawUsdc({ ...withdrawUsdc, [t.index]: e.target.value })}
                  disabled={!unlocked || !canWithdraw}
                  min="0"
                  step="0.01"
                  style={{ width: 220 }}
                />
                <button
                  className="btn btn-success btn-sm"
                  disabled={busy || !unlocked || !canWithdraw}
                  onClick={() => handleWithdraw(t.index, t.shares)}
                >
                  {busy ? '...' : 'Withdraw all'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
