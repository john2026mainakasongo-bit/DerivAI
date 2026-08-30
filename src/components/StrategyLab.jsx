import { useMemo } from "react";
import { analyzeUnifiedSignals } from "../analysis/v71UnifiedSignalEngine";
import "./StrategyLab.css";

function evaluate(candidate, digit) {
  if (!candidate) return false;
  if (candidate.mode === "OVER") return digit > Number(candidate.prediction);
  if (candidate.mode === "UNDER") return digit < Number(candidate.prediction);
  if (candidate.mode === "EVEN") return digit % 2 === 0;
  if (candidate.mode === "ODD") return digit % 2 === 1;
  if (candidate.mode === "DIFFERS") return digit !== Number(candidate.prediction);
  return false;
}

function backtest(digits, minimumConfidence = 88) {
  const sample = Array.isArray(digits) ? digits.slice(-1200) : [];
  if (sample.length < 180) return { trades: 0, wins: 0, losses: 0, hitRate: 0, netR: 0, maxDD: 0, curve: [0] };

  let wins = 0;
  let losses = 0;
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  let lossStreak = 0;
  let maxLossStreak = 0;
  const curve = [0];

  // Walk forward: every decision sees only digits before the outcome digit.
  for (let i = 160; i < sample.length; i += 1) {
    const history = sample.slice(0, i);
    const result = analyzeUnifiedSignals({
      digitHistory: history,
      minimumConfidence,
    });
    const candidate = result.digit.best;
    if (!candidate) continue;

    const won = evaluate(candidate, sample[i]);
    const r = won ? 1 : -1; // normalized research R; not Deriv payout
    equity += r;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
    curve.push(equity);

    if (won) {
      wins += 1;
      lossStreak = 0;
    } else {
      losses += 1;
      lossStreak += 1;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    }
  }

  const trades = wins + losses;
  return {
    trades,
    wins,
    losses,
    hitRate: trades ? (wins / trades) * 100 : 0,
    netR: equity,
    maxDD,
    maxLossStreak,
    curve,
  };
}

function Sparkline({ values }) {
  const width = 900;
  const height = 180;
  if (!values?.length) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const path = values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * width;
    const y = height - ((value - min) / range) * (height - 20) - 10;
    return `${index ? "L" : "M"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
  return (
    <svg className="strategyChart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="3" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Metric({ label, value }) {
  return <div className="strategyMetric"><span>{label}</span><strong>{value}</strong></div>;
}

export default function StrategyLab({ data }) {
  const digits = data?.digitHistory || [];
  const result = useMemo(
    () => analyzeUnifiedSignals({ digitHistory: digits, minimumConfidence: 88 }),
    [digits]
  );
  const test = useMemo(() => backtest(digits, 88), [digits]);
  const best = result.digit.best;
  const signal = best?.setup || "WAIT";
  const confidence = best?.confidence ?? 0;

  return (
    <section className="strategyLab panel">
      <div className="strategyHeader">
        <div>
          <small>CALIBRATED STRATEGY LAB V1</small>
          <h2>Deriv Strategy Engine</h2>
          <p>Uses the existing live Deriv tick buffer and the V71 calibrated digit engine.</p>
        </div>
        <div className={`strategyBadge ${best ? "ready" : "wait"}`}>
          <i /> {best ? "SETUP READY" : "WAIT"}
        </div>
      </div>

      <div className="strategyTopGrid">
        <div className={`strategySignal ${best ? "ready" : ""}`}>
          <span>BEST SETUP</span>
          <strong>{signal}</strong>
          <p>{best?.reason || result.digit.reason}</p>
          <div className="confidenceBar"><div style={{ width: `${Math.min(100, confidence)}%` }} /></div>
          <div className="confidenceRow">
            <span>Confidence</span><b>{confidence.toFixed(1)}%</b>
          </div>
        </div>

        <div className="strategyMetrics">
          <Metric label="Current digit" value={result.digit.currentDigit ?? "—"} />
          <Metric label="History" value={result.digit.sampleSize} />
          <Metric label="Model" value={best?.source?.replaceAll("_", " ") || "SCANNING"} />
          <Metric label="Risk mode" value="FIXED / NO MARTINGALE" />
        </div>
      </div>

      <div className="strategySectionTitle">WALK-FORWARD BACKTEST</div>
      <div className="strategyMetrics backtestMetrics">
        <Metric label="Signals" value={test.trades} />
        <Metric label="Hit rate" value={`${test.hitRate.toFixed(1)}%`} />
        <Metric label="Wins" value={test.wins} />
        <Metric label="Losses" value={test.losses} />
        <Metric label="Normalized R" value={`${test.netR >= 0 ? "+" : ""}${test.netR.toFixed(1)}R`} />
        <Metric label="Max drawdown" value={`${test.maxDD.toFixed(1)}R`} />
        <Metric label="Max loss streak" value={test.maxLossStreak || 0} />
      </div>

      <div className="strategyChartWrap">
        {test.trades ? <Sparkline values={test.curve} /> : <div className="strategyEmpty">Collect at least 180 digits for the walk-forward test.</div>}
      </div>

      <div className="strategyNotice">
        <b>Research mode:</b> normalized R treats a winning signal as +1R and a losing signal as -1R.
        It does <b>not</b> represent actual Deriv contract payout, fees, or stake sizing. No automatic real-money trade is placed by this panel.
      </div>
    </section>
  );
}
