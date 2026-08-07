import { useEffect, useMemo, useRef, useState } from "react";
import "./DashboardAIAnalyzer.css";

const clamp = (n, min = 0, max = 100) =>
  Math.max(min, Math.min(max, Number(n) || 0));

const pct = (n) => `${clamp(n).toFixed(1)}%`;

function cleanDigits(history = []) {
  return history
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 9);
}

function buildDistribution(history = []) {
  const digits = cleanDigits(history).slice(-300);
  const counts = Array(10).fill(0);

  for (const d of digits) counts[d] += 1;

  const total = digits.length || 1;

  return counts.map((count, digit) => ({
    digit,
    count,
    percent: (count / total) * 100,
  }));
}

function buildTransitions(history = []) {
  const digits = cleanDigits(history).slice(-500);
  const matrix = Array.from({ length: 10 }, () => Array(10).fill(0));

  for (let i = 1; i < digits.length; i += 1) {
    matrix[digits[i - 1]][digits[i]] += 1;
  }

  return matrix;
}

function entropy(distribution = []) {
  const probs = distribution
    .map((item) => item.percent / 100)
    .filter((p) => p > 0);

  if (!probs.length) return 100;

  const h = -probs.reduce((sum, p) => sum + p * Math.log2(p), 0);
  const max = Math.log2(10);

  return clamp((h / max) * 100);
}

function buildContractRows(history = []) {
  const digits = cleanDigits(history);
  const short = digits.slice(-35);
  const medium = digits.slice(-100);
  const long = digits.slice(-300);

  const srcS = short.length ? short : digits;
  const srcM = medium.length ? medium : digits;
  const srcL = long.length ? long : digits;

  const rate = (arr, test) =>
    arr.length ? (arr.filter(test).length / arr.length) * 100 : 0;

  const score = (type, barrier) => {
    const test =
      type === "OVER"
        ? (d) => d > barrier
        : (d) => d < barrier;

    const s = rate(srcS, test);
    const m = rate(srcM, test);
    const l = rate(srcL, test);

    const weighted = s * 0.55 + m * 0.30 + l * 0.15;

    return {
      key: `${type}-${barrier}`,
      type,
      barrier,
      shortRate: s,
      mediumRate: m,
      longRate: l,
      rawScore: clamp(weighted),
    };
  };

  return {
    over: Array.from({ length: 9 }, (_, barrier) => score("OVER", barrier)),
    under: Array.from({ length: 9 }, (_, i) => score("UNDER", i + 1)),
  };
}

function parityScore(history = []) {
  const digits = cleanDigits(history).slice(-120);
  const total = digits.length || 1;
  const even = (digits.filter((d) => d % 2 === 0).length / total) * 100;
  return {
    even,
    odd: 100 - even,
  };
}

function transitionStats(matrix, digit) {
  const current = Number(digit);

  if (!Number.isInteger(current) || current < 0 || current > 9) {
    return {
      samples: 0,
      above1: 50,
      below8: 50,
      nextHigh: 50,
      nextLow: 50,
    };
  }

  const row = matrix[current] || [];
  const samples = row.reduce((sum, n) => sum + n, 0);

  if (!samples) {
    return {
      samples: 0,
      above1: 50,
      below8: 50,
      nextHigh: 50,
      nextLow: 50,
    };
  }

  const percent = (hits) => (hits / samples) * 100;

  return {
    samples,
    above1: percent(row.slice(2).reduce((a, b) => a + b, 0)),
    below8: percent(row.slice(0, 8).reduce((a, b) => a + b, 0)),
    nextHigh: percent(row.slice(5).reduce((a, b) => a + b, 0)),
    nextLow: percent(row.slice(0, 5).reduce((a, b) => a + b, 0)),
  };
}

function scoreTone(score) {
  if (score >= 80) return "strong";
  if (score >= 70) return "good";
  if (score >= 60) return "watch";
  return "weak";
}

function labelContract(item) {
  if (!item) return "WAIT";
  if (item.barrier == null) return item.type;
  return `${item.type} ${item.barrier}`;
}

function useLearningStore(symbol) {
  const key = `edgepilot-ai-analyzer:${symbol || "market"}`;

  const [memory, setMemory] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(key) || "{}");
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(memory));
    } catch {}
  }, [key, memory]);

  return [memory, setMemory];
}

