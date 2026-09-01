import "../styles/StrategyEngineV36.css";
import StrategyEngineV36 from "../components/StrategyEngineV36";
import RiseFallTouchAnalysis from "./RiseFallTouchAnalysis";

export default function Dashboard() {
  return (
    <>
      <StrategyEngineV36 />
      <RiseFallTouchAnalysis />
    </>
  );
}
