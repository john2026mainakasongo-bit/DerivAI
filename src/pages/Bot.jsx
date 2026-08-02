
import { useEffect, useMemo, useRef, useState } from "react";

import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { useDerivAuth } from "../auth/DerivAuthContext";
import derivPublicClient from "../services/derivApi";

import { analyzeMarket } from "../analysis/analysisEngine";
import { buildValidatedSignals } from "../analysis/backtestEngine";
import TurboAutoDigitBotEngine from "../bot/TurboAutoDigitBotEngine";

import "../styles/Bot.css";
import "../styles/TurboBot.css";

const INITIAL_SETTINGS = {
  contractMode: "AUTO",
  predictionMode: "AUTO",
  prediction: 2,
  stake: 0.35,
  duration: 1,
  maxRuns: 10,
  unlimited: false,
  stopProfit: 0,
  stopLoss: 0,
  minimumConfidence: 75,
  confirmationUpdates: 3,
  lossCooldownMs: 6000,
  sameSetupBlockMs: 15000,
  maximumSignalAgeMs: 2000,
  lossSkipSignals: 3,
};

const INITIAL_STATE = {
  status: "STOPPED",
  message: "Turbo Auto Digit Bot is ready.",
  runs: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  totalStake: 0,
  activeSetup: "—",
  activeContractId: "",
  selectedConfidence: 0,
  selectedSource: "—",
  selectedQuality: 0,
  signalConfirmations: 0,
  skipSignalsRemaining: 0,
  executionPhase: "IDLE",
  debugSteps: [],
  marketSwitches: 0,
  history: [],
};

function accountId(account) {
  return String(
    account?.id ||
      account?.account_id ||
      account?.loginid ||
      account?.login_id ||
      ""
  );
}

function supportedSetup(value) {
  return /^(?:(?:OVER|UNDER|MATCH(?:ES)?|DIFFERS?)\s+[0-9]|EVEN|ODD)$/i.test(
    String(value || "").trim()
  );
}

function normalizeSetup(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^MATCHES\s+/, "MATCH ")
    .replace(/^DIFFER\s+/, "DIFFERS ");
}

function setupConfidence(item = {}) {
  return Number(
    item.lowerBound ??
      item.confidence ??
      item.probability ??
      0
  );
}

function clamp(value, minimum = 0, maximum = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.min(maximum, number));
}

function entropyQuality(analysis = {}) {
  const normalized = Number(analysis.entropy?.normalized || 0);
  return clamp((1 - normalized) * 100);
}

function transitionQuality(digits = [], mode, digit) {
  if (!Array.isArray(digits) || digits.length < 12) return 50;

  let total = 0;
  let wins = 0;

  for (let index = 1; index < digits.length; index += 1) {
    const value = Number(digits[index]);
    if (!Number.isInteger(value)) continue;

    total += 1;

    if (mode === "OVER" && value > digit) wins += 1;
    if (mode === "UNDER" && value < digit) wins += 1;
    if (mode === "MATCH" && value === digit) wins += 1;
    if (mode === "DIFFERS" && value !== digit) wins += 1;
    if (mode === "EVEN" && value % 2 === 0) wins += 1;
    if (mode === "ODD" && value % 2 === 1) wins += 1;
  }

  return total ? clamp((wins / total) * 100) : 50;
}

function candidateProbability(distribution = [], mode, digit) {
  const rows = Array.isArray(distribution) ? distribution : [];
  const percentage = (target) =>
    Number(rows.find((item) => Number(item.digit) === target)?.percent || 0);

  if (mode === "MATCH") return clamp(percentage(digit));
  if (mode === "DIFFERS") return clamp(100 - percentage(digit));
  if (mode === "EVEN") {
    return clamp([0, 2, 4, 6, 8].reduce((sum, value) => sum + percentage(value), 0));
  }
  if (mode === "ODD") {
    return clamp([1, 3, 5, 7, 9].reduce((sum, value) => sum + percentage(value), 0));
  }

  let total = 0;

  for (let value = 0; value <= 9; value += 1) {
    if (mode === "OVER" && value > digit) total += percentage(value);
    if (mode === "UNDER" && value < digit) total += percentage(value);
  }

  return clamp(total);
}

