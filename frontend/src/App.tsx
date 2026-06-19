import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Home from './pages/Home';
import BuyTicket from './pages/BuyTicket';
import MyTickets from './pages/MyTickets';
import RoundHistory from './pages/RoundHistory';
import LP from './pages/LP';
import Admin from './pages/Admin';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/buy" element={<BuyTicket />} />
        <Route path="/my-tickets" element={<MyTickets />} />
        <Route path="/history" element={<RoundHistory />} />
        <Route path="/lp" element={<LP />} />
        <Route path="/admin" element={<Admin />} />
      </Route>
    </Routes>
  );
}
