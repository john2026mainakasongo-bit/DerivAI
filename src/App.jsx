import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import RiseFallPage from "./pages/RiseFallPage";
import TouchNoTouchPage from "./pages/TouchNoTouchPage";
import AdaptiveTrendPage from "./pages/AdaptiveTrendPage";

export default function App() {
  return <BrowserRouter><Routes>
    <Route path="/" element={<Navigate to="/dashboard" replace />} />
    <Route path="/dashboard" element={<Dashboard />} />
    <Route path="/rise-fall" element={<RiseFallPage />} />
    <Route path="/touch-no-touch" element={<TouchNoTouchPage />} />
    <Route path="/adaptive-trend" element={<AdaptiveTrendPage />} />
    <Route path="/login" element={<Login />} />
    <Route path="*" element={<Navigate to="/dashboard" replace />} />
  </Routes></BrowserRouter>;
}