function buildRankedCandidates(analysis = {}, validated = {}, digitHistory = []) {
  const rows = Array.isArray(analysis.distribution)
    ? analysis.distribution
    : [];

  if (rows.length !== 10) return [];

  const entropy = entropyQuality(analysis);
  const momentum = clamp(
    50 + Math.abs(Number(analysis.momentum?.percent || 0)) * 3
  );
  const validatedSetup =
    validated?.best?.approved && supportedSetup(validated.best.action)
      ? normalizeSetup(validated.best.action)
      : "";

  const candidates = [];

  const definitions = [
    ...[1, 2, 3, 4, 5, 6].map((digit) => ({ mode: "OVER", digit })),
    ...[3, 4, 5, 6, 7, 8].map((digit) => ({ mode: "UNDER", digit })),
    { mode: "EVEN", digit: null },
    { mode: "ODD", digit: null },
    ...Array.from({ length: 10 }, (_, digit) => ({ mode: "MATCH", digit })),
    ...Array.from({ length: 10 }, (_, digit) => ({ mode: "DIFFERS", digit })),
  ];

  for (const definition of definitions) {
    const { mode, digit } = definition;
    const setup =
      mode === "EVEN" || mode === "ODD"
        ? mode
        : mode === "MATCH"
          ? `MATCH ${digit}`
          : `${mode} ${digit}`;

    const probability = candidateProbability(rows, mode, digit);
    const transition = transitionQuality(digitHistory, mode, digit);
    const frequency = probability;
    const validationBonus =
      normalizeSetup(setup) === validatedSetup ? 8 : 0;
    const familyPenalty = mode === "MATCH" ? 14 : 0;

    const qualityScore = clamp(
      probability * 0.4 +
        transition * 0.2 +
        frequency * 0.15 +
        entropy * 0.15 +
        momentum * 0.1 +
        validationBonus -
        familyPenalty
    );

    candidates.push({
      setup,
      mode,
      digit,
      probability,
      confidence: qualityScore,
      qualityScore,
      transition,
      frequency,
      entropy,
      momentum,
      source:
        validationBonus > 0
          ? "BACKTEST VALIDATED"
          : "DYNAMIC ALL-CONTRACT ANALYSIS",
      detail:
        `${setup}: probability ${probability.toFixed(1)}%, ` +
        `transition ${transition.toFixed(1)}%, entropy quality ` +
        `${entropy.toFixed(1)}%.`,
    });
  }

  return candidates
    .filter((candidate) => candidate.probability >= 55)
    .sort(
      (left, right) =>
        right.qualityScore - left.qualityScore ||
        right.probability - left.probability
    );
}

function qualityLabel(score) {
  const value = Number(score || 0);
  if (value >= 88) return { stars: "★★★★★", label: "Excellent" };
  if (value >= 80) return { stars: "★★★★☆", label: "Good" };
  if (value >= 72) return { stars: "★★★☆☆", label: "Average" };
  return { stars: "★★☆☆☆", label: "Weak" };
}

function signalReason(candidate = {}) {
  const metrics = [
    ["Probability", candidate.probability],
    ["Transition", candidate.transition],
    ["Frequency", candidate.frequency],
    ["Entropy quality", candidate.entropy],
    ["Momentum", candidate.momentum],
  ].sort((left, right) => Number(right[1]) - Number(left[1]));

  return metrics
    .slice(0, 3)
    .map(([label]) => label)
    .join(" · ");
}

function statusLabel(status) {
  const value = String(status || "STOPPED").toUpperCase();

  if (value === "BUYING") return "BUYING";
  if (value === "MONITORING") return "TRADE OPEN";
  if (value === "SCANNING") return "SCANNING";
  if (value === "RUNNING") return "RUNNING";
  if (value === "COMPLETED") return "COMPLETED";
  if (value === "ERROR") return "ERROR";
  return value;
}

