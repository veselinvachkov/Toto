import { useEffect, useRef, useState, useCallback } from 'react';
import { formatUnits, parseUnits } from 'ethers';
import { useNavigate } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { useTotoRead, useTotoWrite, useUsdcRead, useUsdcWrite } from '../hooks/useToto';
import { readProvider } from '../hooks/useEthers';
import { usePolling } from '../hooks/usePolling';
import { multicall } from '../hooks/multicall';
import { formatError } from '../utils/errors';
import { fmtUsdc } from '../utils/format';
import LotteryBall from '../components/LotteryBall';
import Leaderboard from '../components/Leaderboard';

const STATE_LABELS = ['Open', 'Drawing', 'Tallying', 'Claimable', 'Expired'];
const STATE_BADGE  = ['badge-open', 'badge-awaiting', 'badge-tallying', 'badge-claimable', 'badge-expired'];

export default function Home() {
  const navigate = useNavigate();
  const { address } = useAccount();
  const toto = useTotoRead();
  const totoW = useTotoWrite();
  const usdcR = useUsdcRead();
  const usdcW = useUsdcWrite();

  const [roundId, setRoundId] = useState(0);
  const [pool, setPool] = useState('0');
  const [drawTime, setDrawTime] = useState(0);
  const [state, setState] = useState(0);
  const [countdown, setCountdown] = useState('');
  const [donateAmt, setDonateAmt] = useState('');
  const [tallyRound, setTallyRound] = useState('');
  const [sweepRound, setSweepRound] = useState('');
  const [busy, setBusy] = useState(false);
  type Msg = { type: 'pending' | 'success' | 'error'; text: string } | null;
  const [donateMsg, setDonateMsg] = useState<Msg>(null);
  const [adminMsg, setAdminMsg] = useState<Msg>(null);
  const [pendingDraws, setPendingDraws] = useState(0);

  // Seconds to add to the device clock to get chain time. The countdown is gated
  // on-chain by `block.timestamp`, so we anchor it to chain time rather than the
  // user's machine clock — a wrong/ skewed device clock must not make the timer lie.
  const chainOffsetRef = useRef(0);

  const fetchData = useCallback(async () => {
    try {
      const [rid, ap] = await multicall(toto, [
        { fn: 'currentRoundId' },
        { fn: 'cumulativePool' },
      ]);
      const ridN = Number(rid);
      setRoundId(ridN);
      setPool(formatUnits(ap ?? 0n, 6));

      // Re-sync the device→chain clock offset each poll. One extra lightweight call;
      // keeps the countdown honest even if the user's clock drifts.
      try {
        const blk = await readProvider.getBlock('latest');
        if (blk) {
          chainOffsetRef.current = Number(blk.timestamp) - Math.floor(Date.now() / 1000);
        }
      } catch { /* keep last known offset */ }

      // Count past rounds whose draw is not yet complete (state in {Open, AwaitingVRF, Tallying}
      // and drawTime has passed). Bounded to the last 50 rounds, and fetched in a
      // SINGLE batched eth_call (Multicall3) so this 30s poll can never fan out
      // into a ~50-request burst that trips public-RPC rate limits.
      const now = Math.floor(Date.now() / 1000) + chainOffsetRef.current;
      const scanFrom = Math.max(0, ridN - 50);
      const roundIds = Array.from({ length: ridN - scanFrom + 1 }, (_, i) => scanFrom + i);
      const infos = await multicall(toto, roundIds.map((r) => ({ fn: 'getRoundInfo', args: [r] })));

      const info = infos[roundIds.indexOf(ridN)];
      if (info) {
        setDrawTime(Number(info.drawTime));
        setState(Number(info.state));
      }

      const pending = infos.filter((r: any) => {
        if (!r) return false;
        const s = Number(r.state);
        const dt = Number(r.drawTime);
        // Open/AwaitingVRF/Tallying are pre-claim states; if drawTime past, the draw is overdue.
        return (s === 0 || s === 1 || s === 2) && dt <= now;
      }).length;
      setPendingDraws(pending);
    } catch { /* not deployed yet */ }
  }, [toto]);

  usePolling(fetchData, 30000);

  useEffect(() => {
    if (drawTime === 0) return;
    const tick = () => {
      const diff = drawTime - (Math.floor(Date.now() / 1000) + chainOffsetRef.current);
      if (diff <= 0) { setCountdown('Draw is available!'); return; }
      const h = Math.floor(diff / 3600);
      const m = Math.floor((diff % 3600) / 60);
      const s = diff % 60;
      setCountdown(`${h}h ${m}m ${s}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [drawTime]);

  const exec = async (label: string, fn: () => Promise<any>) => {
    setBusy(true);
    setAdminMsg({ type: 'pending', text: `${label}: sending...` });
    try {
      const tx = await fn();
      setAdminMsg({ type: 'pending', text: `${label}: waiting for confirmation...` });
      await tx.wait();
      setAdminMsg({ type: 'success', text: `${label}: success!` });
      fetchData();
    } catch (e: any) {
      setAdminMsg({ type: 'error', text: formatError(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleDonate = async () => {
    if (!totoW || !usdcW || !usdcR || !address || !donateAmt) return;
    setBusy(true);
    setDonateMsg(null);
    try {
      const amt = parseUnits(donateAmt, 6);
      const spender = await totoW.getAddress();

      const [bal, currentAllowance] = await Promise.all([
        usdcR.balanceOf(address),
        usdcR.allowance(address, spender),
      ]);
      if (bal < amt) {
        setDonateMsg({ type: 'error', text: `Insufficient USDC balance: you have ${formatUnits(bal, 6)}, need ${donateAmt}` });
        setBusy(false);
        return;
      }

      if (currentAllowance < amt) {
        setDonateMsg({ type: 'pending', text: 'Approving USDC...' });
        const approveTx = await usdcW.approve(spender, amt);
        await approveTx.wait();
      }

      setDonateMsg({ type: 'pending', text: 'Donating...' });
      const tx = await totoW.donate(amt);
      await tx.wait();
      setDonateMsg({ type: 'success', text: 'Donation successful!' });
      setDonateAmt('');
      fetchData();
    } catch (e: any) {
      setDonateMsg({ type: 'error', text: formatError(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="hero">
        <h1>TOTO Lottery</h1>
        <p>A transparent lottery with a guaranteed provably fair draw</p>
      </div>

      <div className="pool-row mb-2">
        <div className="card text-center pool-card">
          <div className="pool-display">{fmtUsdc(pool)} USDC</div>
          <div className="jackpot-label">JACKPOT</div>
          <div className="mt-2">
            <span className={`badge ${STATE_BADGE[state]}`}>{STATE_LABELS[state]}</span>
          </div>
          {state === 0 && <div className="countdown mt-2">{countdown}</div>}
        </div>
        <Leaderboard />
      </div>

      <div className="game-cards mt-3">
        <div className="card game-card">
          <h3>TOTO 5/35</h3>
          <div style={{ display: 'flex', gap: 4, justifyContent: 'center', margin: '12px 0' }}>
            {[7, 14, 21, 28, 35].map(n => <LotteryBall key={n} number={n} size="sm" />)}
          </div>
          <div className="tiers">
            <div>5 matched: 10% of the jackpot pool (Jackpot)</div>
            <div>4 matched: 19.5% of 5/35 ticket sales</div>
            <div>3 matched: 30.5% of 5/35 ticket sales</div>
          </div>
          <div className="muted mb-1" style={{ fontSize: '0.85rem' }}>From 1.5 USDC</div>
          <button className="btn btn-primary" onClick={() => navigate('/buy?game=0')}>Play 5/35</button>
        </div>

        <div className="card game-card">
          <h3>TOTO 6/49</h3>
          <div style={{ display: 'flex', gap: 4, justifyContent: 'center', margin: '12px 0' }}>
            {[8, 16, 25, 33, 41, 49].map(n => <LotteryBall key={n} number={n} size="sm" />)}
          </div>
          <div className="tiers">
            <div>6 matched: 60% of the jackpot pool (Jackpot)</div>
            <div>5 matched: 11.25% of 6/49 ticket sales</div>
            <div>4 matched: 12.5% of 6/49 ticket sales</div>
            <div>3 matched: 26.25% of 6/49 ticket sales</div>
          </div>
          <div className="muted mb-1" style={{ fontSize: '0.85rem' }}>From 2.5 USDC</div>
          <button className="btn btn-primary" onClick={() => navigate('/buy?game=1')}>Play 6/49</button>
        </div>
      </div>

      {address && adminMsg && (
        <div className={`alert mt-3 alert-${adminMsg.type}`}>{adminMsg.text}</div>
      )}

      {address && (
        <div className="game-cards mt-3">
          <div className="card">
            <h3 className="mb-1">Draw & tally</h3>
            <p className="muted">Current round: #{roundId}</p>
            <button
              className="btn btn-primary btn-sm mt-2"
              disabled={busy || !totoW}
              onClick={() => exec('Draw request', () => totoW!.requestDraw(roundId))}
            >
              {busy ? '...' : `Request draw (Round #${roundId})`}
            </button>
            <div className="admin-field mt-2">
              <label>Tally round</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="number" min="1" placeholder="Round ID" value={tallyRound} onChange={(e) => setTallyRound(e.target.value)} />
                <button className="btn btn-outline btn-sm" disabled={busy || !totoW} onClick={() => exec('Tally', () => totoW!.tallyBatch(Number(tallyRound), 500))}>
                  Tally
                </button>
              </div>
            </div>
          </div>

          <div className="card">
            <h3 className="mb-1">Sweep expired</h3>
            <p className="muted">Returns unclaimed winnings to the general pool after expiry</p>
            {/* Invisible spacer mirrors the "Request draw" button so Round ID aligns with Tally round */}
            <button className="btn btn-primary btn-sm mt-2" aria-hidden="true" tabIndex={-1} style={{ visibility: 'hidden' }}>
              Request draw
            </button>
            <div className="admin-field mt-2">
              <label>Round ID</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="number" min="1" placeholder="Round ID" value={sweepRound} onChange={(e) => setSweepRound(e.target.value)} />
                <button className="btn btn-outline btn-sm" disabled={busy || !totoW} onClick={() => exec('Sweep', () => totoW!.sweepExpired(Number(sweepRound)))}>
                  Sweep
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="card mt-3 text-center">
        <h3 className="mb-1">Donate to the prize pool</h3>
        <p className="muted mb-2" style={{ fontSize: '0.9rem' }}>Anyone can add USDC to grow the jackpot</p>
        {donateMsg && <div className={`alert alert-${donateMsg.type}`}>{donateMsg.text}</div>}
        <div className="donate-row">
          <input
            type="number"
            placeholder="Amount (USDC)"
            value={donateAmt}
            onChange={(e) => setDonateAmt(e.target.value)}
            min="0"
            step="1"
          />
          <button className="btn btn-success" disabled={busy || !address || !donateAmt} onClick={handleDonate}>
            {busy ? 'Processing...' : 'Donate'}
          </button>
        </div>
      </div>

      {address && (
        <div className="card mt-3 text-center">
          <h3 className="mb-1">Automatic catch-up</h3>
          <p className="muted mb-2" style={{ fontSize: '0.9rem' }}>
            Advances overdue rounds: starts missing draws, finishes tallying,
            and returns unclaimed winnings back to the general pool.
          </p>
          <p className="muted mb-2" style={{ fontSize: '0.85rem' }}>
            Available only when there are more than 2 past rounds that have not been drawn.
            Currently: <strong>{pendingDraws}</strong>.
          </p>
          <button
            className="btn btn-success"
            disabled={busy || !totoW || pendingDraws <= 2}
            onClick={() => exec('Catch-up', () => totoW!.catchUp(0, 100, 500))}
          >
            {busy ? 'Processing...' : 'Catch up all rounds'}
          </button>
        </div>
      )}
    </>
  );
}
