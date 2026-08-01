import {
  cloneElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { useDerivAuth } from "../auth/DerivAuthContext";
import derivPublicClient from "../services/derivApi";

import { analyzeMarket } from "../analysis/analysisEngine";
import { buildValidatedSignals } from "../analysis/backtestEngine";
import { buildEntryTiming } from "../analysis/entryTimingEngine";
import { buildProfessionalDecision } from "../analysis/professionalDecisionEngine";
import { evaluateAnalysisAssistedSignal } from "../analysis/analysisAssistedGate";
import { analyzeSyntheticIntelligence } from "../analysis/syntheticIntelligenceEngine";

import DerivBotEngine from "../bot/DerivBotEngine";
import "../styles/Bot.css";

const INITIAL_SETTINGS = {
  maxRuns: 56,
  maxScanTicks: 36,
  stake: 1,
  duration: 5,
  minConfidence: 75,
  minVotes: 1,
  takeProfit: 20,
  stopLoss: 6,
  cooldownAfterLosses: 1,
  cooldownSeconds: 45,
  hardStopLossStreak: 3,
  delaySeconds: 5,
  martingaleEnabled: false,
  maxMartingaleSteps: 1,
  analysisAssisted: true,
  contractMode: "AUTO",
  prediction: 2,
  durationUnit: "t",
  autoSwitchVolatility: true,
  marketScanSeconds: 12,
  confirmationCount: 1,
  confirmationSeconds: 1,
  signalMaxAgeSeconds: 6,
  lossSetupBlockSeconds: 90,
  minimumTradeGapSeconds: 5,
  deepMinimumScore: 70,
  deepOverrideScore: 90,
};

const INITIAL_BOT_STATE = {
  status: "IDLE",
  message: "Bot is ready.",
  runs: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  totalStake: 0,
  totalPayout: 0,
  completedAt: 0,
  stopReason: "",
  consecutiveLosses: 0,
  lossesSinceWin: 0,
  cooldownUntil: 0,
  cooldownCount: 0,
  currentWinStreak: 0,
  largestWinStreak: 0,
  largestLossStreak: 0,
  martingaleStep: 0,
  currentStake: 1,
  activeSetup: "—",
  activeContractId: "",
  scanStartedAt: 0,
  scanElapsedSeconds: 0,
  scanTicks: 0,
  maxScanTicks: 36,
  scanWindow: 1,
  lastBlockReason: "",
  fallbackTrades: 0,
  signalConfirmations: 0,
  requiredConfirmations: 2,
  blockedSetupUntil: 0,
  lastLossSetup: "—",
  lossProtectionCount: 0,
  deepScore: 0,
  deepConsensus: 0,
  deepRegime: "UNKNOWN",
  cyclePeriod: 0,
  fastLane: false,
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

const DIGIT_CONTRACT_MODES = new Set([
  "EVEN",
  "ODD",
  "OVER",
  "UNDER",
  "MATCH",
  "DIFFERS",
]);

function isDigitContractMode(mode) {
  return DIGIT_CONTRACT_MODES.has(
    String(mode || "").toUpperCase()
  );
}

function needsPrediction(mode) {
  return ["OVER", "UNDER", "MATCH", "DIFFERS"].includes(
    String(mode || "").toUpperCase()
  );
}

function predictionOptions(mode) {
  const value = String(mode || "").toUpperCase();

  if (value === "OVER") {
    return Array.from({ length: 9 }, (_, index) => index);
  }

  if (value === "UNDER") {
    return Array.from({ length: 9 }, (_, index) => index + 1);
  }

  return Array.from({ length: 10 }, (_, index) => index);
}

function contractModeLabel(mode, prediction) {
  const value = String(mode || "AUTO").toUpperCase();

  if (value === "AUTO") {
    return "AUTO BEST";
  }

  return needsPrediction(value)
    ? `${value} ${prediction}`
    : value;
}

function setupForTest(settings, analysisGate) {
  if (analysisGate?.approved && analysisGate?.setup) {
    return analysisGate.setup;
  }

  const mode = String(settings.contractMode || "AUTO").toUpperCase();
  const prediction = Number(settings.prediction || 0);

  if (mode === "AUTO") {
    return settings.durationUnit === "s" ? "RISE" : "OVER 2";
  }

  return needsPrediction(mode) ? `${mode} ${prediction}` : mode;
}

function Field({ label, children }) {
  const generatedId = useId();
  const fieldId =
    children?.props?.id ||
    `bot-field-${String(generatedId).replace(/:/g, "")}`;

  const field = cloneElement(children, {
    id: fieldId,
    name: children?.props?.name || fieldId,
  });

  return (
    <label className="botField" htmlFor={fieldId}>
      <span>{label}</span>
      {field}
    </label>
  );
}

function Metric({ label, value }) {
  return (
    <div className="botMetric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default function Bot() {
  const auth = useDerivAuth();
  const engineRef = useRef(null);
  const marketSwitchingRef = useRef(false);
  const marketScanStartedRef = useRef(Date.now());

  const [marketSwitchState, setMarketSwitchState] = useState({
    remaining: 0,
    switches: 0,
    lastMarket: "",
  });

  const [settings, setSettings] =
    useState(INITIAL_SETTINGS);

  useEffect(() => {
    setSettings((current) => {
      const safeTarget = Math.max(
        24,
        Math.min(120, Number(current.maxScanTicks || 36))
      );

      return safeTarget === Number(current.maxScanTicks)
        ? current
        : { ...current, maxScanTicks: safeTarget };
    });
  }, []);

  const [botState, setBotState] =
    useState(INITIAL_BOT_STATE);

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

  const selectedId = accountId(
    auth.selectedAccount
  );

  const isDemo =
    auth.selectedAccountType === "demo";

  useEffect(() => {
    const changed =
      derivPublicClient.configureAccount({
        accessToken:
          auth.session?.accessToken || "",
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
    const engine = new DerivBotEngine({
      client: derivPublicClient,
      onState: setBotState,
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
    engineRef.current?.setAccountMode({
      isDemo,
    });
  }, [isDemo]);

  useEffect(() => {
    engineRef.current?.setMarket({
      symbol,
      currency:
        auth.selectedAccount?.currency ||
        "USD",
    });
  }, [
    symbol,
    auth.selectedAccount?.currency,
  ]);

  const snapshot = useMemo(
    () => ({
      prices,
      currentPrice,
      lastDigit,
      digitHistory,
    }),
    [
      prices,
      currentPrice,
      lastDigit,
      digitHistory,
    ]
  );

  const validatedSignals = useMemo(
    () => buildValidatedSignals(snapshot),
    [snapshot]
  );

  const entryTiming = useMemo(
    () =>
      buildEntryTiming(
        validatedSignals,
        snapshot,
        {
          tradeTicks:
            settings.durationUnit === "t"
              ? settings.duration
              : 5,
          validitySeconds: 15,
        }
      ),
    [
      validatedSignals,
      snapshot,
      settings.duration,
      settings.durationUnit,
    ]
  );

  const professionalDecision = useMemo(
    () =>
      buildProfessionalDecision(
        snapshot,
        validatedSignals
      ),
    [snapshot, validatedSignals]
  );

  const analysis = useMemo(
    () => analyzeMarket(snapshot),
    [snapshot]
  );

  const syntheticIntelligence = useMemo(
    () => analyzeSyntheticIntelligence(snapshot),
    [snapshot]
  );

  const analysisGate = useMemo(
    () =>
      evaluateAnalysisAssistedSignal(analysis, {
        minimumConfidence: settings.minConfidence,
        contractMode: settings.contractMode,
        prediction: settings.prediction,
        durationUnit: settings.durationUnit,
      }),
    [
      analysis,
      settings.minConfidence,
      settings.contractMode,
      settings.prediction,
      settings.durationUnit,
    ]
  );

  useEffect(() => {
    engineRef.current?.updateSignal({
      symbol,
      tickKey: `${symbol}:${prices.length}:${currentPrice}:${lastDigit}`,
      sampleSize: prices.length,
      priceCount: prices.length,
      updatedAt: Date.now(),
      professionalDecision,
      entryTiming,
      analysis,
      validatedSignals,
    });
  }, [
    symbol,
    professionalDecision,
    entryTiming,
    analysis,
    validatedSignals,
    prices.length,
    currentPrice,
    lastDigit,
  ]);


  const connecting =
    status === "CONNECTING" ||
    loadingMarket;

  const running = [
    "RUNNING",
    "WAITING",
    "BUYING",
    "MONITORING",
    "COOLDOWN",
    "RISK_COOLDOWN",
    "TESTING",
    "WON",
    "LOST",
  ].includes(botState.status);

  const paused =
    botState.status === "PAUSED";


  useEffect(() => {
    marketScanStartedRef.current = Date.now();
    setMarketSwitchState((current) => ({
      ...current,
      remaining: settings.marketScanSeconds,
      lastMarket: market?.label || symbol || "",
    }));
  }, [symbol, market?.label, settings.marketScanSeconds]);

  useEffect(() => {
    const switchableStatus = ["RUNNING", "WAITING"].includes(
      botState.status
    );

    if (
      !settings.autoSwitchVolatility ||
      !connected ||
      loadingMarket ||
      paused ||
      !switchableStatus ||
      markets.length < 2
    ) {
      return undefined;
    }

    const timer = window.setInterval(async () => {
      const elapsed = Math.floor(
        (Date.now() - marketScanStartedRef.current) / 1000
      );
      const remaining = Math.max(
        0,
        settings.marketScanSeconds - elapsed
      );

      setMarketSwitchState((current) => ({
        ...current,
        remaining,
      }));

      const collectingHistory =
        Number(syntheticIntelligence?.dataQuality || 0) < 48;
      const deepReady =
        Number(syntheticIntelligence?.bestScore || 0) >=
          Number(settings.deepMinimumScore || 70) &&
        Number(syntheticIntelligence?.dataQuality || 0) >= 48;

      const engineNeedsAnotherMarket =
        botState.status === "WAITING" &&
        /loss protection|walk-forward|professional direction|market changed|stale|deep engines disagree|regime shift|too random/i.test(
          String(botState.lastBlockReason || "")
        );

      if (
        collectingHistory ||
        remaining > 0 ||
        ((analysisGate.approved || deepReady) && !engineNeedsAnotherMarket)
      ) {
        return;
      }

      if (marketSwitchingRef.current) {
        return;
      }

      const currentIndex = Math.max(
        0,
        markets.findIndex((item) => item.id === symbol)
      );
      const nextMarket = markets[(currentIndex + 1) % markets.length];

      if (!nextMarket || nextMarket.id === symbol) {
        marketScanStartedRef.current = Date.now();
        return;
      }

      marketSwitchingRef.current = true;

      try {
        await changeSymbol(nextMarket.id);
        setMarketSwitchState((current) => ({
          remaining: settings.marketScanSeconds,
          switches: current.switches + 1,
          lastMarket: nextMarket.label || nextMarket.id,
        }));
      } finally {
        marketScanStartedRef.current = Date.now();
        marketSwitchingRef.current = false;
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [
    settings.autoSwitchVolatility,
    settings.marketScanSeconds,
    connected,
    loadingMarket,
    paused,
    botState.status,
    markets,
    symbol,
    analysisGate.approved,
    syntheticIntelligence,
    settings.deepMinimumScore,
    botState.lastBlockReason,
    changeSymbol,
  ]);
  const winRate =
    botState.runs > 0
      ? (
          (botState.wins /
            botState.runs) *
          100
        ).toFixed(1)
      : "0.0";

  const roi =
    botState.totalStake > 0
      ? (
          (botState.profit /
            botState.totalStake) *
          100
        ).toFixed(1)
      : "0.0";

  const completed =
    botState.status === "COMPLETED";

  const updateNumber = (key) => (event) => {
    setSettings((current) => ({
      ...current,
      [key]: Number(event.target.value),
    }));
  };


  const updateContractMode = (event) => {
    const contractMode = event.target.value;

    setSettings((current) => {
      let prediction = current.prediction;

      if (contractMode === "OVER") {
        prediction = Math.min(8, Math.max(0, prediction));
      } else if (contractMode === "UNDER") {
        prediction = Math.min(9, Math.max(1, prediction));
      } else {
        prediction = Math.min(9, Math.max(0, prediction));
      }

      const digitMode = isDigitContractMode(contractMode);

      return {
        ...current,
        contractMode,
        prediction,
        durationUnit: digitMode ? "t" : current.durationUnit,
        duration: digitMode
          ? Math.min(10, Math.max(1, current.duration))
          : current.duration,
      };
    });
  };

  const updateDurationUnit = (event) => {
    const durationUnit = event.target.value === "s" ? "s" : "t";

    setSettings((current) => ({
      ...current,
      durationUnit,
      duration:
        durationUnit === "s"
          ? Math.min(3600, Math.max(15, current.duration))
          : Math.min(10, Math.max(1, current.duration)),
    }));
  };

  async function startBot() {
    if (!auth.authenticated) {
      auth.login();
      return;
    }

    if (!connected) {
      await connect();
    }

    if (!isDemo) {
      const confirmed = window.confirm(
        `REAL TRADING WARNING\n\n` +
          `Account: ${selectedId || "selected real account"}\n` +
          `Stake: ${Number(settings.stake || 0).toFixed(2)} ${
            auth.selectedAccount?.currency || "USD"
          }\n` +
          `Maximum scan: ${settings.maxScanTicks} ticks\n` +
          `Contract duration: ${settings.duration} ${
            settings.durationUnit === "s" ? "seconds" : "ticks"
          }\n\n` +
          `Trades placed here will be sent to the connected Deriv real account. Continue?`
      );

      if (!confirmed) {
        return;
      }
    }

    await engineRef.current?.start();
  }

  async function testOneTrade() {
    if (!auth.authenticated) {
      auth.login();
      return;
    }

    const accountLabel = isDemo ? "Demo" : "REAL";
    const setup = setupForTest(settings, analysisGate);

    if (!isDemo) {
      const confirmed = window.confirm(
        `PLACE ONE REAL TEST TRADE?\n\n` +
          `Account: ${selectedId || "selected real account"}\n` +
          `Setup: ${setup}\n` +
          `Stake: ${Number(settings.stake || 0).toFixed(2)} ${
            auth.selectedAccount?.currency || "USD"
          }\n\n` +
          `This sends a real proposal and buy request to Deriv.`
      );

      if (!confirmed) {
        return;
      }
    }

    try {
      if (!connected) {
        await connect();
      }

      await engineRef.current?.testOneTrade(setup);
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : `Unable to complete the ${accountLabel} test trade.`
      );
    }
  }

  function resetBot() {
    engineRef.current?.reset();
    marketScanStartedRef.current = Date.now();
    setMarketSwitchState({
      remaining: settings.marketScanSeconds,
      switches: 0,
      lastMarket: market?.label || symbol || "",
    });
  }

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent">
        <Topbar
          title="EdgePilot V26 · Demo Execution Gate Fix + Real Strict"
          subtitle="Cycles, entropy, transitions, regimes, walk-forward validation and fast AI entries"
          connected={connected}
          connecting={connecting}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section className="botToolbar">
          <MarketSelector
            markets={markets}
            value={symbol}
            disabled={
              loadingMarket || running
            }
            onChange={changeSymbol}
          />

          <div
            className={isDemo ? "botDemoLock safe" : "botDemoLock real"}
          >
            {isDemo
              ? "✓ DEMO ACCOUNT"
              : `⚠ REAL ACCOUNT · ${selectedId || "SELECTED"}`}
          </div>
        </section>

        {statusDetail ? (
          <div className="connectionError">
            {statusDetail}
          </div>
        ) : null}

        <section className="botLayout">
          <article className="botCard botExecutionCard">
            <div className="botCardHeader">
              <div>
                <small>BOT CONFIGURATION</small>
                <h2>Execution rules</h2>
              </div>

              <span className={`botStatus ${botState.status.toLowerCase()}`}>
                {botState.status}
              </span>
            </div>

            <div className="botFormGrid">
              <Field label="Maximum runs">
                <select
                  value={settings.maxRuns}
                  disabled={running || paused}
                  onChange={updateNumber("maxRuns")}
                >
                  {[10, 20, 30, 40, 50, 56, 100].map(
                    (value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    )
                  )}
                </select>
              </Field>

              <Field label="Data target (adaptive ticks)">
                <input
                  type="number"
                  min="1"
                  max="1000"
                  value={settings.maxScanTicks}
                  disabled={running || paused}
                  onChange={updateNumber("maxScanTicks")}
                />
              </Field>

              <Field label="Contract">
                <select
                  value={settings.contractMode}
                  disabled={running || paused}
                  onChange={updateContractMode}
                >
                  <option value="AUTO">Auto SAFE — validated contract only</option>
                  <option value="RISE">Rise</option>
                  <option value="FALL">Fall</option>
                  <option value="EVEN">Even</option>
                  <option value="ODD">Odd</option>
                  <option value="OVER">Over selected digit</option>
                  <option value="UNDER">Under selected digit</option>
                  <option value="MATCH">Matches selected digit</option>
                  <option value="DIFFERS">Differs selected digit</option>
                </select>
              </Field>

              {needsPrediction(settings.contractMode) ? (
                <Field label="Prediction digit">
                  <select
                    value={settings.prediction}
                    disabled={running || paused}
                    onChange={updateNumber("prediction")}
                  >
                    {predictionOptions(settings.contractMode).map(
                      (digit) => (
                        <option key={digit} value={digit}>
                          {digit}
                        </option>
                      )
                    )}
                  </select>
                </Field>
              ) : null}

              <Field label="Base stake">
                <input
                  type="number"
                  min="0.35"
                  step="0.01"
                  value={settings.stake}
                  disabled={running || paused}
                  onChange={updateNumber("stake")}
                />
              </Field>

              <Field label="Duration unit">
                <select
                  value={settings.durationUnit}
                  disabled={running || paused}
                  onChange={updateDurationUnit}
                >
                  <option value="t">Ticks</option>
                  <option
                    value="s"
                    disabled={isDigitContractMode(settings.contractMode)}
                  >
                    Seconds — Rise/Fall or Auto
                  </option>
                </select>
              </Field>

              <Field
                label={`Duration (${
                  settings.durationUnit === "s" ? "seconds" : "ticks"
                })`}
              >
                <input
                  type="number"
                  min={settings.durationUnit === "s" ? 15 : 1}
                  max={settings.durationUnit === "s" ? 3600 : 10}
                  value={settings.duration}
                  disabled={running || paused}
                  onChange={updateNumber("duration")}
                />
              </Field>

              <Field label="Minimum confidence">
                <input
                  type="number"
                  min="70"
                  max="95"
                  value={settings.minConfidence}
                  disabled={running || paused}
                  onChange={updateNumber("minConfidence")}
                />
              </Field>


              <Field label="Delay after trade (seconds)">
                <input
                  type="number"
                  min="0"
                  max="60"
                  value={settings.delaySeconds}
                  disabled={running || paused}
                  onChange={updateNumber("delaySeconds")}
                />
              </Field>

              <Field label="Take profit">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={settings.takeProfit}
                  disabled={running || paused}
                  onChange={updateNumber("takeProfit")}
                />
              </Field>

              <Field label="Stop loss">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={settings.stopLoss}
                  disabled={running || paused}
                  onChange={updateNumber("stopLoss")}
                />
              </Field>

              <Field label="Losses before cooldown">
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={settings.cooldownAfterLosses}
                  disabled={running || paused}
                  onChange={updateNumber("cooldownAfterLosses")}
                />
              </Field>

              <Field label="Risk cooldown (seconds)">
                <input
                  type="number"
                  min="10"
                  max="900"
                  value={settings.cooldownSeconds}
                  disabled={running || paused}
                  onChange={updateNumber("cooldownSeconds")}
                />
              </Field>

              <Field label="Hard-stop loss streak">
                <input
                  type="number"
                  min="2"
                  max="20"
                  value={settings.hardStopLossStreak}
                  disabled={running || paused}
                  onChange={updateNumber("hardStopLossStreak")}
                />
              </Field>

              <label className="botToggle">
                <input
                  type="checkbox"
                  checked={settings.martingaleEnabled}
                  disabled={running || paused}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      martingaleEnabled:
                        event.target.checked,
                    }))
                  }
                />
                <span>
                  Enable limited martingale
                </span>
              </label>

              <div className="botRecoverySchedule">
                <span>Smart recovery schedule</span>
                <strong>Step 1 ×1.35 only</strong>
                <small>
                  Safer cap. It remains OFF by default and a win resets to base.
                </small>
              </div>

              <Field label="Maximum martingale steps">
                <input
                  type="number"
                  min="0"
                  max="1"
                  value={settings.maxMartingaleSteps}
                  disabled={
                    running ||
                    paused ||
                    !settings.martingaleEnabled
                  }
                  onChange={updateNumber("maxMartingaleSteps")}
                />
              </Field>

              <label className="botToggle botFrequencyToggle">
                <input
                  type="checkbox"
                  checked={settings.analysisAssisted !== false}
                  disabled={running || paused}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      analysisAssisted: event.target.checked,
                    }))
                  }
                />
                <span>
                  Enable Analysis Assisted entry
                </span>
              </label>


              <label className="botToggle botMarketSwitchToggle">
                <input
                  type="checkbox"
                  checked={settings.autoSwitchVolatility}
                  disabled={running || paused}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      autoSwitchVolatility: event.target.checked,
                    }))
                  }
                />
                <span>Auto-switch Volatility markets</span>
              </label>

              <Field label="Seconds per market scan">
                <input
                  type="number"
                  min="10"
                  max="120"
                  value={settings.marketScanSeconds}
                  disabled={
                    running ||
                    paused ||
                    !settings.autoSwitchVolatility
                  }
                  onChange={updateNumber("marketScanSeconds")}
                />
              </Field>

              
            </div>

            <div className="botTerminalStrip">
              <div>
                <small>AI MODE</small>
                <strong>{settings.analysisAssisted ? "ANALYSIS ASSISTED" : "DISABLED"}</strong>
              </div>
              <div>
                <small>MARKET SWITCH</small>
                <strong>{settings.autoSwitchVolatility ? `${settings.marketScanSeconds}s AUTO` : "MANUAL"}</strong>
              </div>
              <div>
                <small>RISK CONTROL</small>
                <strong>SL {settings.stopLoss} · HARD {settings.hardStopLossStreak}</strong>
              </div>
              <div>
                <small>RECOVERY</small>
                <strong>{settings.martingaleEnabled ? "LIMITED ×1.35" : "OFF"}</strong>
              </div>
              <div>
                <small>DEMO EXECUTION FIXED · REAL STRICT</small>
                <strong>
                  DEMO: HIGH-PROBABILITY 3-VOTE PATH · REAL: STRICT GATE
                </strong>
              </div>
            </div>

            

            <div className="botMessage">
              {botState.message}
            </div>

            <div className="botActions">
              {!running && !paused ? (
                <button
                  type="button"
                  className="primaryButton"
                  onClick={startBot}
                >
                  {isDemo ? "Start Demo Bot" : "Start Real Bot"}
                </button>
              ) : null}

              {running ? (
                <button
                  type="button"
                  className="secondaryButton"
                  onClick={() =>
                    engineRef.current?.pause()
                  }
                >
                  Pause
                </button>
              ) : null}

              {paused ? (
                <button
                  type="button"
                  className="primaryButton"
                  onClick={() =>
                    engineRef.current?.resume()
                  }
                >
                  Resume
                </button>
              ) : null}

              {(running || paused) ? (
                <button
                  type="button"
                  className="dangerButton"
                  onClick={() =>
                    engineRef.current?.stop()
                  }
                >
                  Stop
                </button>
              ) : null}

              {!running && !paused ? (
                <>
                  <button
                    type="button"
                    className="testTradeButton"
                    onClick={testOneTrade}
                  >
                    {isDemo ? "Test 1 Demo Trade" : "Test 1 Real Trade"}
                  </button>

                  <button
                    type="button"
                    className="secondaryButton"
                    onClick={resetBot}
                  >
                    Reset Stats
                  </button>
                </>
              ) : null}
            </div>

            <div className="botSafetyNote">
              {isDemo
                ? "Demo mode: orders go to the connected Deriv demo account."
                : "REAL mode: confirmed orders are sent to the connected Deriv real account and can lose real money."}{" "}
              Demo can now execute high-probability non-MATCH candidates after three engine votes and two fresh confirmations. The engine-vote state is also displayed correctly. Real remains strict, caps stake at 0.35 USD, disables martingale and stops after one loss. No bot can guarantee wins.
            </div>
          </article>

          
          <article className="botCard botAnalysisCard">
            <div className="botCardHeader botSectionHeader">
              <div>
                <small>LIVE ANALYSIS</small>
                <h2>Live AI</h2>
              </div>

              <span className={`botStatus ${analysisGate.approved ? "running" : "waiting"}`}>
                {analysisGate.approved ? "SIGNAL READY" : "SCANNING"}
              </span>
            </div>

