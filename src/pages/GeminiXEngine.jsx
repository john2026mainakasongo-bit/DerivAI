import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";

import useDerivTicks from "../hooks/useDerivTicks";
import styles from "./GeminiXEngine.module.css";

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(
    maximum,
    Math.max(minimum, Number(value) || 0)
  );
}

function percent(value) {
  return `${clamp(value).toFixed(1)}%`;
}

function buildDigitDistribution(digits) {
  const counts = Array(10).fill(0);

  for (const digit of digits) {
    if (Number.isInteger(digit) && digit >= 0 && digit <= 9) {
      counts[digit] += 1;
    }
  }

  const total = Math.max(1, digits.length);

  return counts.map((count, digit) => ({
    digit,
    count,
    percent: (count / total) * 100,
  }));
}

function shannonEntropy(digits) {
  if (!digits.length) return 0;

  const distribution = buildDigitDistribution(digits);
  const entropy = distribution.reduce((total, row) => {
    if (!row.count) return total;
    const probability = row.count / digits.length;
    return total - probability * Math.log2(probability);
  }, 0);

  return clamp((entropy / Math.log2(10)) * 100);
}

function transitionScore(digits) {
  if (digits.length < 3) return 50;

  let changes = 0;

  for (let index = 1; index < digits.length; index += 1) {
    if (digits[index] !== digits[index - 1]) {
      changes += 1;
    }
  }

  return clamp(
    (changes / Math.max(1, digits.length - 1)) * 100
  );
}

function longestRun(digits) {
  if (!digits.length) return 0;

  let longest = 1;
  let current = 1;

  for (let index = 1; index < digits.length; index += 1) {
    if (digits[index] === digits[index - 1]) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 1;
    }
  }

  return longest;
}

function safeContractCandidates(digits) {
  const recent = digits.slice(-60);
  const distribution = buildDigitDistribution(recent);

  const probabilityOver = (barrier) =>
    distribution
      .filter((row) => row.digit > barrier)
      .reduce((total, row) => total + row.percent, 0);

  const probabilityUnder = (barrier) =>
    distribution
      .filter((row) => row.digit < barrier)
      .reduce((total, row) => total + row.percent, 0);

  const candidates = [
    {
      label: "OVER 1",
      contractType: "DIGITOVER",
      barrier: 1,
      probability: probabilityOver(1),
      baseRisk: 8,
    },
    {
      label: "OVER 2",
      contractType: "DIGITOVER",
      barrier: 2,
      probability: probabilityOver(2),
      baseRisk: 18,
    },
    {
      label: "UNDER 8",
      contractType: "DIGITUNDER",
      barrier: 8,
      probability: probabilityUnder(8),
      baseRisk: 8,
    },
    {
      label: "UNDER 7",
      contractType: "DIGITUNDER",
      barrier: 7,
      probability: probabilityUnder(7),
      baseRisk: 18,
    },
    {
      label: "OVER 3",
      contractType: "DIGITOVER",
      barrier: 3,
      probability: probabilityOver(3),
      baseRisk: 36,
    },
    {
      label: "UNDER 6",
      contractType: "DIGITUNDER",
      barrier: 6,
      probability: probabilityUnder(6),
      baseRisk: 36,
    },
  ];

  return candidates
    .map((candidate) => ({
      ...candidate,
      risk: clamp(
        candidate.baseRisk +
          Math.max(0, 72 - candidate.probability) * 0.75
      ),
      score:
        candidate.probability -
        candidate.baseRisk * 0.55,
    }))
    .sort((a, b) => b.score - a.score);
}

