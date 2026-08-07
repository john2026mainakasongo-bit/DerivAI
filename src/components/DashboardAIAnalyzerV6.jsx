import { useMemo } from "react";
import "./DashboardAIAnalyzerV6.css";

const clamp = (n, min = 0, max = 100) =>
  Math.max(min, Math.min(max, Number(n) || 0));

function cleanDigits(history = []) {
  return history
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 9);
}

function weightedRate(arrays, test) {
  const weights = [0.55, 0.30, 0.15];
  return arrays.reduce((sum, arr, i) => {
    if (!arr.length) return sum;
    const rate = (arr.filter(test).length / arr.length) * 100;
    return sum + rate * weights[i];
  }, 0);
}

function buildContracts(history = []) {
  const digits = cleanDigits(history);
  const short = digits.slice(-35);
  const medium = digits.slice(-100);
  const long = digits.slice(-300);

  const calc = (type, barrier) => {
    const test =
      type === "OVER"
        ? (d) => d > barrier
        : (d) => d < barrier;

    const raw = clamp(weightedRate([short, medium, long], test));

    // Practical quality weighting:
    // keeps very easy thresholds such as OVER 0 / UNDER 9 visible,
    // but prevents them from always dominating the AI recommendation.
    const edgePenalty =
      type === "OVER"
        ? barrier === 0 ? 14 : barrier === 1 ? 6 : 0
        : barrier === 9 ? 14 : barrier === 8 ? 6 : 0;

    return {
      key: `${type}-${barrier}`,
      type,
      barrier,
      raw,
      score: clamp(raw - edgePenalty),
    };
  };

  return {
    over: Array.from({ length: 9 }, (_, barrier) => calc("OVER", barrier)),
    under: Array.from({ length: 9 }, (_, i) => calc("UNDER", i + 1)),
  };
}

function tone(score) {
  if (score >= 70) return "good";
  if (score >= 55) return "watch";
  return "weak";
}

export default function DashboardAIAnalyzerV6({ data }) {
  const {
    connected,
    market = {},
    currentPrice,
    lastDigit,
    digitHistory = [],
  } = data || {};

  const digits = useMemo(() => cleanDigits(digitHistory), [digitHistory]);
  const contracts = useMemo(() => buildContracts(digits), [digits]);

  const ranked = useMemo(
    () => [...contracts.over, ...contracts.under].sort((a, b) => b.score - a.score),
    [contracts]
  );

  const best = ranked[0] || { key: "WAIT", type: "WAIT", barrier: null, score: 0 };
  const enoughData = digits.length >= 40;
  const valid = Boolean(connected && enoughData && best.score >= 72);

  const displayPrice =
    Number.isFinite(Number(currentPrice))
      ? Number(currentPrice).toFixed(market?.decimals ?? 2)
      : "—";

  return (
    <section className="epAIV6">
      <div className="epAIV6Head">
        <div>
          <small>CONTRACT ANALYZER</small>
          <h2>Over / Under Live Matrix</h2>
          <p>{market?.label || "Deriv Market"} · {displayPrice}</p>
        </div>

        <div className={valid ? "epAIV6Status valid" : "epAIV6Status"}>
          {valid ? `ENTRY VALID · ${best.type} ${best.barrier}` : enoughData ? "SCANNING" : "LEARNING"}
        </div>
      </div>

      <div className="epAIV6Matrix">
        <div className="epAIV6Column">
          <div className="epAIV6ColumnTitle">
            <span>OVER</span>
            <b>0 → 8</b>
          </div>

          {contracts.over.map((item) => {
            const active = best.key === item.key;
            return (
              <div
                key={item.key}
                className={`epAIV6Row ${tone(item.score)} ${active ? "active" : ""}`}
              >
                <div className="epAIV6Name">
                  <strong>Over {item.barrier}</strong>
                  <small>digit &gt; {item.barrier}</small>
                </div>

                <div className="epAIV6BarWrap">
                  <i style={{ width: `${item.score}%` }} />
                </div>

                <b className="epAIV6Pct">{item.score.toFixed(1)}%</b>
              </div>
            );
          })}
        </div>

        <div className="epAIV6Column">
          <div className="epAIV6ColumnTitle">
            <span>UNDER</span>
            <b>1 → 9</b>
          </div>

          {contracts.under.map((item) => {
            const active = best.key === item.key;
            return (
              <div
                key={item.key}
                className={`epAIV6Row ${tone(item.score)} ${active ? "active" : ""}`}
              >
                <div className="epAIV6Name">
                  <strong>Under {item.barrier}</strong>
                  <small>digit &lt; {item.barrier}</small>
                </div>

                <div className="epAIV6BarWrap">
                  <i style={{ width: `${item.score}%` }} />
                </div>

                <b className="epAIV6Pct">{item.score.toFixed(1)}%</b>
              </div>
            );
          })}
        </div>
      </div>

      <div className="epAIV6Foot">
        <div>
          <span>BEST CURRENT SETUP</span>
          <strong>{enoughData ? `${best.type} ${best.barrier}` : "COLLECTING DATA"}</strong>
        </div>

        <div className={valid ? "epAIV6Digit blink" : "epAIV6Digit"}>
          {lastDigit ?? "—"}
        </div>

        <div className="epAIV6FootScore">
          <span>ADAPTIVE SCORE</span>
          <strong>{best.score.toFixed(1)}%</strong>
        </div>
      </div>
    </section>
  );
}
