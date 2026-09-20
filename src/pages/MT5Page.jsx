import BotLayout from "../components/BotLayout";
import MT5AnalysisDesk from "../components/MT5AnalysisDesk";
import "../styles/MT5AnalysisDesk.css";

export default function MT5Page() {
  return (
    <BotLayout eyebrow="MT5 MANUAL ANALYSIS DESK">
      <section className="mt5Intro">
        <div>
          <span>DERIV VOLATILITY · LIVE PRICE ACTION</span>
          <h1>MT5 Analysis Desk</h1>
          <p>
            Live technical analysis for Volatility markets. The desk detects
            structure, liquidity, breakout/retest, rejection, pullback,
            continuation and failed-break setups before producing a BUY,
            SELL or WAIT plan for manual MT5 execution.
          </p>
        </div>
        <div className="mt5IntroBadge"><i /> ANALYSIS ONLY<small>Manual MT5 entry</small></div>
      </section>
      <MT5AnalysisDesk />
    </BotLayout>
  );
}
