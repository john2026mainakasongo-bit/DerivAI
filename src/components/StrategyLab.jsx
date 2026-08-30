import { useEffect, useMemo, useRef, useState } from "react";
import { analyzeUnifiedSignals } from "../analysis/v71UnifiedSignalEngine";
import "./StrategyLab.css";

const EMPTY_RESULT = {
  digit: {
    best: null,
    sampleSize: 0,
    currentDigit: null,
    reason: "Waiting for live Deriv ticks.",
  },
};

const EMPTY_TEST = {
  trades: 0,
  wins: 0,
  losses: 0,
  hitRate: 0,
  netR: 0,
  maxDD: 0,
  maxLossStreak: 0,
  curve: [0],
};

function evaluate(candidate, digit) {
  if (!candidate || !Number.isInteger(digit)) return false;
  if (candidate.mode === "OVER") return digit > Number(candidate.prediction);
  if (candidate.mode === "UNDER") return digit < Number(candidate.prediction);
  if (candidate.mode === "EVEN") return digit % 2 === 0;
  if (candidate.mode === "ODD") return digit % 2 === 1;
  if (candidate.mode === "DIFFERS") return digit !== Number(candidate.prediction);
  return false;
}

// Deliberately bounded: the previous V1 backtest ran the full calibrated engine
// hundreds of times on every live tick, which could block the browser main thread.
function runBoundedBacktest(digits, minimumConfidence = 88) {
  const sample = Array.isArray(digits) ? digits.slice(-260) : [];
  if (sample.length < 180) return EMPTY_TEST;

  let wins = 0;
  let losses = 0;
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  let lossStreak = 0;
  let maxLossStreak = 0;
  const curve = [0];

  // 22 checkpoints max. Each checkpoint sees only data before its outcome.
  const start = Math.max(160, sample.length - 220);
  for (let i = start; i < sample.length; i += 4) {
    const history = sample.slice(0, i);
    const result = analyzeUnifiedSignals({
      digitHistory: history,
      minimumConfidence,
    });
    const candidate = result.digit.best;
    if (!candidate) continue;

    const won = evaluate(candidate, sample[i]);
    const r = won ? 1 : -1;
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
  const path = values
    .map((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * width;
      const y = height - ((value - min) / range) * (height - 20) - 10;
      return `${index ? "L" : "M"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg className="strategyChart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="3" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Metric({ label, value }) {
  return (
    <div className="strategyMetric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default function StrategyLab({ data }) {
  const rawDigits = data?.digitHistory || [];
  const digits = useMemo(() => rawDigits.slice(-260), [rawDigits]);
  const [result, setResult] = useState(EMPTY_RESULT);
  const [test, setTest] = useState(EMPTY_TEST);
  const analysisTimer = useRef(null);
  const backtestTimer = useRef(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (analysisTimer.current) window.clearTimeout(analysisTimer.current);
      if (backtestTimer.current) window.clearTimeout(backtestTimer.current);
    };
  }, []);

  useEffect(() => {
    if (analysisTimer.current) window.clearTimeout(analysisTimer.current);

    analysisTimer.current = window.setTimeout(() => {
      analysisTimer.current = null;
      if (!mounted.current) return;

      // Keep the live calculation bounded and off the render path.
      const next = analyzeUnifiedSignals({
        digitHistory: digits,
        minimumConfidence: 88,
      });
      if (mounted.current) setResult(next);
    }, 2200);

    return () => {
      if (analysisTimer.current) window.clearTimeout(analysisTimer.current);
      analysisTimer.current = null;
    };
  }, [digits]);

  useEffect(() => {
    if (digits.length < 180) {
      setTest(EMPTY_TEST);
      return undefined;
    }

    if (backtestTimer.current) window.clearTimeout(backtestTimer.current);
    backtestTimer.current = window.setTimeout(() => {
      backtestTimer.current = null;
      if (!mounted.current) return;
      const next = runBoundedBacktest(digits, 88);
      if (mounted.current) setTest(next);
    }, 7000);

    return () => {
      if (backtestTimer.current) window.clearTimeout(backtestTimer.current);
      backtestTimer.current = null;
    };
  }, [digits]);

  const best = result.digit.best;
  const signal = best?.setup || "WAIT";
  const confidence = best?.confidence ?? 0;
  const sampleSize = result.digit.sampleSize || digits.length;

  return (
    <section className="strategyLab panel">
      <div className="strategyHeader">
        <div>
          <small>CALIBRATED STRATEGY LAB V2</small>
          <h2>Deriv Strategy Engine</h2>
          <p>Live analysis is throttled to keep the dashboard responsive. No automatic trade is placed.</p>
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
          <div className="confidenceRow"><span>Confidence</span><b>{confidence.toFixed(1)}%</b></div>
        </div>

        <div className="strategyMetrics">
          <Metric label="Current digit" value={result.digit.currentDigit ?? "—"} />
          <Metric label="History" value={sampleSize} />
          <Metric label="Model" value={best?.source?.replaceAll("_", " ") || "SCANNING"} />
          <Metric label="Risk mode" value="FIXED / NO MARTINGALE" />
        </div>
      </div>

      <div className="strategySectionTitle">BOUNDED WALK-FORWARD BACKTEST</div>
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
        It does <b>not</b> represent actual Deriv payout, fees, or stake sizing.
      </div>
    </section>
  );
}
