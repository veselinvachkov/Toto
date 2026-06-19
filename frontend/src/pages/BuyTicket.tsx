import { useEffect, useState, useCallback } from 'react';
import { formatUnits, parseUnits } from 'ethers';
import { fmtUsdc } from '../utils/format';
import { useSearchParams } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { useTotoRead, useTotoWrite, useUsdcWrite, useUsdcRead } from '../hooks/useToto';
import { CONTRACT_ADDRESS } from '../config/contract';
import { formatError } from '../utils/errors';
import LotteryBall from '../components/LotteryBall';

const GAMES = [
  { id: 0, label: '5 / 35', max: 35, minK: 5, maxK: 7 },
  { id: 1, label: '6 / 49', max: 49, minK: 6, maxK: 8 },
];

export default function BuyTicket() {
  const [searchParams] = useSearchParams();
  const initGame = searchParams.get('game') === '1' ? 1 : 0;

  const { address } = useAccount();
  const toto = useTotoRead();
  const totoW = useTotoWrite();
  const usdcR = useUsdcRead();
  const usdcW = useUsdcWrite();

  const [game, setGame] = useState(initGame);
  const [picks, setPicks] = useState<number[]>([]);
  const [price, setPrice] = useState('0');
  const [allowance, setAllowance] = useState(0n);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: string; text: string } | null>(null);

  const g = GAMES[game];

  // Fetch price whenever picks change
  useEffect(() => {
    if (picks.length < g.minK) { setPrice('0'); return; }
    toto.ticketPrice(game, picks.length)
      .then((p: bigint) => setPrice(formatUnits(p, 6)))
      .catch((e: any) => {
        setPrice('');
        setMsg({ type: 'error', text: `Ticket price could not be loaded: ${formatError(e)}` });
      });
  }, [picks.length, game, toto, g.minK]);

  // Fetch allowance
  const fetchAllowance = useCallback(async () => {
    if (!address || !usdcR) return;
    try {
      const a = await usdcR.allowance(address, CONTRACT_ADDRESS);
      setAllowance(a);
    } catch { /* ignore */ }
  }, [address, usdcR]);

  useEffect(() => { fetchAllowance(); }, [fetchAllowance]);

  const toggleNumber = (n: number) => {
    setPicks((prev) => {
      if (prev.includes(n)) return prev.filter((x) => x !== n);
      if (prev.length >= g.maxK) return prev;
      return [...prev, n].sort((a, b) => a - b);
    });
  };

  const switchGame = (id: number) => {
    setGame(id);
    setPicks([]);
    setMsg(null);
  };

  const priceWei = price ? parseUnits(price, 6) : 0n;
  const needsApproval = picks.length >= g.minK && priceWei > 0n && allowance < priceWei;
  const canBuy = picks.length >= g.minK && picks.length <= g.maxK && priceWei > 0n && !needsApproval;

  const handleApprove = async () => {
    if (!usdcW) return;
    setBusy(true);
    setMsg({ type: 'pending', text: 'Approving USDC...' });
    try {
      const amt = parseUnits(price, 6);
      const tx = await usdcW.approve(CONTRACT_ADDRESS, amt);
      setMsg({ type: 'pending', text: 'Waiting for confirmation...' });
      await tx.wait();
      setMsg({ type: 'success', text: 'USDC approved. You can buy the ticket.' });
      await fetchAllowance();
    } catch (e: any) {
      setMsg({ type: 'error', text: formatError(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleBuy = async () => {
    if (!totoW) return;
    setBusy(true);
    setMsg({ type: 'pending', text: 'Buying ticket...' });
    try {
      const tx = await totoW.buyTicket(game, picks);
      setMsg({ type: 'pending', text: 'Waiting for confirmation...' });
      const receipt = await tx.wait();
      const log = receipt.logs.find((l: any) => l.fragment?.name === 'TicketBought');
      const ticketId = log ? log.args[0].toString() : '?';
      setMsg({ type: 'success', text: `Ticket #${ticketId} purchased!` });
      setPicks([]);
      fetchAllowance();
    } catch (e: any) {
      setMsg({ type: 'error', text: formatError(e) });
    } finally {
      setBusy(false);
    }
  };

  const picksLabel = () => {
    if (picks.length < g.minK) return `Pick ${g.minK - picks.length} more`;
    if (picks.length === g.minK) return 'Basic ticket';
    return `System +${picks.length - g.minK}`;
  };

  return (
    <>
      <h2 className="mb-2">Buy Ticket</h2>

      <div className="game-tabs">
        {GAMES.map((gm) => (
          <button
            key={gm.id}
            className={`game-tab ${game === gm.id ? 'active' : ''}`}
            onClick={() => switchGame(gm.id)}
          >
            {gm.label}
          </button>
        ))}
      </div>

      {msg && <div className={`alert alert-${msg.type}`}>{msg.text}</div>}

      <div className="card">
        <div className={`selected-picks ${picks.length === 0 ? 'empty' : ''}`}>
          {picks.map((n) => (
            <LotteryBall key={n} number={n} size="lg" />
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span className="muted">{picksLabel()} ({picks.length}/{g.maxK})</span>
          {picks.length > 0 && (
            <button className="btn btn-outline btn-sm" onClick={() => setPicks([])}>Clear</button>
          )}
        </div>

        <div className="number-grid">
          {Array.from({ length: g.max }, (_, i) => i + 1).map((n) => {
            const isSelected = picks.includes(n);
            const isFull = picks.length >= g.maxK;
            return (
              <LotteryBall
                key={n}
                number={n}
                size="md"
                pickMode
                selected={isSelected ? true : (isFull && !isSelected ? false : undefined)}
                onClick={() => toggleNumber(n)}
              />
            );
          })}
        </div>

        <div className="buy-footer">
          <div>
            <span className="muted">Price: </span>
            <span className="price">{fmtUsdc(price)} USDC</span>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {needsApproval ? (
              <button className="btn btn-primary" disabled={busy || !address} onClick={handleApprove}>
                {busy ? 'Approving...' : 'Approve USDC'}
              </button>
            ) : (
              <button className="btn btn-success" disabled={busy || !canBuy || !address} onClick={handleBuy}>
                {busy ? 'Buying...' : 'Buy ticket'}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
