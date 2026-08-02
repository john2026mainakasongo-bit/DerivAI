
import { useEffect, useMemo, useRef, useState } from "react";

import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { useDerivAuth } from "../auth/DerivAuthContext";
import derivPublicClient from "../services/derivApi";

import { rankV66FastProfessional } from "../analysis/v66FastProfessionalEngine";
import { analyzeRiseFall } from "../analysis/v67UnifiedAnalysisEngine";
import TurboAutoDigitBotEngine from "../bot/TurboAutoDigitBotEngine";

import "../styles/Bot.css";
import "../styles/TurboBot.css";

const INITIAL_SETTINGS = {
  contractMode: "AUTO",
  predictionMode: "AUTO",
  prediction: 2,
  stake: 0.35,
  duration: 1,
  maxRuns: 5,
  unlimited: false,
  stopProfit: 0,
  stopLoss: 0,
  minimumConfidence: 82,
  confirmationUpdates: 2,
  lossCooldownMs: 6000,
  sameSetupBlockMs: 15000,
  maximumSignalAgeMs: 2000,
  lossSkipSignals: 3,
  allowHighRiskContracts: false,
  highRiskMinimumQuality: 90,
  highRiskMinimumSamples: 220,
  highRiskMinimumEdge: 12,
  scanSwitchMs: 3500,
  postTradeDelayMs: 80,
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
  entryCountdown: 0,
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

function qualityLabel(score) {
  const value = Number(score || 0);
  if (value >= 88) return { stars: "★★★★★", label: "Excellent" };
  if (value >= 80) return { stars: "★★★★☆", label: "Good" };
  if (value >= 72) return { stars: "★★★☆☆", label: "Average" };
  return { stars: "★★☆☆☆", label: "Weak" };
}

function signalReason(candidate = {}) {
  if (!candidate?.setup) {
    return "Collecting fresh multi-window evidence.";
  }

  return (
    `EV ${Number(candidate.expectedValue || 0) >= 0 ? "+" : ""}` +
    `${Number(candidate.expectedValue || 0).toFixed(1)}% · ` +
    `consistency ${Number(candidate.consistency || 0).toFixed(1)}% · ` +
    `${Number(candidate.sampleSize || 0)} ticks`
  );
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
  const [botType, setBotType] = useState("DIGIT");
  const [riseFallState, setRiseFallState] = useState({
    running: false,
    status: "STOPPED",
    message: "Rise/Fall Bot is ready.",
    runs: 0,
    wins: 0,
    losses: 0,
    profit: 0,
    history: [],
  });
  const riseFallStopRef = useRef(false);
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
    placeTrade,
  } = useDerivTicks();

  const selectedId = accountId(auth.selectedAccount);
  const isDemo = auth.selectedAccountType === "demo";

  const v66Analysis = useMemo(
    () =>
      rankV66FastProfessional({
        digitHistory,
        allowHighRisk: settings.allowHighRiskContracts,
        minimumConfidence: settings.minimumConfidence,
      }),
    [
      digitHistory,
      settings.allowHighRiskContracts,
      settings.minimumConfidence,
    ]
  );

  const rankedCandidates = v66Analysis.candidates || [];
  const executableCandidates = rankedCandidates.filter(
    (candidate) => candidate.executable
  );
  const autoSignal = v66Analysis.best || null;
  const topCandidates = rankedCandidates.slice(0, 6);
  const familyLeaders = ["OVER", "UNDER", "EVEN", "ODD", "MATCH", "DIFFERS"]
    .map((mode) =>
      rankedCandidates.find(
        (candidate) => candidate.mode === mode
      )
    )
    .filter(Boolean);
  const riseFallAnalysis = useMemo(
    () =>
      analyzeRiseFall({
        prices,
        currentPrice,
      }),
    [prices, currentPrice]
  );

  const quality = qualityLabel(autoSignal?.qualityScore);

  const digitRunning = [
    "RUNNING",
    "SCANNING",
    "BUYING",
    "MONITORING",
    "WON",
    "LOST",
    "COOLDOWN",
    "SWITCHING",
  ].includes(botState.status);

  const running =
    botType === "DIGIT"
      ? digitRunning
      : riseFallState.running;

  const connecting =
    status === "CONNECTING" || loadingMarket;

  const winRate =
    botState.runs > 0
      ? ((botState.wins / botState.runs) * 100).toFixed(1)
      : "0.0";

  useEffect(() => {
    if (
      auth.authenticated &&
      !connected &&
      !connecting
    ) {
      void connect();
    }
  }, [
    auth.authenticated,
    connected,
    connecting,
    connect,
  ]);

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
    engineRef.current?.updateSignal(
      autoSignal
        ? {
            ...autoSignal,
            confidence: autoSignal.qualityScore,
            qualityScore: autoSignal.qualityScore,
          }
        : null
    );
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


  async function startRiseFallBot() {
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

    if (!connected) {
      await connect();
    }

    riseFallStopRef.current = false;
    setRiseFallState((current) => ({
      ...current,
      running: true,
      status: "SCANNING",
      message: "Scanning Rise/Fall trend, momentum and entry level.",
    }));

    let runs = 0;
    let wins = 0;
    let losses = 0;
    let profit = 0;
    const history = [];

    while (
      !riseFallStopRef.current &&
      (settings.unlimited || runs < settings.maxRuns)
    ) {
      const signal = riseFallAnalysis;

      if (
        signal.risk !== "GOOD ENTRY" ||
        signal.signal === "WAIT"
      ) {
        setRiseFallState((current) => ({
          ...current,
          status: "SCANNING",
          message:
            signal.instruction ||
            "Waiting for aligned Rise/Fall evidence.",
        }));
        await new Promise((resolve) => setTimeout(resolve, 350));
        continue;
      }

      setRiseFallState((current) => ({
        ...current,
        status: "BUYING",
        message: `${signal.signal} validated. Opening trade.`,
      }));

      try {
        const result = await placeTrade({
          symbol,
          contractType: signal.signal === "RISE" ? "CALL" : "PUT",
          amount: Math.max(
            0.35,
            Number(settings.stake) || 0.35
          ),
          basis: "stake",
          duration: Math.max(
            1,
            Math.min(
              10,
              Number(settings.duration) || signal.duration || 5
            )
          ),
          durationUnit: "t",
        });

        const contractId =
          result?.contractId ||
          result?.contract_id ||
          "opened";

        runs += 1;

        history.unshift({
          id: `${Date.now()}-${runs}`,
          time: Date.now(),
          setup: signal.signal,
          stake: Math.max(
            0.35,
            Number(settings.stake) || 0.35
          ),
          result: "OPEN",
          profit: 0,
          confidence: signal.confidence,
          contractId,
        });

        setRiseFallState({
          running: !riseFallStopRef.current,
          status: "MONITORING",
          message:
            `${signal.signal} contract ${contractId} opened. ` +
            "Waiting before the next scan.",
          runs,
          wins,
          losses,
          profit,
          history: [...history],
        });

        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(900, Number(settings.postTradeDelayMs) || 900))
        );
      } catch (error) {
        riseFallStopRef.current = true;
        setRiseFallState((current) => ({
          ...current,
          running: false,
          status: "ERROR",
          message:
            error instanceof Error
              ? error.message
              : "Rise/Fall trade failed.",
        }));
      }
    }

    if (!riseFallStopRef.current) {
      setRiseFallState((current) => ({
        ...current,
        running: false,
        status: "COMPLETED",
        message: "Maximum Rise/Fall runs completed.",
      }));
    }
  }

  function stopRiseFallBot() {
    riseFallStopRef.current = true;
    setRiseFallState((current) => ({
      ...current,
      running: false,
      status: "STOPPED",
      message: "Rise/Fall Bot stopped.",
    }));
  }


  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent">
        <Topbar
          title="EdgePilot V67 · Multi-Bot Trading Engine"
          subtitle="Choose Fast Digit Bot or Rise/Fall Auto Bot with unified live analysis"
          connected={auth.authenticated || connected}
          connecting={!auth.authenticated && connecting}
          onConnect={auth.authenticated ? undefined : connect}
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

        <section className="v67BotSelector">
          <button
            className={botType === "DIGIT" ? "active" : ""}
            disabled={running}
            onClick={() => setBotType("DIGIT")}
          >
            Fast Digit Bot
          </button>
          <button
            className={botType === "RISE_FALL" ? "active" : ""}
            disabled={running}
            onClick={() => setBotType("RISE_FALL")}
          >
            Rise / Fall Bot
          </button>
        </section>

        {statusDetail ? (
          <div className="connectionError">{statusDetail}</div>
        ) : null}

        <section className="turboStatusHero">
          <div>
            <small>BOT STATUS</small>
            <strong>
              {botType === "DIGIT"
                ? statusLabel(botState.status)
                : statusLabel(riseFallState.status)}
            </strong>
            <p>
              {botType === "DIGIT"
                ? botState.message
                : riseFallState.message}
            </p>
          </div>

          <div
            className={`turboStatusOrb ${
              botType === "DIGIT"
                ? botState.status.toLowerCase()
                : riseFallState.status.toLowerCase()
            }`}
          >
            {running ? "●" : "■"}
          </div>
        </section>

        <section className="turboLayout">
          <article className="botCard turboControlCard">
            <div className="botCardHeader">
              <div>
                <small>BOT CONFIGURATION</small>
                <h2>
                  {botType === "DIGIT"
                    ? "Auto digit execution"
                    : "Auto Rise/Fall execution"}
                </h2>
              </div>

              <span className={`botStatus ${botState.status.toLowerCase()}`}>
                {statusLabel(botState.status)}
              </span>
            </div>

            {botType === "RISE_FALL" ? (
              <div className="v67RiseFallSummary">
                <div>
                  <small>SIGNAL</small>
                  <strong>{riseFallAnalysis.signal}</strong>
                </div>
                <div>
                  <small>RISK</small>
                  <strong>{riseFallAnalysis.risk}</strong>
                </div>
                <div>
                  <small>CONFIDENCE</small>
                  <strong>
                    {Number(riseFallAnalysis.confidence || 0).toFixed(1)}%
                  </strong>
                </div>
                <div>
                  <small>ENTRY</small>
                  <strong>
                    {Number.isFinite(riseFallAnalysis.entryPrice)
                      ? Number(riseFallAnalysis.entryPrice).toFixed(3)
                      : "WAIT"}
                  </strong>
                </div>
              </div>
            ) : null}

            <div className={botType === "DIGIT" ? "turboFormGrid" : "turboFormGrid riseFallMode"}>
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
                <span>Switch volatility after no setup (ms)</span>
                <input
                  type="number"
                  min="1000"
                  max="15000"
                  step="250"
                  value={settings.scanSwitchMs}
                  disabled={running}
                  onChange={updateNumber("scanSwitchMs")}
                />
              </label>

              <label className="botField">
                <span>Delay after trade (ms)</span>
                <input
                  type="number"
                  min="50"
                  max="3000"
                  step="50"
                  value={settings.postTradeDelayMs}
                  disabled={running}
                  onChange={updateNumber("postTradeDelayMs")}
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

              <label className="botField">
                <span>High-risk minimum quality</span>
                <input
                  type="number"
                  min="80"
                  max="99"
                  step="1"
                  value={settings.highRiskMinimumQuality}
                  disabled={running || !settings.allowHighRiskContracts}
                  onChange={updateNumber("highRiskMinimumQuality")}
                />
              </label>

              <label className="botField">
                <span>High-risk minimum samples</span>
                <input
                  type="number"
                  min="100"
                  max="1000"
                  step="10"
                  value={settings.highRiskMinimumSamples}
                  disabled={running || !settings.allowHighRiskContracts}
                  onChange={updateNumber("highRiskMinimumSamples")}
                />
              </label>
            </div>

            <label className="v58HighRiskToggle">
              <input
                type="checkbox"
                checked={settings.allowHighRiskContracts}
                disabled={running}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    allowHighRiskContracts: event.target.checked,
                  }))
                }
              />
              <span>
                Allow MATCH and DIFFERS execution. Off by default because these
                contracts have asymmetric payout/risk and require stricter evidence.
              </span>
            </label>

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

            <div className="v63ModeBanner">
              <strong>FAST STRICT MODE</strong>
              <span>
                Maximum runs defaults to 5. The bot rotates volatility after
                every completed trade, or after 2.5 seconds without a qualifying
                setup. It enters immediately after two fresh confirmations.
              </span>
            </div>

            <div className="v56SwitchNotice">
              <strong>FRESH MARKET MODE</strong>
              <span>
                V66 keeps the same 13-check structure but uses faster 20, 40,
                80 and 160-tick windows, a lighter Bayesian prior and a quick
                120-tick backtest. Standard entries require 9 of 13 checks.
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
                  <small>Consensus</small>
                  <strong>
                    {Number(autoSignal?.voteCount || 0)}/
                    {Number(autoSignal?.totalVotes || 10)}
                  </strong>
                </span>
                <span>
                  <small>Backtest</small>
                  <strong>
                    {Number(autoSignal?.backtestWinRate || 0).toFixed(1)}%
                  </strong>
                </span>
                <span>
                  <small>Expected value</small>
                  <strong>
                    {Number(autoSignal?.expectedValue || 0) >= 0 ? "+" : ""}
                    {Number(autoSignal?.expectedValue || 0).toFixed(1)}%
                  </strong>
                </span>
              </div>
            </div>

            <div className={autoSignal ? "v60Gate pass" : "v60Gate wait"}>
              <strong>{autoSignal ? "EXECUTE GATE PASSED" : "WAIT — NO CONTRACT PASSES"}</strong>
              <span>{v66Analysis.reason}</span>
            </div>

            <div className="v64AnalysisGrid v65">
              {[
                "20-Tick Probability",
                "50-Tick Probability",
                "100-Tick Probability",
                "200-Tick Probability",
                "Expected Value",
                "Probability Edge",
                "Markov Transition",
                "Window Agreement",
                "Stability",
                "Streak Behaviour",
                "Reversal Control",
                "Autocorrelation",
                "Walk-Forward Backtest",
              ].map((label, index) => (
                <div key={label}>
                  <span>{index + 1}</span>
                  <strong>{label}</strong>
                </div>
              ))}
            </div>

            <div className="v61ScoreModel">
              <div>
                <small>PRIMARY RANK</small>
                <strong>EV</strong>
              </div>
              <div>
                <small>SECOND</small>
                <strong>EDGE</strong>
              </div>
              <div>
                <small>THIRD</small>
                <strong>STABILITY</strong>
              </div>
              <div>
                <small>LIVE WINDOWS</small>
                <strong>30–240</strong>
              </div>
              <div>
                <small>FRESH UPDATE</small>
                <strong>EVERY TICK</strong>
              </div>
            </div>

            <div className="v57FamilyBoard">
              <div className="v53RankingHeader">
                <strong>Best candidate per contract family</strong>
                <span>No raw-probability bias</span>
              </div>

              <div className="v57FamilyGrid">
                {familyLeaders.map((candidate) => (
                  <div key={candidate.mode}>
                    <small>{candidate.mode}</small>
                    <strong>{candidate.setup}</strong>
                    <span>
                      Q {candidate.qualityScore.toFixed(1)} · EV
                      {" "}{candidate.expectedValue >= 0 ? "+" : ""}
                      {candidate.expectedValue.toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="v53Ranking">
              <div className="v53RankingHeader">
                <strong>Live contract ranking</strong>
                <span>Updates with every tick</span>
              </div>

              {topCandidates.map((candidate, index) => (
                <div
                  className={
                    candidate.highRisk
                      ? "v53RankRow highRisk"
                      : "v53RankRow"
                  }
                  key={candidate.setup}
                >
                  <span>#{index + 1}</span>
                  <strong>{candidate.setup}</strong>
                  <em>{candidate.qualityScore.toFixed(1)}</em>
                  <small>
                    {candidate.highRisk ? "HIGH RISK · " : ""}
                    EV {candidate.expectedValue >= 0 ? "+" : ""}
                    {candidate.expectedValue.toFixed(1)}% ·
                    Edge {candidate.probabilityEdge.toFixed(1)}% ·
                    Stability {candidate.consistency.toFixed(1)}%
                  </small>
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
                  onClick={
                    botType === "DIGIT"
                      ? startBot
                      : startRiseFallBot
                  }
                >
                  ▶ START {botType === "DIGIT" ? "DIGIT" : "RISE/FALL"} BOT
                </button>
              ) : (
                <button
                  className="botStopButton turboStop"
                  onClick={
                    botType === "DIGIT"
                      ? () => engineRef.current?.stop()
                      : stopRiseFallBot
                  }
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
                  {botType === "DIGIT"
                    ? settings.unlimited
                      ? `Run ${botState.runs}`
                      : `Run ${botState.runs}/${settings.maxRuns}`
                    : settings.unlimited
                      ? `Run ${riseFallState.runs}`
                      : `Run ${riseFallState.runs}/${settings.maxRuns}`}
                </h2>
              </div>

              <span>{market?.label || symbol}</span>
            </div>

            <div className="turboMetrics">
              {botType === "DIGIT" ? (
                <>
                  <Metric label="Runs" value={botState.runs} />
                  <Metric label="Wins" value={botState.wins} />
                  <Metric label="Losses" value={botState.losses} />
                  <Metric label="Win rate" value={`${winRate}%`} />
                  <Metric
                    label="Profit"
                    value={`${botState.profit >= 0 ? "+" : ""}${botState.profit.toFixed(2)} USD`}
                  />
                  <Metric label="Current contract" value={botState.activeSetup} />
                  <Metric label="Market switches" value={botState.marketSwitches || 0} />
                </>
              ) : (
                <>
                  <Metric label="Runs" value={riseFallState.runs} />
                  <Metric label="Signal" value={riseFallAnalysis.signal} />
                  <Metric label="Risk" value={riseFallAnalysis.risk} />
                  <Metric
                    label="Confidence"
                    value={`${Number(riseFallAnalysis.confidence || 0).toFixed(1)}%`}
                  />
                  <Metric label="Trend" value={riseFallAnalysis.trend} />
                  <Metric
                    label="Entry level"
                    value={
                      Number.isFinite(riseFallAnalysis.entryPrice)
                        ? Number(riseFallAnalysis.entryPrice).toFixed(3)
                        : "WAIT"
                    }
                  />
                </>
              )}
            </div>

            {botType === "RISE_FALL" ? (
              <div className="v67RiseFallInstruction">
                <strong>{riseFallAnalysis.signal}</strong>
                <p>{riseFallAnalysis.instruction}</p>
                <span>
                  Support {Number(riseFallAnalysis.support || 0).toFixed(3)} ·
                  Resistance {Number(riseFallAnalysis.resistance || 0).toFixed(3)}
                </span>
              </div>
            ) : null}

            {botType === "DIGIT" ? (
            <div className="turboHistoryWrap">
              <table className="turboHistoryTable">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Contract</th>
                    <th>Stake</th>
                    <th>Result</th>
                    <th>Profit</th>
                    <th>Evidence</th>
                    <th>EV</th>
                    <th>Stability</th>
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
                        <td>
                          {Number(item.expectedValue || 0) >= 0 ? "+" : ""}
                          {Number(item.expectedValue || 0).toFixed(1)}%
                        </td>
                        <td>{Number(item.consistency || 0).toFixed(1)}%</td>
                        <td>{item.contractId}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="9" className="turboEmpty">
                        No completed trades yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            ) : null}
          </article>
        </section>
      </main>
    </div>
  );
}