export default function DashboardAIAnalyzer({ data }) {
  const {
    connected,
    market = {},
    symbol,
    prices = [],
    currentPrice,
    lastDigit,
    digitHistory = [],
  } = data || {};

  const [memory, setMemory] = useLearningStore(symbol);
  const previousDigitRef = useRef(null);

  const digits = useMemo(
    () => cleanDigits(digitHistory),
    [digitHistory]
  );

  const distribution = useMemo(
    () => buildDistribution(digits),
    [digits]
  );

  const matrix = useMemo(
    () => buildTransitions(digits),
    [digits]
  );

  const transitions = useMemo(
    () => transitionStats(matrix, lastDigit),
    [matrix, lastDigit]
  );

  const contracts = useMemo(
    () => buildContractRows(digits),
    [digits]
  );

  const parity = useMemo(
    () => parityScore(digits),
    [digits]
  );

  const entropyValue = useMemo(
    () => entropy(distribution),
    [distribution]
  );

  const learnedRows = useMemo(() => {
    const all = [
      ...contracts.over,
      ...contracts.under,
      {
        key: "EVEN",
        type: "EVEN",
        barrier: null,
        rawScore: parity.even,
      },
      {
        key: "ODD",
        type: "ODD",
        barrier: null,
        rawScore: parity.odd,
      },
    ];

    return all
      .map((item) => {
        let adaptive = item.rawScore;
        const learned = memory[item.key];

        if (learned?.samples >= 5) {
          const observed = (learned.wins / learned.samples) * 100;
          adaptive = adaptive * 0.82 + observed * 0.18;
        }

        // Small transition adjustment, never a forced signal.
        if (
          item.type === "OVER" &&
          item.barrier === 1 &&
          Number(lastDigit) <= 1 &&
          transitions.samples >= 5
        ) {
          adaptive = adaptive * 0.80 + transitions.above1 * 0.20;
        }

        if (
          item.type === "UNDER" &&
          item.barrier === 8 &&
          Number(lastDigit) >= 8 &&
          transitions.samples >= 5
        ) {
          adaptive = adaptive * 0.80 + transitions.below8 * 0.20;
        }

        return {
          ...item,
          score: clamp(adaptive),
          learned,
        };
      })
      .sort((a, b) => b.score - a.score);
  }, [contracts, parity, memory, lastDigit, transitions]);

  const best = learnedRows[0] || {
    key: "WAIT",
    type: "WAIT",
    barrier: null,
    score: 0,
  };

  const enoughData = digits.length >= 40;
  const noiseHigh = entropyValue >= 98.6;
  const confidence = clamp(best.score);

  const entryValid =
    Boolean(connected) &&
    enoughData &&
    !noiseHigh &&
    confidence >= 76;

  const setup = labelContract(best);

  const displayPrice =
    Number.isFinite(Number(currentPrice))
      ? Number(currentPrice).toFixed(market?.decimals ?? 2)
      : "—";

  const momentum = useMemo(() => {
    const p = prices.slice(-24).map(Number).filter(Number.isFinite);

    if (p.length < 5) return "COLLECTING";

    const first = p[0];
    const last = p[p.length - 1];
    const delta = last - first;

    if (Math.abs(delta) < 1e-9) return "FLAT";
    return delta > 0 ? "UP" : "DOWN";
  }, [prices]);

  const regime = !enoughData
    ? "LEARNING"
    : noiseHigh
      ? "NOISY"
      : confidence >= 80
        ? "FAVORABLE"
        : confidence >= 68
          ? "MIXED"
          : "WEAK";

  const risk =
    !enoughData || noiseHigh
      ? "HIGH"
      : confidence >= 82
        ? "LOW"
        : confidence >= 72
          ? "MEDIUM"
          : "HIGH";

  const recentDigits = digits.slice(-18);

  const hotDigits = [...distribution]
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 3);

  const coldDigits = [...distribution]
    .sort((a, b) => a.percent - b.percent)
    .slice(0, 3);

  const reason = useMemo(() => {
    if (!enoughData) {
      return `Collecting live data. ${digits.length}/40 minimum samples available.`;
    }

    if (noiseHigh) {
      return "Digit distribution is currently highly random/noisy, so the analyzer is withholding an entry.";
    }

    const parts = [
      `${setup} currently has the highest adaptive score at ${confidence.toFixed(1)}%.`,
      `Short, medium and long tick windows are recalculated on every incoming digit.`,
    ];

    if (
      best.type === "OVER" &&
      best.barrier === 1 &&
      Number(lastDigit) <= 1 &&
      transitions.samples >= 5
    ) {
      parts.push(
        `After digit ${lastDigit}, ${transitions.above1.toFixed(1)}% of observed next digits were above 1 across ${transitions.samples} matching transitions.`
      );
    }

    if (
      best.type === "UNDER" &&
      best.barrier === 8 &&
      Number(lastDigit) >= 8 &&
      transitions.samples >= 5
    ) {
      parts.push(
        `After digit ${lastDigit}, ${transitions.below8.toFixed(1)}% of observed next digits were below 8 across ${transitions.samples} matching transitions.`
      );
    }

    return parts.join(" ");
  }, [
    enoughData,
    digits.length,
    noiseHigh,
    setup,
    confidence,
    best.type,
    best.barrier,
    lastDigit,
    transitions,
  ]);

  useEffect(() => {
    if (!connected || !enoughData || lastDigit == null) return;

    const now = Number(lastDigit);

    if (previousDigitRef.current === now) return;
    previousDigitRef.current = now;

    const pendingKey = `edgepilot-ai-pending:${symbol}`;
    const raw = sessionStorage.getItem(pendingKey);

    if (raw) {
      try {
        const pending = JSON.parse(raw);

        let won = false;

        if (pending.type === "OVER") won = now > pending.barrier;
        if (pending.type === "UNDER") won = now < pending.barrier;
        if (pending.type === "EVEN") won = now % 2 === 0;
        if (pending.type === "ODD") won = now % 2 === 1;

        setMemory((old) => {
          const current = old[pending.key] || {
            samples: 0,
            wins: 0,
          };

          return {
            ...old,
            [pending.key]: {
              samples: current.samples + 1,
              wins: current.wins + (won ? 1 : 0),
            },
          };
        });
      } catch {}
    }

    if (confidence >= 65) {
      sessionStorage.setItem(
        pendingKey,
        JSON.stringify({
          key: best.key,
          type: best.type,
          barrier: best.barrier,
          confidence,
        })
      );
    }
  }, [
    connected,
    enoughData,
    lastDigit,
    symbol,
    confidence,
    best.key,
    best.type,
    best.barrier,
    setMemory,
  ]);

  const findScore = (key, fallback = 0) =>
    learnedRows.find((x) => x.key === key)?.score ?? fallback;

  return (
    <section className="epAIAnalyzer">
      <div className="epAIHeader">
        <div>
          <span className="epAIKicker">LIVE ADAPTIVE ANALYSIS</span>
          <h2>AI Market Analyzer</h2>
          <p>
            Current market: <b>{market?.label || symbol || "—"}</b>
          </p>
        </div>

        <div className="epAIHeaderRight">
          <div className={`epAILive ${connected ? "on" : ""}`}>
            <span />
            {connected ? "LIVE" : "OFFLINE"}
          </div>

          <div className={`epAIEntryBadge ${entryValid ? "valid" : ""}`}>
            {entryValid ? "ENTRY VALID" : enoughData ? "WAIT" : "LEARNING"}
          </div>
        </div>
      </div>

      <div className="epAITopGrid">
        <article className="epAIMetric epAIMetricPrimary">
          <span>BEST SETUP</span>
          <strong>{enoughData ? setup : "COLLECTING"}</strong>
          <b>{pct(confidence)}</b>
          <small>Risk: {risk}</small>
        </article>

        <article className="epAIMetric epAIDigitMetric">
          <span>CURRENT DIGIT</span>
          <div className={`epAIBigDigit ${entryValid ? "blink" : ""}`}>
            {lastDigit ?? "—"}
          </div>
          <small>Price {displayPrice}</small>
        </article>

        <article className="epAIMetric">
          <span>REGIME</span>
          <strong>{regime}</strong>
          <small>Entropy {entropyValue.toFixed(1)}%</small>
        </article>

        <article className="epAIMetric">
          <span>MOMENTUM</span>
          <strong>{momentum}</strong>
          <small>{digits.length} live digit samples</small>
        </article>

        <article className="epAIMetric">
          <span>LEARNING</span>
          <strong>ACTIVE</strong>
          <small>{Object.keys(memory).length} learned setups</small>
        </article>
      </div>

      <div className="epAIMainGrid">
        <article className="epAIPanel epAIDigitsPanel">
          <div className="epAIPanelTitle">
            <div>
              <span>LIVE DIGITS</span>
              <h3>Distribution & movement</h3>
            </div>
            <b>{digits.length}/300</b>
          </div>

          <div className="epAIRecentDigits">
            {recentDigits.length ? (
              recentDigits.map((digit, index) => (
                <span
                  key={`${index}-${digit}`}
                  className={
                    index === recentDigits.length - 1
                      ? entryValid
                        ? "latest valid"
                        : "latest"
                      : ""
                  }
                >
                  {digit}
                </span>
              ))
            ) : (
              <em>Waiting for Deriv live ticks...</em>
            )}
          </div>

          <div className="epAIDistribution">
            {distribution.map((item) => (
              <div
                key={item.digit}
                className={
                  item.digit === Number(lastDigit) ? "current" : ""
                }
              >
                <span>{item.percent.toFixed(1)}%</span>
                <i
                  style={{
                    height: `${Math.max(6, item.percent * 4.5)}px`,
                  }}
                />
                <b>{item.digit}</b>
              </div>
            ))}
          </div>

          <div className="epAIHotCold">
            <div>
              <span>HOT</span>
              {hotDigits.map((d) => (
                <b key={d.digit}>{d.digit}</b>
              ))}
            </div>

            <div>
              <span>COLD</span>
              {coldDigits.map((d) => (
                <b key={d.digit}>{d.digit}</b>
              ))}
            </div>
          </div>
        </article>

        <article className="epAIPanel epAIContractsPanel">
          <div className="epAIPanelTitle">
            <div>
              <span>CONTRACT ANALYZER</span>
              <h3>Over / Under</h3>
            </div>
            <b>{entryValid ? "READY" : "SCANNING"}</b>
          </div>

          <div className="epAIContractColumns">
            <div>
              <h4>OVER</h4>

              {contracts.over.map((row) => {
                const value = findScore(row.key, row.rawScore);
                const active = best.key === row.key;

                return (
                  <div
                    key={row.key}
                    className={`epAIContractRow ${active ? "active" : ""} ${scoreTone(value)}`}
                  >
                    <span>Over {row.barrier}</span>
                    <b>{pct(value)}</b>
                  </div>
                );
              })}
            </div>

            <div>
              <h4>UNDER</h4>

              {contracts.under.map((row) => {
                const value = findScore(row.key, row.rawScore);
                const active = best.key === row.key;

                return (
                  <div
                    key={row.key}
                    className={`epAIContractRow ${active ? "active" : ""} ${scoreTone(value)}`}
                  >
                    <span>Under {row.barrier}</span>
                    <b>{pct(value)}</b>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="epAIParity">
            <div className={best.key === "EVEN" ? "active" : ""}>
              <span>EVEN</span>
              <b>{pct(findScore("EVEN", parity.even))}</b>
            </div>

            <div className={best.key === "ODD" ? "active" : ""}>
              <span>ODD</span>
              <b>{pct(findScore("ODD", parity.odd))}</b>
            </div>
          </div>
        </article>

        <article className="epAIPanel epAIThinkingPanel">
          <div className="epAIPanelTitle">
            <div>
              <span>AI THINKING</span>
              <h3>Why the signal?</h3>
            </div>
            <b>{risk}</b>
          </div>

          <div className="epAIThinkingStats">
            <div>
              <span>Confidence</span>
              <b>{pct(confidence)}</b>
            </div>

            <div>
              <span>Entropy</span>
              <b>{entropyValue.toFixed(1)}%</b>
            </div>

            <div>
              <span>Transition samples</span>
              <b>{transitions.samples}</b>
            </div>

            <div>
              <span>Next high digits</span>
              <b>{pct(transitions.nextHigh)}</b>
            </div>

            <div>
              <span>Next low digits</span>
              <b>{pct(transitions.nextLow)}</b>
            </div>

            <div>
              <span>Observed OVER 1 transition</span>
              <b>{pct(transitions.above1)}</b>
            </div>
          </div>

          <div className={`epAIReason ${entryValid ? "valid" : ""}`}>
            <span>ANALYSIS</span>
            <p>{reason}</p>
          </div>

          <div className="epAILearnBar">
            <div>
              <span>Adaptive learning</span>
              <b>ACTIVE</b>
            </div>

            <button
              type="button"
              onClick={() => setMemory({})}
            >
              Reset
            </button>
          </div>
        </article>
      </div>

      <div className={`epAIFinal ${entryValid ? "valid" : ""}`}>
        <div>
          <span>AI RECOMMENDATION</span>
          <strong>{entryValid ? setup : "WAIT"}</strong>
          <p>
            {entryValid
              ? `Current filters passed at ${confidence.toFixed(1)}% adaptive confidence.`
              : "The analyzer is continuing to scan the active market."}
          </p>
        </div>

        <div className="epAIFinalStats">
          <div>
            <span>Digit</span>
            <b>{lastDigit ?? "—"}</b>
          </div>
          <div>
            <span>Risk</span>
            <b>{risk}</b>
          </div>
          <div>
            <span>Regime</span>
            <b>{regime}</b>
          </div>
          <div>
            <span>Status</span>
            <b>{entryValid ? "VALID" : "WAIT"}</b>
          </div>
        </div>
      </div>

      <p className="epAIDisclaimer">
        Analysis only. Scores are adaptive estimates from observed live data and are not guaranteed outcomes.
      </p>
    </section>
  );
}