<div className="botDecisionBox">
              <div>
                <small>CONTRACT CONTROL</small>
                <strong>
                  {contractModeLabel(
                    settings.contractMode,
                    settings.prediction
                  )}
                </strong>
              </div>

              <div>
                <small>ANALYSIS DECISION</small>
                <strong>
                  {analysisGate.approved
                    ? analysisGate.setup
                    : Number(syntheticIntelligence.bestScore || 0) >=
                      Number(settings.deepMinimumScore || 70)
                    ? syntheticIntelligence.bestSetup
                    : "WAIT"}
                </strong>
              </div>

              <div>
                <small>GATE CONFIDENCE</small>
                <strong>
                  {Math.max(
                    Number(analysisGate.confidence || 0),
                    Number(syntheticIntelligence.bestScore || 0)
                  ).toFixed(1)}%
                </strong>
              </div>

              <div>
                <small>ENTRY</small>
                <strong>
                  {analysisGate.approved ||
                  Number(syntheticIntelligence.bestScore || 0) >=
                    Number(settings.deepMinimumScore || 70)
                    ? botState.status === "WAITING" && botState.lastBlockReason
                      ? "CONFIRM"
                      : syntheticIntelligence.fastLane
                      ? "FAST AI"
                      : "READY"
                    : "WAIT"}
                </strong>
              </div>
            </div>

            <div className="botStrictGate">
              <strong>
                {analysisGate.approved || Number(syntheticIntelligence.bestScore || 0) >= Number(settings.deepMinimumScore || 70)
                  ? botState.status === "WAITING" && botState.lastBlockReason
                    ? `DEEP CHECK / CONFIRMING: ${analysisGate.approved ? analysisGate.setup : syntheticIntelligence.bestSetup}`
                    : `${syntheticIntelligence.fastLane ? "FAST AI" : "DEEP VALIDATED"}: ${analysisGate.approved ? analysisGate.setup : syntheticIntelligence.bestSetup}`
                  : "DEEP SCAN FOR A REAL EDGE"}
              </strong>
              <span>
                {market?.label || symbol} · Scan {botState.scanTicks || 0}/{settings.maxScanTicks} ticks · Contract {settings.duration}{" "}
                {settings.durationUnit === "s" ? "seconds" : "ticks"} ·{" "}
                {botState.lastBlockReason ||
                  analysisGate.reason ||
                  syntheticIntelligence.bestDetail}
              </span>
            </div>

            <div className="botIntelligence">
              <div className="botIntelligenceHeader">
                <div>
                  <small>ACTIVE V12 DECISION LAYER</small>
                  <h3>Core decision metrics</h3>
                </div>

                <span
                  className={`botRiskBadge ${
                    syntheticIntelligence.regime === "REGIME SHIFT" ||
                    syntheticIntelligence.volatility?.state === "BURST"
                      ? "high"
                      : syntheticIntelligence.fastLane
                      ? "low"
                      : "medium"
                  }`}
                >
                  {syntheticIntelligence.fastLane
                    ? "FAST AI READY"
                    : syntheticIntelligence.regime || "SCANNING"}
                </span>
              </div>

              <div className="botIntelligenceGrid">
                <Metric
                  label="Probability"
                  value={`${Number(
                    syntheticIntelligence.consensus || 0
                  ).toFixed(1)}%`}
                />
                <Metric
                  label="Bayesian setup"
                  value={`${syntheticIntelligence.bestSetup || "WAIT"} · ${Number(
                    syntheticIntelligence.bestScore || 0
                  ).toFixed(1)}%`}
                />
                <Metric
                  label="Regime"
                  value={syntheticIntelligence.regime || "UNKNOWN"}
                />
                <Metric
                  label="Cycle"
                  value={
                    syntheticIntelligence.cycle?.period
                      ? `${syntheticIntelligence.cycle.period} ticks · ${Number(
                          syntheticIntelligence.cycle.strength || 0
                        ).toFixed(0)}%`
                      : "NO STABLE CYCLE"
                  }
                />
                <Metric
                  label="Momentum"
                  value={`${syntheticIntelligence.momentum?.direction || "NEUTRAL"} · ${Number(
                    syntheticIntelligence.momentum?.agreement || 0
                  ).toFixed(0)}%`}
                />
                <Metric
                  label="Entropy"
                  value={`${Number(
                    syntheticIntelligence.entropy?.normalized || 0
                  ).toFixed(1)}% · ${
                    syntheticIntelligence.entropy?.label || "UNKNOWN"
                  }`}
                />
                <Metric
                  label="Lag"
                  value={`Lag ${syntheticIntelligence.autocorrelation?.lag || "—"} · ${Number(
                    syntheticIntelligence.autocorrelation?.strength || 0
                  ).toFixed(0)}%`}
                />
                <Metric
                  label="Transition"
                  value={`${syntheticIntelligence.transition?.observed || 0} matching transitions`}
                />
                <Metric
                  label="Volatility phase"
                  value={`${syntheticIntelligence.volatility?.state || "UNKNOWN"} · ${Number(
                    syntheticIntelligence.volatility?.stability || 0
                  ).toFixed(0)}% stable`}
                />
                <Metric
                  label="Data quality"
                  value={`${Number(
                    syntheticIntelligence.dataQuality || 0
                  ).toFixed(1)}%`}
                />
                <Metric
                  label="Decision"
                  value={`${professionalDecision.bestContract || "WAIT"} · ${Number(
                    professionalDecision.professionalScore ||
                      professionalDecision.confidence ||
                      0
                  ).toFixed(0)}%`}
                />
                <Metric
                  label="Entry speed"
                  value={"VALIDATED · 1 fresh confirm"}
                />
              </div>

              <div className="botScoreBreakdown">
                {(syntheticIntelligence.components || []).map(
                  (component) => (
                    <div
                      className="botScoreRow"
                      key={component.key}
                    >
                      <div>
                        <strong>{component.label}</strong>
                        <small>{component.detail}</small>
                      </div>

                      <div className="botScoreTrack">
                        <span
                          style={{
                            width: `${Math.max(
                              0,
                              Math.min(
                                100,
                                Number(component.score || 0)
                              )
                            )}%`,
                          }}
                        />
                      </div>

                      <b>
                        {Number(component.score || 0).toFixed(0)}
                      </b>
                    </div>
                  )
                )}
              </div>
            </div>
          </article>