function analyseGemini({
  prices,
  digitHistory,
  minConfidence,
}) {
  const digits = digitHistory.slice(-60);
  const recentPrices = prices.slice(-60);
  const sample = Math.min(
    digits.length,
    recentPrices.length || digits.length
  );
  const distribution = buildDigitDistribution(digits);
  const entropy = shannonEntropy(digits);
  const transition = transitionScore(digits);
  const cycle = longestRun(digits);

  const priceWindow = recentPrices.slice(-12);
  const firstPrice = Number(priceWindow[0]);
  const lastPrice = Number(priceWindow.at(-1));
  const priceDelta =
    Number.isFinite(firstPrice) &&
    Number.isFinite(lastPrice)
      ? lastPrice - firstPrice
      : 0;

  const absoluteMoves = recentPrices
    .slice(1)
    .map((price, index) =>
      Math.abs(
        Number(price) -
          Number(recentPrices[index])
      )
    )
    .filter(Number.isFinite);

  const averageMove = absoluteMoves.length
    ? absoluteMoves.reduce((sum, value) => sum + value, 0) /
      absoluteMoves.length
    : 0;

  const latestMove =
    recentPrices.length >= 2
      ? Math.abs(
          Number(recentPrices.at(-1)) -
            Number(recentPrices.at(-2))
        )
      : 0;

  const momentumStrength = clamp(
    averageMove > 0
      ? (Math.abs(priceDelta) /
          Math.max(averageMove, Number.EPSILON)) *
          12
      : 0
  );

  const direction =
    priceDelta > 0
      ? "UP"
      : priceDelta < 0
      ? "DOWN"
      : "NEUTRAL";

  const volatilityRatio =
    averageMove > 0
      ? latestMove / averageMove
      : 1;

  const volatility =
    volatilityRatio > 1.8
      ? "HIGH"
      : volatilityRatio < 0.55
      ? "LOW"
      : "NORMAL";

  const regime =
    momentumStrength >= 70
      ? "BREAKOUT"
      : momentumStrength >= 42
      ? "TREND"
      : "RANGE";

  const candidates = safeContractCandidates(digits);
  const best = candidates[0] || {
    label: "WAIT",
    probability: 50,
    risk: 100,
  };

  const stability = clamp(
    100 -
      Math.abs(entropy - 82) * 1.25 -
      Math.max(0, transition - 92) * 0.7
  );

  const sampleScore = clamp((sample / 60) * 100);
  const probability = clamp(
    best.probability * 0.72 +
      stability * 0.14 +
      sampleScore * 0.14
  );

  const confidence = clamp(
    probability * 0.52 +
      stability * 0.18 +
      sampleScore * 0.18 +
      Math.min(100, momentumStrength) * 0.12 -
      best.risk * 0.12
  );

  const risk =
    best.risk < 25 && confidence >= 72
      ? "LOW"
      : best.risk < 48 && confidence >= 58
      ? "MEDIUM"
      : "HIGH";

  const gates = [
    {
      name: "Sample",
      status: `${sample}/60 ticks`,
      passed: sample >= 24,
    },
    {
      name: "Probability",
      status: percent(probability),
      passed: probability >= 68,
    },
    {
      name: "Confidence",
      status: percent(confidence),
      passed: confidence >= minConfidence,
    },
    {
      name: "Risk",
      status: `${risk} ${percent(best.risk)}`,
      passed: risk !== "HIGH",
    },
    {
      name: "Entropy",
      status: percent(entropy),
      passed: entropy >= 65,
    },
    {
      name: "Transition",
      status: percent(transition),
      passed: transition >= 58,
    },
  ];

  const passed = gates.filter((gate) => gate.passed).length;
  const ready =
    sample >= 24 &&
    passed >= 5 &&
    confidence >= minConfidence &&
    probability >= 68 &&
    risk !== "HIGH";

  return {
    distribution,
    candidates,
    best,
    sample,
    entropy,
    transition,
    cycle,
    momentumStrength,
    direction,
    volatility,
    regime,
    probability,
    confidence,
    risk,
    gates,
    passed,
    decision: ready ? best.label : "WAIT",
    ready,
    reason: ready
      ? `${best.label} imepita ${passed}/6 gates kwenye ${
          sample
        } live digits.`
      : `WAIT: ${passed}/6 gates zimepita. Inakusanya na kuthibitisha live data.`,
  };
}

