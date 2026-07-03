import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { formatUnits, parseUnits } from 'ethers';
import { useTotoRead, useTotoWrite } from '../hooks/useToto';
import { formatError } from '../utils/errors';

export default function Admin() {
  const { address } = useAccount();
  const navigate = useNavigate();
  const toto = useTotoRead();
  const totoW = useTotoWrite();

  const [owner, setOwner] = useState('');
  const [ownerLoaded, setOwnerLoaded] = useState(false);
  const [paused, setPaused] = useState(false);
  const [treasury, setTreasury] = useState('');
  const [newTreasury, setNewTreasury] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  // VRF fields
  const [vrfKeyHash, setVrfKeyHash] = useState('');
  const [vrfSubId, setVrfSubId] = useState('');
  const [vrfConfs, setVrfConfs] = useState('3');
  const [vrfGas, setVrfGas] = useState('500000');

  // Draw-interval fields (displayed/entered in days; stored on-chain in seconds)
  const [drawIntervalSec, setDrawIntervalSec] = useState<bigint>(0n);
  const [pendingIntervalSec, setPendingIntervalSec] = useState<bigint>(0n);
  const [pendingActiveRound, setPendingActiveRound] = useState<bigint>(0n);
  const [newIntervalDays, setNewIntervalDays] = useState('');

  // Owner-donation reclaim fields (USDC has 6 decimals)
  const [ownerDonationsBase, setOwnerDonationsBase] = useState<bigint>(0n);
  const [poolBase, setPoolBase] = useState<bigint>(0n);
  const [reclaimAmt, setReclaimAmt] = useState('');

  const fetchData = useCallback(async () => {
    try {
      const [o, p, t, di, pdi, par, od, pool] = await Promise.all([
        toto.owner(),
        toto.paused(),
        toto.treasury(),
        toto.drawInterval(),
        toto.pendingDrawInterval(),
        toto.pendingIntervalActiveRound(),
        toto.ownerDonations(),
        toto.cumulativePool(),
      ]);
      setOwner(o);
      setPaused(p);
      setTreasury(t);
      setDrawIntervalSec(BigInt(di));
      setPendingIntervalSec(BigInt(pdi));
      setPendingActiveRound(BigInt(par));
      setOwnerDonationsBase(BigInt(od));
      setPoolBase(BigInt(pool));
    } catch { /* not deployed */ }
    finally { setOwnerLoaded(true); }
  }, [toto]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const isOwner = !!address && !!owner && address.toLowerCase() === owner.toLowerCase();

  // Hard guard: the admin panel is invisible to everyone but the contract owner.
  // Anyone else who reaches /admin (e.g. by typing the URL) is silently sent home,
  // so the page leaves no trace that it exists. We wait for the on-chain owner to
  // load before deciding, to avoid bouncing the real admin during the initial fetch.
  useEffect(() => {
    if (ownerLoaded && !isOwner) {
      navigate('/', { replace: true });
    }
  }, [ownerLoaded, isOwner, navigate]);

  // Render nothing until ownership is resolved, and nothing for non-owners
  // (they are being redirected). This prevents any admin UI flash.
  if (!ownerLoaded || !isOwner) {
    return null;
  }

  // Reclaimable = the owner's own tracked donations, but never more than the
  // unencumbered pool currently holds (earmarked prizes / stakes are off-limits).
  // This mirrors the contract's double cap so the UI never offers an amount that
  // would revert.
  const reclaimable = ownerDonationsBase < poolBase ? ownerDonationsBase : poolBase;
  const poolLimited = poolBase < ownerDonationsBase;

  const exec = async (label: string, fn: () => Promise<any>) => {
    setBusy(label);
    setMsg('');
    try {
      const tx = await fn();
      await tx.wait();
      setMsg(`${label}: success`);
      fetchData();
    } catch (e: any) {
      setMsg(`${label}: ${formatError(e)}`);
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <h2 className="mb-2">Admin panel</h2>

      {msg && <div className={`alert ${msg.includes('success') ? 'alert-success' : 'alert-error'}`}>{msg}</div>}

      <div className="admin-grid">
        {/* Pause / Unpause */}
        <div className="card">
          <h3>Contract status</h3>
          <p>
            <span className={`status-dot ${paused ? 'paused' : 'active'}`} />
            {paused ? 'Paused' : 'Active'}
          </p>
          <div className="mt-2">
            {paused ? (
              <button className="btn btn-success" disabled={!!busy} onClick={() => exec('Unpause', () => totoW!.unpause())}>
                {busy === 'Unpause' ? '...' : 'Unpause'}
              </button>
            ) : (
              <button className="btn btn-danger" disabled={!!busy} onClick={() => exec('Pause', () => totoW!.pause())}>
                {busy === 'Pause' ? '...' : 'Pause'}
              </button>
            )}
          </div>
        </div>

        {/* Treasury */}
        <div className="card">
          <h3>Treasury</h3>
          <p className="muted" style={{ fontSize: '0.8rem', wordBreak: 'break-all' }}>{treasury}</p>
          <div className="admin-field mt-2">
            <label>New treasury address</label>
            <input type="text" placeholder="0x..." value={newTreasury} onChange={(e) => setNewTreasury(e.target.value)} />
          </div>
          <button className="btn btn-primary btn-sm" disabled={!!busy || !newTreasury} onClick={() => exec('Set treasury', () => totoW!.setTreasury(newTreasury))}>
            {busy === 'Set treasury' ? '...' : 'Update'}
          </button>
        </div>

        {/* Draw interval */}
        <div className="card">
          <h3>Draw interval</h3>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            Draws run every <strong>{(Number(drawIntervalSec) / 86400).toFixed(2)} days</strong>.
          </p>
          {pendingIntervalSec > 0n && (
            <p className="muted" style={{ fontSize: '0.8rem' }}>
              Queued: {(Number(pendingIntervalSec) / 86400).toFixed(2)} days, active from round{' '}
              {pendingActiveRound.toString()}.
            </p>
          )}
          <div className="admin-field mt-2">
            <label>New interval (days)</label>
            <input
              type="number"
              min="0.25"
              step="0.25"
              placeholder="3"
              value={newIntervalDays}
              onChange={(e) => setNewIntervalDays(e.target.value)}
            />
          </div>
          <p className="muted" style={{ fontSize: '0.75rem' }}>
            Takes effect after 2 draws to protect players from a sudden schedule change.
          </p>
          <button
            className="btn btn-primary btn-sm"
            disabled={!!busy || !newIntervalDays || Number(newIntervalDays) <= 0}
            onClick={() =>
              exec('Set draw interval', () =>
                totoW!.setDrawInterval(BigInt(Math.round(Number(newIntervalDays) * 86400))),
              )
            }
          >
            {busy === 'Set draw interval' ? '...' : 'Queue change'}
          </button>
        </div>

        {/* Reclaim own donations to treasury */}
        <div className="card">
          <h3>Your donations</h3>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            You have donated <strong>{formatUnits(ownerDonationsBase, 6)} USDC</strong> in total.
          </p>
          <p className="muted" style={{ fontSize: '0.8rem' }}>
            Reclaimable now: <strong>{formatUnits(reclaimable, 6)} USDC</strong>
            {poolLimited && ' (capped by the free pool)'}
          </p>
          <div className="admin-field mt-2">
            <label>Amount to send to treasury (USDC)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={reclaimAmt}
              onChange={(e) => setReclaimAmt(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={reclaimable === 0n}
            onClick={() => setReclaimAmt(formatUnits(reclaimable, 6))}
          >
            Max
          </button>
          <p className="muted" style={{ fontSize: '0.75rem' }}>
            Only your own donations can be reclaimed — other players' donations, stakes and
            prize money are never touched. The amount is sent to the treasury, not your wallet.
          </p>
          <button
            className="btn btn-primary btn-sm"
            disabled={!!busy || !reclaimAmt || Number(reclaimAmt) <= 0}
            onClick={() =>
              exec('Reclaim donation', () =>
                totoW!.reclaimOwnerDonation(parseUnits(reclaimAmt || '0', 6)),
              )
            }
          >
            {busy === 'Reclaim donation' ? '...' : 'Send to treasury'}
          </button>
        </div>

        {/* VRF Config */}
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <h3>VRF configuration</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="admin-field">
              <label>Key Hash</label>
              <input type="text" placeholder="0x..." value={vrfKeyHash} onChange={(e) => setVrfKeyHash(e.target.value)} />
            </div>
            <div className="admin-field">
              <label>Subscription ID</label>
              <input type="number" value={vrfSubId} onChange={(e) => setVrfSubId(e.target.value)} />
            </div>
            <div className="admin-field">
              <label>Confirmations</label>
              <input type="number" value={vrfConfs} onChange={(e) => setVrfConfs(e.target.value)} />
            </div>
            <div className="admin-field">
              <label>Callback gas limit</label>
              <input type="number" value={vrfGas} onChange={(e) => setVrfGas(e.target.value)} />
            </div>
          </div>
          <button
            className="btn btn-primary btn-sm mt-1"
            disabled={!!busy || !vrfKeyHash || !vrfSubId}
            onClick={() => exec('Set VRF', () => totoW!.setVrfConfig(vrfKeyHash, vrfSubId, Number(vrfConfs), Number(vrfGas)))}
          >
            {busy === 'Set VRF' ? '...' : 'Update VRF configuration'}
          </button>
        </div>
      </div>
    </>
  );
}