function Metric({ label, value }) {
  return (
    <div className="turboMetric">
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

export default function Bot() {
  const auth = useDerivAuth();
  const engineRef = useRef(null);
  const marketContextRef = useRef({
    markets: [],
    symbol: "",
    changeSymbol: null,
  });

  const [settings, setSettings] = useState(INITIAL_SETTINGS);
  const [botState, setBotState] = useState(INITIAL_STATE);
  const [realRiskAccepted, setRealRiskAccepted] = useState(false);

  const {
    markets,
    market,
    symbol,
    status,
    statusDetail,
    connected,
    loadingMarket,
    prices,
    currentPrice,
    lastDigit,
    digitHistory,
    connect,
    disconnect,
    changeSymbol,
  } = useDerivTicks();

  const selectedId = accountId(auth.selectedAccount);
  const isDemo = auth.selectedAccountType === "demo";

  const snapshot = useMemo(
    () => ({
      prices,
      currentPrice,
      lastDigit,
      digitHistory,
    }),
    [prices, currentPrice, lastDigit, digitHistory]
  );

  const analysis = useMemo(
    () => analyzeMarket(snapshot),
    [snapshot]
  );

  const validated = useMemo(
    () => buildValidatedSignals(snapshot),
    [snapshot]
  );

  const rankedCandidates = useMemo(
    () =>
      buildRankedCandidates(
        analysis,
        validated,
        digitHistory
      ),
    [analysis, validated, digitHistory]
  );

  const autoSignal = rankedCandidates[0] || null;
  const topCandidates = rankedCandidates.slice(0, 4);
  const quality = qualityLabel(autoSignal?.qualityScore);

  const running = [
    "RUNNING",
    "SCANNING",
    "BUYING",
    "MONITORING",
    "WON",
    "LOST",
    "COOLDOWN",
    "SWITCHING",
  ].includes(botState.status);

  const connecting =
    status === "CONNECTING" || loadingMarket;

  const winRate =
    botState.runs > 0
      ? ((botState.wins / botState.runs) * 100).toFixed(1)
      : "0.0";

  useEffect(() => {
    const changed = derivPublicClient.configureAccount({
      accessToken: auth.session?.accessToken || "",
      appId: auth.config?.clientId || "",
      accountId: selectedId,
    });

    if (changed && connected) {
      void derivPublicClient.reconnect();
    }
  }, [
    auth.session?.accessToken,
    auth.config?.clientId,
    selectedId,
    connected,
  ]);

  useEffect(() => {
    marketContextRef.current = {
      markets: Array.isArray(markets) ? markets : [],
      symbol,
      changeSymbol,
    };
  }, [markets, symbol, changeSymbol]);

  useEffect(() => {
    const engine = new TurboAutoDigitBotEngine({
      client: derivPublicClient,
      onState: setBotState,
      onRequestMarketSwitch: async () => {
        const context = marketContextRef.current;
        const list = Array.isArray(context.markets)
          ? context.markets.filter((item) => item?.symbol)
          : [];

        if (list.length < 2 || typeof context.changeSymbol !== "function") {
          return {
            symbol: context.symbol,
            label: "current market",
          };
        }

        const currentIndex = list.findIndex(
          (item) => item.symbol === context.symbol
        );
        const nextIndex =
          currentIndex >= 0
            ? (currentIndex + 1) % list.length
            : 0;
        const next = list[nextIndex];

        await context.changeSymbol(next.symbol);

        return {
          symbol: next.symbol,
          label: next.label || next.symbol,
        };
      },
    });

    engineRef.current = engine;

    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.configure(settings);
  }, [settings]);

  useEffect(() => {
    engineRef.current?.setMarket({
      symbol,
      currency: auth.selectedAccount?.currency || "USD",
    });
    engineRef.current?.setAccountType(
      auth.selectedAccountType || "demo"
    );
  }, [
    symbol,
    auth.selectedAccount?.currency,
    auth.selectedAccountType,
  ]);

  useEffect(() => {
    engineRef.current?.updateSignal(autoSignal);
  }, [autoSignal]);

  function updateNumber(key) {
    return (event) => {
      const value = Number(event.target.value);

      setSettings((current) => ({
        ...current,
        [key]: Number.isFinite(value) ? value : current[key],
      }));
    };
  }

  async function startBot() {
    if (!auth.authenticated) {
      auth.login();
      return;
    }

    if (!isDemo && !realRiskAccepted) {
      window.alert(
        "Confirm the Real Account risk checkbox before starting. Real trades can lose money."
      );
      return;
    }

    try {
      if (!connected) {
        await connect();
      }

      await engineRef.current?.start();
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Unable to start the bot."
      );
    }
  }

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent">
        <Topbar
          title="EdgePilot V56 · Fresh Market Every Trade"
          subtitle="Fresh analysis after every trade: Over 1–6, Under 3–8, Even, Odd, Match and Differs"
          connected={connected}
          connecting={connecting}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section className="botToolbar">
          <MarketSelector
            markets={markets}
            value={symbol}
            disabled={loadingMarket || running}
            onChange={changeSymbol}
          />

          <div className={isDemo ? "botDemoLock safe" : "botDemoLock real"}>
            {isDemo
              ? "✓ DEMO EXECUTION"
              : `⚠ REAL ACTIVE · ${selectedId || "SELECTED"}`}
          </div>
        </section>

        {statusDetail ? (
          <div className="connectionError">{statusDetail}</div>
        ) : null}

        <section className="turboStatusHero">
          <div>
            <small>BOT STATUS</small>
            <strong>{statusLabel(botState.status)}</strong>
            <p>{botState.message}</p>
          </div>

          <div className={`turboStatusOrb ${botState.status.toLowerCase()}`}>
            {running ? "●" : "■"}
          </div>
        </section>

        <section className="turboLayout">
          <article className="botCard turboControlCard">
            <div className="botCardHeader">
              <div>
                <small>BOT CONFIGURATION</small>
                <h2>Auto digit execution</h2>
              </div>

              <span className={`botStatus ${botState.status.toLowerCase()}`}>
                {statusLabel(botState.status)}
              </span>
            </div>

            <div className="turboFormGrid">
              <label className="botField">
                <span>Contract</span>
                <select
                  value={settings.contractMode}
                  disabled={running}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      contractMode: event.target.value,
                    }))
                  }
                >
                  <option value="AUTO">AUTO — Best contract</option>
                  <option value="OVER">Over</option>
                  <option value="UNDER">Under</option>
                  <option value="MATCH">Matches</option>
                  <option value="DIFFERS">Differs</option>
                  <option value="EVEN">Even</option>
                  <option value="ODD">Odd</option>
                </select>
              </label>

              <label className="botField">
                <span>Prediction digit</span>
                <select
                  value={settings.predictionMode}
                  disabled={running}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      predictionMode: event.target.value,
                    }))
                  }
                >
                  <option value="AUTO">AUTO — Signal digit</option>
                  <option value="MANUAL">Manual digit</option>
                </select>
              </label>

              <label className="botField">
                <span>Manual digit</span>
                <select
                  value={settings.prediction}
                  disabled={
                    running ||
                    settings.predictionMode === "AUTO" ||
                    settings.contractMode === "EVEN" ||
                    settings.contractMode === "ODD"
                  }
                  onChange={updateNumber("prediction")}
                >
                  {Array.from({ length: 10 }, (_, digit) => (
                    <option value={digit} key={digit}>
                      {digit}
                    </option>
                  ))}
                </select>
              </label>

              <label className="botField">
                <span>Stake</span>
                <input
                  type="number"
                  min="0.35"
                  step="0.01"
                  value={settings.stake}
                  disabled={running}
                  onChange={updateNumber("stake")}
                />
              </label>

              <label className="botField">
                <span>Duration (ticks)</span>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={settings.duration}
                  disabled={running}
                  onChange={updateNumber("duration")}
                />
              </label>

              <label className="botField">
                <span>Maximum runs</span>
                <input
                  type="number"
                  min="1"
                  max="1000"
                  value={settings.maxRuns}
                  disabled={running || settings.unlimited}
                  onChange={updateNumber("maxRuns")}
                />
              </label>

              <label className="botField">
                <span>Stop after profit</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={settings.stopProfit}
                  disabled={running}
                  onChange={updateNumber("stopProfit")}
                />
              </label>

              <label className="botField">
                <span>Stop after loss</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={settings.stopLoss}
                  disabled={running}
                  onChange={updateNumber("stopLoss")}
                />
              </label>

              <label className="botField">
                <span>Minimum confidence</span>
                <input
                  type="number"
                  min="50"
                  max="99"
                  step="1"
                  value={settings.minimumConfidence}
                  disabled={running}
                  onChange={updateNumber("minimumConfidence")}
                />
              </label>

              <label className="botField">
                <span>Signal confirmations</span>
                <input
                  type="number"
                  min="1"
                  max="10"
                  step="1"
                  value={settings.confirmationUpdates}
                  disabled={running}
                  onChange={updateNumber("confirmationUpdates")}
                />
              </label>

              <label className="botField">
                <span>Signal age limit (ms)</span>
                <input
                  type="number"
                  min="500"
                  max="10000"
                  step="100"
                  value={settings.maximumSignalAgeMs}
                  disabled={running}
                  onChange={updateNumber("maximumSignalAgeMs")}
                />
              </label>

              <label className="botField">
                <span>Skip signals after loss</span>
                <input
                  type="number"
                  min="0"
                  max="20"
                  step="1"
                  value={settings.lossSkipSignals}
                  disabled={running}
                  onChange={updateNumber("lossSkipSignals")}
                />
              </label>
            </div>

            <label className="turboUnlimited">
              <input
                type="checkbox"
                checked={settings.unlimited}
                disabled={running || !isDemo}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    unlimited: event.target.checked,
                  }))
                }
              />
              <span>
                Unlimited runs until Stop, profit target or loss limit
                {!isDemo ? " (disabled on Real)" : ""}
              </span>
            </label>

            {!isDemo ? (
              <label className="v54RealRisk">
                <input
                  type="checkbox"
                  checked={realRiskAccepted}
                  disabled={running}
                  onChange={(event) =>
                    setRealRiskAccepted(event.target.checked)
                  }
                />
                <span>
                  I understand Real trades can lose money. Real stake is capped
                  at 0.35 USD and the bot stops after one loss.
                </span>
              </label>
            ) : null}

            <div className="turboSignalStrip">
              <div>
                <small>CURRENT BEST</small>
                <strong>{autoSignal?.setup || "WAIT"}</strong>
              </div>
              <div>
                <small>QUALITY</small>
                <strong>{Number(autoSignal?.qualityScore || 0).toFixed(1)}</strong>
              </div>
              <div>
                <small>RATING</small>
                <strong>{quality.stars} {quality.label}</strong>
              </div>
              <div>
                <small>CONFIRMS</small>
                <strong>
                  {Math.min(
                    settings.confirmationUpdates,
                    botState.signalConfirmations || 0
                  )}/{settings.confirmationUpdates}
                </strong>
              </div>
            </div>

            <div className="v55Families">
              <span>OVER 1–6</span>
              <span>UNDER 3–8</span>
              <span>EVEN / ODD</span>
              <span>MATCH / DIFFERS</span>
            </div>

            <div className="v56SwitchNotice">
              <strong>FRESH MARKET MODE</strong>
              <span>
                Every settled trade — WIN or LOSS — clears the old signal,
                switches to the next volatility market, collects fresh ticks,
                and ranks OVER, UNDER, EVEN, ODD, MATCH and DIFFERS again.
              </span>
            </div>

            <div className="v53Recommendation">
              <div>
                <small>AI RECOMMENDATION</small>
                <h3>{autoSignal?.setup || "WAIT"}</h3>
                <p>
                  {autoSignal
                    ? signalReason(autoSignal)
                    : "Collecting live digit evidence."}
                </p>
              </div>

              <div className="v53Expected">
                <span>
                  <small>Probability</small>
                  <strong>{Number(autoSignal?.probability || 0).toFixed(1)}%</strong>
                </span>
                <span>
                  <small>Quality score</small>
                  <strong>{Number(autoSignal?.qualityScore || 0).toFixed(1)}</strong>
                </span>
                <span>
                  <small>Freshness</small>
                  <strong>≤ {settings.maximumSignalAgeMs / 1000}s</strong>
                </span>
              </div>
            </div>

            <div className="v53Ranking">
              <div className="v53RankingHeader">
                <strong>Live contract ranking</strong>
                <span>Updates with every tick</span>
              </div>

              {topCandidates.map((candidate, index) => (
                <div className="v53RankRow" key={candidate.setup}>
                  <span>#{index + 1}</span>
                  <strong>{candidate.setup}</strong>
                  <em>{candidate.qualityScore.toFixed(1)}</em>
                  <small>{candidate.probability.toFixed(1)}% probability</small>
                </div>
              ))}
            </div>

            <div className="v54DebugPanel">
              <div className="v54DebugHeader">
                <strong>Execution flow</strong>
                <span>{botState.executionPhase || "IDLE"}</span>
              </div>

              <div className="v54DebugSteps">
                {(botState.debugSteps || []).length ? (
                  botState.debugSteps.slice(0, 7).map((step) => (
                    <div key={step.id}>
                      <strong>{step.step}</strong>
                      <span>{step.detail || "—"}</span>
                    </div>
                  ))
                ) : (
                  <p>START → SCAN → CONFIRM → BUY SENT → SETTLED → NEXT SCAN</p>
                )}
              </div>
            </div>

            <div className="botActions turboActions">
              {!running ? (
                <button
                  className="botStartButton turboStart"
                  onClick={startBot}
                >
                  ▶ START BOT
                </button>
              ) : (
                <button
                  className="botStopButton turboStop"
                  onClick={() => engineRef.current?.stop()}
                >
                  ■ STOP BOT
                </button>
              )}

              <button
                className="botSecondaryButton"
                disabled={running}
                onClick={() => engineRef.current?.reset()}
              >
                Reset Stats
              </button>
            </div>

            <p className="botSafetyText">
              V55 analyzes Over 1–6, Under 3–8, Even, Odd, Match and Differs on
              every fresh tick. A previous win never forces the next contract: after
              settlement the signal is cleared and all families are ranked again.
              Real mode stays capped at 0.35 USD and stops after one loss.
            </p>
          </article>

          <article className="botCard turboPerformanceCard">
            <div className="botCardHeader">
              <div>
                <small>LIVE PERFORMANCE</small>
                <h2>
                  {settings.unlimited
                    ? `Run ${botState.runs}`
                    : `Run ${botState.runs}/${settings.maxRuns}`}
                </h2>
              </div>

              <span>{market?.label || symbol}</span>
            </div>

            <div className="turboMetrics">
              <Metric label="Runs" value={botState.runs} />
              <Metric label="Wins" value={botState.wins} />
              <Metric label="Losses" value={botState.losses} />
              <Metric label="Win rate" value={`${winRate}%`} />
              <Metric
                label="Profit"
                value={`${botState.profit >= 0 ? "+" : ""}${botState.profit.toFixed(2)} USD`}
              />
              <Metric
                label="Current contract"
                value={botState.activeSetup}
              />
              <Metric
                label="Market switches"
                value={botState.marketSwitches || 0}
              />
            </div>

            <div className="turboHistoryWrap">
              <table className="turboHistoryTable">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Contract</th>
                    <th>Stake</th>
                    <th>Result</th>
                    <th>Profit</th>
                    <th>Quality</th>
                    <th>ID</th>
                  </tr>
                </thead>

                <tbody>
                  {botState.history.length ? (
                    botState.history.map((item) => (
                      <tr key={item.id}>
                        <td>
                          {new Date(item.time).toLocaleTimeString()}
                        </td>
                        <td>{item.setup}</td>
                        <td>{item.stake.toFixed(2)}</td>
                        <td>
                          <strong
                            className={
                              item.result === "WIN"
                                ? "turboWin"
                                : "turboLoss"
                            }
                          >
                            {item.result}
                          </strong>
                        </td>
                        <td>
                          {item.profit >= 0 ? "+" : ""}
                          {item.profit.toFixed(2)}
                        </td>
                        <td>{Number(item.confidence || 0).toFixed(1)}</td>
                        <td>{item.contractId}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="7" className="turboEmpty">
                        No completed trades yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </article>
        </section>
      </main>
    </div>
  );
}