function GeminiXContent({
  data,
  compact = false,
  showControls = true,
}) {
  const navigate = useNavigate();
  const {
    markets = [],
    market,
    symbol,
    status,
    statusDetail,
    connected,
    loadingMarket,
    prices = [],
    currentPrice,
    lastDigit,
    digitHistory = [],
    selectedAccountId,
    selectedAccountType,
    tradeBusy,
    tradeError,
    connect,
    changeSymbol,
    placeTrade,
  } = data;

  const [stake, setStake] = useState(0.35);
  const [minConfidence, setMinConfidence] = useState(68);
  const [executionMode, setExecutionMode] =
    useState("PAPER");
  const [running, setRunning] = useState(false);
  const [engineMessage, setEngineMessage] =
    useState("GeminiX iko ready kutumia shared Deriv feed.");
  const lastAutoTradeKeyRef = useRef("");

  const analysis = useMemo(
    () =>
      analyseGemini({
        prices,
        digitHistory,
        minConfidence,
      }),
    [prices, digitHistory, minConfidence]
  );

  const executeCandidate = async (
    candidate = analysis.best,
    source = "MANUAL"
  ) => {
    if (!candidate || candidate.label === "WAIT") {
      setEngineMessage("Hakuna candidate ya kununua.");
      return;
    }

    if (executionMode === "PAPER") {
      setEngineMessage(
        `PAPER ${candidate.label} · ${market?.label || symbol} · $${Number(
          stake
        ).toFixed(2)}`
      );
      return;
    }

    if (!analysis.ready) {
      setEngineMessage(
        "Live buy imezuiwa: GeminiX gates hazijapita."
      );
      return;
    }

    try {
      setEngineMessage(
        `${source}: inanunua ${candidate.label}...`
      );

      await placeTrade({
        contractType: candidate.contractType,
        amount: Number(stake),
        duration: 1,
        durationUnit: "t",
        barrier: candidate.barrier,
        symbol,
      });

      setEngineMessage(
        `${candidate.label} imenunuliwa kwa ${symbol}.`
      );
    } catch (error) {
      setEngineMessage(
        error instanceof Error
          ? error.message
          : "GeminiX trade failed."
      );
    }
  };

  useEffect(() => {
    if (
      !running ||
      executionMode !== "LIVE" ||
      !analysis.ready ||
      tradeBusy
    ) {
      return;
    }

    const key = [
      symbol,
      analysis.best.label,
      digitHistory.length,
    ].join(":");

    if (key === lastAutoTradeKeyRef.current) {
      return;
    }

    lastAutoTradeKeyRef.current = key;
    void executeCandidate(analysis.best, "AUTO");
  }, [
    running,
    executionMode,
    analysis.ready,
    analysis.best,
    tradeBusy,
    symbol,
    digitHistory.length,
  ]);

  const recentDigits = digitHistory.slice(-12);
  const feedLabel =
    connected && status === "CONNECTED"
      ? "LIVE"
      : loadingMarket
      ? "LOADING"
      : status || "DISCONNECTED";

  return (
    <section
      className={`${styles.geminiBotShell} ${
        compact ? styles.compact : ""
      }`}
    >
      <div className={styles.geminiTopbar}>
        <div className={styles.statusItems}>
          <div className={styles.statusField}>
            <label>Feed</label>
            <span
              className={`${styles.statusVal} ${
                connected
                  ? styles.textGreen
                  : styles.textRed
              }`}
            >
              {feedLabel}
            </span>
          </div>

          <div className={styles.statusField}>
            <label>Decision</label>
            <span className={styles.statusVal}>
              {analysis.decision}
            </span>
          </div>

          <div className={styles.statusField}>
            <label>Account</label>
            <span className={styles.statusVal}>
              {selectedAccountType || "demo"}{" "}
              {selectedAccountId
                ? `(${selectedAccountId})`
                : ""}
            </span>
          </div>
        </div>

        <div className={styles.statusNote}>
          Shared Deriv feed · no duplicate WebSocket
        </div>
      </div>

      {showControls ? (
        <div className={styles.geminiControlGrid}>
          <div className={styles.inputGroup}>
            <label>Market</label>
            <select
              value={symbol || ""}
              disabled={loadingMarket}
              onChange={(event) =>
                void changeSymbol(event.target.value)
              }
            >
              {markets.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.inputGroup}>
            <label>Stake ($)</label>
            <input
              type="number"
              min="0.35"
              step="0.01"
              value={stake}
              onChange={(event) =>
                setStake(
                  Math.max(
                    0.35,
                    Number(event.target.value || 0.35)
                  )
                )
              }
            />
          </div>

          <div className={styles.inputGroup}>
            <label>Min Confidence (%)</label>
            <input
              type="number"
              min="55"
              max="95"
              value={minConfidence}
              onChange={(event) =>
                setMinConfidence(
                  clamp(event.target.value, 55, 95)
                )
              }
            />
          </div>

          <div className={styles.inputGroup}>
            <label>Execution</label>
            <select
              value={executionMode}
              onChange={(event) =>
                setExecutionMode(event.target.value)
              }
            >
              <option value="PAPER">Paper Trading</option>
              <option value="LIVE">Live Trading</option>
            </select>
          </div>

          <button
            type="button"
            className={`${styles.btnAction} ${
              running
                ? styles.stopBtn
                : styles.startBtn
            }`}
            onClick={() => {
              if (!connected) {
                void connect().catch(() => {});
              }
              setRunning((value) => !value);
            }}
          >
            {running
              ? "STOP GEMINIX"
              : "START GEMINIX"}
          </button>
        </div>
      ) : null}

      {statusDetail || tradeError ? (
        <div className={styles.errorBox}>
          {tradeError || statusDetail}
        </div>
      ) : null}

      <div className={styles.geminiMainGrid}>
        <article className={styles.geminiPanel}>
          <div className={styles.panelHeader}>
            <span className={styles.title}>
              GEMINIX LIVE DECISION
            </span>
            <div className={styles.tags}>
              <span className={styles.recBadge}>
                REC: {analysis.best.label}
              </span>
              <span
                className={`${styles.decisionBadge} ${
                  analysis.ready
                    ? styles.execute
                    : styles.wait
                }`}
              >
                {analysis.decision}
              </span>
            </div>
          </div>

          <div className={styles.largeDecisionText}>
            {analysis.decision}
          </div>
          <p className={styles.reasonText}>
            {analysis.reason}
          </p>

          <div className={styles.gatesGrid}>
            {analysis.gates.map((gate) => (
              <div
                key={gate.name}
                className={`${styles.gateCard} ${
                  gate.passed
                    ? styles.gatePass
                    : styles.gateFail
                }`}
              >
                <span>
                  {gate.passed ? "✓" : "✕"}
                </span>
                <div>
                  <strong>{gate.name}: </strong>
                  <span>{gate.status}</span>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className={styles.geminiPanel}>
          <div className={styles.panelHeader}>
            <span className={styles.title}>
              LIVE METRICS
            </span>
          </div>

          <div className={styles.metricsList}>
            <div className={styles.metricRow}>
              <span>Market</span>
              <strong>
                {market?.short || symbol || "—"}
              </strong>
            </div>
            <div className={styles.metricRow}>
              <span>Quote</span>
              <strong>
                {Number.isFinite(currentPrice)
                  ? Number(currentPrice).toFixed(
                      market?.decimals || 3
                    )
                  : "—"}
              </strong>
            </div>
            <div className={styles.metricRow}>
              <span>Last digit</span>
              <strong>{lastDigit ?? "—"}</strong>
            </div>
            <div className={styles.metricRow}>
              <span>Confidence</span>
              <strong>
                {percent(analysis.confidence)}
              </strong>
            </div>
            <div className={styles.metricRow}>
              <span>Probability</span>
              <strong>
                {percent(analysis.probability)}
              </strong>
            </div>
            <div className={styles.metricRow}>
              <span>Risk</span>
              <strong>{analysis.risk}</strong>
            </div>
          </div>
        </article>
      </div>

      <article className={styles.geminiPanel}>
        <div className={styles.panelHeader}>
          <span className={styles.title}>
            LIVE DIGITS & QUICK TRADING
          </span>
          <span className={styles.statusNote}>
            {analysis.sample}/60 samples
          </span>
        </div>

        <div className={styles.recentRow}>
          <div className={styles.recentDigits}>
            {recentDigits.length ? (
              recentDigits.map((digit, index) => (
                <span
                  key={`${index}-${digit}`}
                  className={
                    index === recentDigits.length - 1
                      ? styles.latestDigit
                      : ""
                  }
                >
                  {digit}
                </span>
              ))
            ) : (
              <small>Waiting for shared live ticks...</small>
            )}
          </div>

          {!compact ? (
            <div className={styles.quickButtons}>
              {analysis.candidates
                .slice(0, 4)
                .map((candidate) => (
                  <button
                    type="button"
                    key={candidate.label}
                    disabled={tradeBusy}
                    onClick={() =>
                      void executeCandidate(candidate)
                    }
                  >
                    BUY {candidate.label}
                  </button>
                ))}
            </div>
          ) : null}
        </div>

        <div className={styles.digitGrid}>
          {analysis.distribution.map((row) => (
            <div key={row.digit}>
              <small>D{row.digit}</small>
              <strong>
                {row.percent.toFixed(0)}%
              </strong>
            </div>
          ))}
        </div>
      </article>

      <div className={styles.analyticsRow}>
        {[
          ["momentum", percent(analysis.momentumStrength)],
          ["trend", analysis.direction],
          ["volatility", analysis.volatility],
          ["entropy", percent(analysis.entropy)],
          ["transition", percent(analysis.transition)],
          ["cycle", analysis.cycle],
          ["regime", analysis.regime],
          ["engine", running ? "RUNNING" : "READY"],
        ].map(([label, value]) => (
          <div className={styles.geminiMetric} key={label}>
            <label>{label}</label>
            <span>{value}</span>
          </div>
        ))}
      </div>

      <div className={styles.engineMessage}>
        <span>{engineMessage}</span>

        {compact ? (
          <button
            type="button"
            onClick={() =>
              navigate("/gemini-x-engine")
            }
          >
            OPEN FULL GEMINIX
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function GeminiXDashboardPanel({ data }) {
  return (
    <GeminiXContent
      data={data}
      compact
      showControls={false}
    />
  );
}

export default function GeminiXEngine() {
  const data = useDerivTicks();

  return (
    <GeminiXContent
      data={data}
      compact={false}
      showControls
    />
  );
}
