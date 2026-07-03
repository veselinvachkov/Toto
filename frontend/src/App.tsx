import { lazy, Suspense } from 'react';
import { Routes, Route, Outlet } from 'react-router-dom';
import Layout from './components/Layout';

// Route-level code splitting: each page ships as its own chunk and only loads
// when first visited, so the initial bundle (and time-to-interactive) stays
// small even as pages grow.
const Home = lazy(() => import('./pages/Home'));
const BuyTicket = lazy(() => import('./pages/BuyTicket'));
const MyTickets = lazy(() => import('./pages/MyTickets'));
const RoundHistory = lazy(() => import('./pages/RoundHistory'));
const Admin = lazy(() => import('./pages/Admin'));

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route
          element={
            <Suspense fallback={<p className="muted" style={{ padding: '2rem' }}>Loading...</p>}>
              <Outlet />
            </Suspense>
          }
        >
          <Route path="/" element={<Home />} />
          <Route path="/buy" element={<BuyTicket />} />
          <Route path="/my-tickets" element={<MyTickets />} />
          <Route path="/history" element={<RoundHistory />} />
          <Route path="/admin" element={<Admin />} />
        </Route>
      </Route>
    </Routes>
  );
}
