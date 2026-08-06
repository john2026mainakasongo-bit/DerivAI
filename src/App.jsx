import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
} from "react-router-dom";

import Dashboard from "./pages/Dashboard";
import Analysis from "./pages/Analysis";
import RiseFallAnalysis from "./pages/RiseFallAnalysis";
import OverUnderAnalysis from "./pages/OverUnderAnalysis";
import OverUnderLearningBot from "./pages/OverUnderLearningBot";
import TargetTenBot from "./pages/TargetTenBot";
import Bot from "./pages/Bot";
import DiffersOneShotBot from "./pages/DiffersOneShotBot";
import Settings from "./pages/Settings";
import Login from "./pages/Login";
import FreshEdgeBot from "./pages/FreshEdgeBot";
import RapidEdgeAI from "./pages/RapidEdgeAI";
import GeminiXEngine from "./pages/GeminiXEngine";
import FinalAnalysisBot from "./pages/FinalAnalysisBot";

import "./index.css";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={<Navigate to="/dashboard" replace />}
        />

        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/analysis" element={<Analysis />} />

        <Route
          path="/rise-fall-analysis"
          element={<RiseFallAnalysis />}
        />

        <Route
          path="/over-under-analysis"
          element={<OverUnderAnalysis />}
        />

        <Route
          path="/over-under-learning-bot"
          element={<OverUnderLearningBot />}
        />

        <Route
          path="/target-10-bot"
          element={<TargetTenBot />}
        />

        <Route path="/bot" element={<Bot />} />

        <Route
          path="/differs-one-shot"
          element={<DiffersOneShotBot />}
        />

        <Route path="/settings" element={<Settings />} />

        <Route
          path="/fresh-edge-ai"
          element={<FreshEdgeBot />}
        />

        <Route
          path="/rapid-edge-ai"
          element={<RapidEdgeAI />}
        />

        <Route
          path="/gemini-x-engine"
          element={<GeminiXEngine />}
        />

        <Route
          path="/final-analysis-bot"
          element={<FinalAnalysisBot />}
        />

        <Route
          path="*"
          element={<Navigate to="/dashboard" replace />}
        />
      </Routes>
    </BrowserRouter>
  );
}
