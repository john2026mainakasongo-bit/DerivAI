import { useEffect, useMemo, useRef, useState } from "react";
import analyzeUnifiedSignals from "../analysis/v71UnifiedSignalEngine";
import "./StrategyLab.css";

const MIN_HISTORY = 100;
const MAX_HISTORY = 500;
const FORWARD_MAX_SAMPLES = 40;

function clampHistory(values) {
  return (Array.isArray(values) ? values : [])
    .map(Number)
    .filter((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9)
    .slice(-MAX_HISTORY);
}

function resultForCandidate(candidate, nextDigit) {
  if (!candidate || !Number.isInteger(nextDigit)) return null;
  if (candidate.mode === "OVER") return nextDigit > Number(candidate.prediction);
  if (candidate.mode === "UNDER") return nextDigit < Number(candidate.prediction);
  if (candidate.mode === "EVEN") return nextDigit % 2 === 0;
  if (candidate.mode === "ODD") return nextDigit % 2 === 1;
  if (candidate.mode === "DIFFERS") return nextDigit !== Number(candidate.prediction);
  return null;
}

function formatPct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function Metric({ label, value, tone = "" }) {
  return (
    <div className="strategyMetric">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  );
}

function buildForwardTest(digits) {
  const sample = clampHistory(digits);
  if (sample.length < MIN_HISTORY + 1) {
    return { signals: 0, wins: 0, losses: 0, hitRate: 0, normalizedR: 0, maxDrawdown: 0, maxLossStreak: 0, equity: [] };
  }

  const start = Math.max(MIN_HISTORY, sample.length - FORWARD_MAX_SAMPLES - 1);
  let wins = 0;
  let losses = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let lossStreak = 0;
  let maxLossStreak = 0;
  const equityPoints = [0];

  for (let index = start; index < sample.length - 1; index += 1) {
    const history = sample.slice(0, index);
    const analysis = analyzeUnifiedSignals({ digitHistory: history, minimumConfidence: 88 });
    const candidate = analysis?.digit?.best;
    if (!candidate) continue;

    const won = resultForCandidate(candidate, sample[index]);
    if (won === null) continue;

    if (won) {
      wins += 1;
      equity += 1;
      lossStreak = 0;
    } else {
      losses += 1;
      equity -= 1;
      lossStreak += 1;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    }

    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    equityPoints.push(equity);
  }

  const signals = wins + losses;
  return {
    signals,
    wins,
    losses,
    hitRate: signals ? (wins / signals) * 100 : 0,
    normalizedR: equity,
    maxDrawdown,
    maxLossStreak,
    equity: equityPoints,
  };
}

function EquityCurve({ points }) {
  if (!points?.length || points.length < 2) return null;
  const width = 900;
  const height = 150;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = Math.max(1, max - min);
  const d = points.map((point, index) => {
    const x = (index / Math.max(1, points.length - 1)) * width;
    const y = height - ((point - min) / range) * (height - 20) - 10;
    return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  return (
    <div className="strategyEquity">
      <div className="strategySubhead"><span>FORWARD-TEST EQUITY</span><small>Normalized R</small></div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <path d={d} fill="none" stroke="currentColor" strokeWidth="3" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

export default function StrategyLab({ data }) {
  const digits = useMemo(() => clampHistory(data?.digitHistory), [data?.digitHistory]);
  const [computed, setComputed] = useState(null);
  const lastRun = useRef(0);

  useEffect(() => {
    const now = Date.now();
    const wait = Math.max(0, 650 - (now - lastRun.current));
    const timer = window.setTimeout(() => {
      lastRun.current = Date.now();
      const signal = analyzeUnifiedSignals({ digitHistory: digits, minimumConfidence: 88 });
      const forward = buildForwardTest(digits);
      setComputed({ signal, forward });
    }, wait);
    return () => window.clearTimeout(timer);
  }, [digits]);

  const signal = computed?.signal;
  const forward = computed?.forward;
  const best = signal?.digit?.best || null;
  const candidate = best || signal?.digit?.candidates?.[0] || null;
  const ready = digits.length >= MIN_HISTORY;
  const executable = Boolean(best?.executable);

  return (
    <section className="strategyLab panel">
      <div className="strategyLabHeader">
        <div>
          <small>CALIBRATED STRATEGY LAB V3</small>
          <h2>Deriv Strategy Engine</h2>
          <p>Live digit calibration, strict entry validation and forward testing. No automatic trade is placed.</p>
        </div>
        <div className={`strategyState ${executable ? "valid" : "wait"}`}>
          <span /> {executable ? "ENTRY VALID" : "WAIT"}
        </div>
      </div>

      <div className="strategyPrimaryGrid">
        <article className={`strategySignal ${executable ? "valid" : ""}`}>
          <span>BEST SETUP</span>
          <strong>{ready ? (candidate?.setup || "WAIT") : "COLLECTING"}</strong>
          <p>{signal?.digit?.reason || `Collecting calibrated history ${digits.length}/${MIN_HISTORY}.`}</p>
          <div className="strategyConfidenceBar"><i style={{ width: `${Math.min(100, Number(candidate?.confidence || 0))}%` }} /></div>
          <div className="strategyConfidenceLine"><span>CONFIDENCE</span><b>{formatPct(candidate?.confidence)}</b></div>
        </article>

        <Metric label="CURRENT DIGIT" value={data?.lastDigit ?? "—"} />
        <Metric label="HISTORY" value={`${digits.length}/${MIN_HISTORY}`} tone={ready ? "good" : ""} />
        <Metric label="MODEL" value={ready ? (candidate?.source || "SCANNING") : "CALIBRATING"} />
        <Metric label="RISK MODE" value="FIXED / NO MARTINGALE" />
      </div>

      <div className="strategySectionTitle">BOUNDED WALK-FORWARD TEST</div>
      <div className="strategyMetricsGrid">
        <Metric label="SIGNALS" value={forward?.signals ?? 0} />
        <Metric label="HIT RATE" value={formatPct(forward?.hitRate)} tone={Number(forward?.hitRate) >= 55 ? "good" : ""} />
        <Metric label="WINS" value={forward?.wins ?? 0} tone="good" />
        <Metric label="LOSSES" value={forward?.losses ?? 0} tone={forward?.losses ? "bad" : ""} />
        <Metric label="NORMALIZED R" value={`${forward?.normalizedR >= 0 ? "+" : ""}${forward?.normalizedR ?? 0}R`} />
        <Metric label="MAX DRAWDOWN" value={`${forward?.maxDrawdown ?? 0}R`} />
        <Metric label="MAX LOSS STREAK" value={forward?.maxLossStreak ?? 0} />
      </div>

      {ready ? (
        <EquityCurve points={forward?.equity} />
      ) : (
        <div className="strategyEmpty">Collect at least {MIN_HISTORY} digits before the engine evaluates entries and forward-test results.</div>
      )}

      <div className="strategyFooterNote">
        <strong>Research mode:</strong> 1R is a normalized unit only. It does not represent Deriv payout, fees or stake sizing. Historical tests never use the future digit to choose the signal.
      </div>
    </section>
  );
}
