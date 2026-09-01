import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
} from "react-router-dom";

import Dashboard from "./pages/Dashboard";
import TradingCommandCenter from "./pages/TradingCommandCenter";
import Login from "./pages/Login";
import RiseFallTouchAnalysis from "./pages/RiseFallTouchAnalysis";
import "./index.css";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route
          path="/command-center"
          element={<TradingCommandCenter />}
        />
        <Route
          path="/rise-fall-touch"
          element={<RiseFallTouchAnalysis />}
        />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