<aside className="botCard botPerformanceCard">
            <div className="botCardHeader">
              <div>
                <small>LIVE PERFORMANCE</small>
                <h2>
                  Run {botState.runs}/{settings.maxRuns}
                </h2>
              </div>
            </div>

            <div className="botMetrics">
              <Metric
                label="Wins"
                value={botState.wins}
              />
              <Metric
                label="Losses"
                value={botState.losses}
              />
              <Metric
                label="Win rate"
                value={`${winRate}%`}
              />
              <Metric
                label="Total P&L"
                value={`${botState.profit.toFixed(
                  2
                )} ${
                  auth.selectedAccount?.currency ||
                  "USD"
                }`}
              />
              <Metric
                label="Current stake"
                value={botState.currentStake.toFixed(
                  2
                )}
              />
              <Metric
                label="Loss streak"
                value={botState.consecutiveLosses}
              />
              <Metric
                label="Losses since win"
                value={botState.lossesSinceWin}
              />
              <Metric
                label="Risk cooldowns"
                value={botState.cooldownCount}
              />
              <Metric
                label="Gate mode"
                value={
                  botState.gate?.demoOperationalPass
                    ? "DEMO OPERATIONAL"
                    : isDemo
                      ? "DEMO SCORED"
                      : "REAL STRICT"
                }
              />
              <Metric
                label="Engine votes"
                value={`${Number(botState.gate?.engineVotes || 0)}/${Number(botState.gate?.requiredEngineVotes || 0)}`}
              />
              <Metric
                label="Strong votes"
                value={Number(botState.gate?.strongEngineVotes || 0)}
              />
              <Metric
                label="Market profile"
                value={botState.gate?.marketProfile || symbol}
              />
              <Metric
                label="Execution score"
                value={`${Number(botState.gate?.executionScore || 0).toFixed(1)}/${Number(botState.gate?.executionThreshold || 0).toFixed(1)}`}
              />
              <Metric
                label="Fresh confirms"
                value={botState.signalConfirmations || 0}
              />
              <Metric
                label="Data readiness"
                value={(botState.scanTicks || 0) >= 20 ? `READY · ${botState.scanTicks || 0} ticks` : `${botState.scanTicks || 0}/20`}
              />
              <Metric
                label="Analysis cycle"
                value={botState.scanWindow || 1}
              />
              <Metric
                label="Scan time"
                value={`${botState.scanElapsedSeconds || 0}s`}
              />
              <Metric
                label="Gate"
                value={
                  analysisGate.approved ||
                  Number(syntheticIntelligence.bestScore || 0) >=
                    Number(settings.deepMinimumScore || 70)
                    ? syntheticIntelligence.fastLane
                      ? "FAST AI"
                      : "DEEP READY"
                    : "WAIT"
                }
              />
              <Metric
                label="Fresh confirmations"
                value={`${botState.signalConfirmations || 0}/${
                  botState.requiredConfirmations || settings.confirmationCount || 1
                }`}
              />
              <Metric
                label="Deep score"
                value={`${Number(
                  botState.deepScore || syntheticIntelligence.bestScore || 0
                ).toFixed(1)}%`}
              />
              <Metric
                label="Deep regime"
                value={botState.deepRegime || syntheticIntelligence.regime || "UNKNOWN"}
              />
              <Metric
                label="Cycle read"
                value={
                  (botState.cyclePeriod || syntheticIntelligence.cycle?.period)
                    ? `${botState.cyclePeriod || syntheticIntelligence.cycle?.period} ticks`
                    : "NONE"
                }
              />
              <Metric
                label="AI lane"
                value={botState.fastLane || syntheticIntelligence.fastLane ? "FAST" : "NORMAL"}
              />
              <Metric
                label="Loss protection"
                value={
                  botState.blockedSetupUntil > Date.now()
                    ? `${botState.lastLossSetup || "SETUP"} BLOCKED`
                    : `${botState.lossProtectionCount || 0} used`
                }
              />
              <Metric
                label="Contract control"
                value={contractModeLabel(
                  settings.contractMode,
                  settings.prediction
                )}
              />
              <Metric
                label="Duration"
                value={`${settings.duration} ${
                  settings.durationUnit === "s" ? "sec" : "ticks"
                }`}
              />
              <Metric
                label="Market switch"
                value={
                  settings.autoSwitchVolatility
                    ? `${marketSwitchState.remaining}s`
                    : "FIXED"
                }
              />
              <Metric
                label="Markets checked"
                value={marketSwitchState.switches + 1}
              />
              <Metric
                label="Martingale step"
                value={botState.martingaleStep}
              />
              <Metric
                label="Active setup"
                value={botState.activeSetup}
              />
            </div>

            {completed ? (
              <div className="botCompletionSummary">
                <small>SESSION COMPLETE</small>
                <h3>{botState.stopReason || "Bot session completed."}</h3>

                <div className="botCompletionGrid">
                  <Metric label="Runs" value={botState.runs} />
                  <Metric label="Wins" value={botState.wins} />
                  <Metric label="Losses" value={botState.losses} />
                  <Metric label="Win rate" value={`${winRate}%`} />
                  <Metric
                    label="Net profit"
                    value={`${botState.profit.toFixed(2)} ${
                      auth.selectedAccount?.currency || "USD"
                    }`}
                  />
                  <Metric label="ROI" value={`${roi}%`} />
                  <Metric
                    label="Largest win streak"
                    value={botState.largestWinStreak}
                  />
                  <Metric
                    label="Largest loss streak"
                    value={botState.largestLossStreak}
                  />
                </div>
              </div>
            ) : null}

            <div className="botHistory">
              <div className="botHistoryHeader">
                <strong>Recent runs</strong>
                <span>
                  {botState.history.length}
                </span>
              </div>

              {botState.history.length === 0 ? (
                <div className="botHistoryEmpty">
                  No completed runs yet.
                </div>
              ) : (
                botState.history.map((item) => (
                  <div
                    className="botHistoryRow botHistoryRowDetailed"
                    key={`${item.id}-${item.time}`}
                  >
                    <div className="botHistoryMain">
                      <strong>
                        {item.setup} · {item.symbol || market?.id || symbol}
                      </strong>
                      <small>
                        {new Date(item.time).toLocaleTimeString()} · Contract{" "}
                        {item.contractId || "—"}
                      </small>
                      <small>
                        Entry {Number(item.entrySpot || 0).toFixed(3)} · Exit{" "}
                        {Number(item.exitSpot || 0).toFixed(3)} · Stake{" "}
                        {Number(item.stake || 0).toFixed(2)} ·{" "}
                        {Number(item.duration || 0)}{" "}
                        {item.durationUnit === "s" ? "sec" : "ticks"} · Entry scan{" "}
                        {Number(item.entryScanTick || 0)}/{settings.maxScanTicks} · MG{" "}
                        {Number(item.martingaleStep || 0)}
                      </small>
                      <small>
                        Mode {item.executionMode || "V12_DEEP_CYCLE_AI"} ·
                        Confidence {Number(item.confidence || 0).toFixed(1)}% ·{" "}
                        Entry {item.entryStage || "ENTER"}
                      </small>
                    </div>

                    <span
                      className={`botResult ${String(
                        item.result
                      ).toLowerCase()}`}
                    >
                      {item.result}
                    </span>

                    <strong>
                      {Number(item.profit || 0) >= 0 ? "+" : ""}
                      {Number(item.profit || 0).toFixed(2)}
                    </strong>
                  </div>
                ))
              )}
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}




