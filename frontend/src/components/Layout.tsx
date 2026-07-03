import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import { useTotoRead } from '../hooks/useToto';

export default function Layout() {
  const { address } = useAccount();
  const toto = useTotoRead();
  const [isOwner, setIsOwner] = useState(false);

  useEffect(() => {
    if (!address) { setIsOwner(false); return; }
    toto.owner().then((o: string) => {
      setIsOwner(o.toLowerCase() === address.toLowerCase());
    }).catch(() => setIsOwner(false));
  }, [address, toto]);

  return (
    <>
      <nav className="navbar">
        <NavLink to="/" className="navbar-brand">
          <img src="/logo.png" alt="TOTO" className="navbar-logo" />
          TOTO
        </NavLink>

        <ul className="navbar-links">
          <li><NavLink to="/" className={({ isActive }) => isActive ? 'active' : ''}>Home</NavLink></li>
          <li><NavLink to="/buy" className={({ isActive }) => isActive ? 'active' : ''}>Buy Ticket</NavLink></li>
          <li><NavLink to="/my-tickets" className={({ isActive }) => isActive ? 'active' : ''}>My Tickets</NavLink></li>
          <li><NavLink to="/history" className={({ isActive }) => isActive ? 'active' : ''}>History</NavLink></li>
          {isOwner && (
            <li><NavLink to="/admin" className={({ isActive }) => isActive ? 'active' : ''}>Admin</NavLink></li>
          )}
        </ul>

        <ConnectButton showBalance={false} />
      </nav>

      <main className="page">
        <Outlet />
      </main>
    </>
  );
}
