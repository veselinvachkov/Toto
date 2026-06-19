import { useEffect, useState, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { useTotoRead, useTotoWrite } from '../hooks/useToto';
import { formatError } from '../utils/errors';

export default function Admin() {
  const { address } = useAccount();
  const toto = useTotoRead();
  const totoW = useTotoWrite();

  const [owner, setOwner] = useState('');
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

  const fetchData = useCallback(async () => {
    try {
      const [o, p, t] = await Promise.all([
        toto.owner(),
        toto.paused(),
        toto.treasury(),
      ]);
      setOwner(o);
      setPaused(p);
      setTreasury(t);
    } catch { /* not deployed */ }
  }, [toto]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const isOwner = address && owner && address.toLowerCase() === owner.toLowerCase();

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

  if (!address) {
    return <div className="card text-center mt-3"><p className="muted">Connect a wallet to access the admin panel</p></div>;
  }

  if (!isOwner) {
    return <div className="card text-center mt-3"><p className="muted">Admins only</p></div>;
  }

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
