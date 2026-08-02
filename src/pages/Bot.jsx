
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
  return /^(OVER|UNDER|MATCH(?:ES)?|DIFFERS?)\s+[0-9]$/i.test(
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

function bestAutoSignal(analysis, validated) {
  const candidates = [];

  if (
    validated?.best?.approved &&
    supportedSetup(validated.best.action)
  ) {
    candidates.push({
      setup: normalizeSetup(validated.best.action),
      confidence: setupConfidence(validated.best),
      source: "BACKTEST VALIDATED",
      detail: validated.best.reason || "",
    });
  }

  for (const item of [
    analysis?.signals?.threshold,
    analysis?.signals?.matchDiff,
  ]) {
    if (item && supportedSetup(item.signal)) {
      candidates.push({
        setup: normalizeSetup(item.signal),
        confidence: setupConfidence(item),
        source: "LIVE ANALYSIS",
        detail: item.detail || "",
      });
    }
  }

  return candidates.sort(
    (left, right) => right.confidence - left.confidence
  )[0] || null;
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

  const [settings, setSettings] = useState(INITIAL_SETTINGS);
  const [botState, setBotState] = useState(INITIAL_STATE);

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

  const autoSignal = useMemo(
    () => bestAutoSignal(analysis, validated),
    [analysis, validated]
  );

  const running = [
    "RUNNING",
    "SCANNING",
    "BUYING",
    "MONITORING",
    "WON",
    "LOST",
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
    const engine = new TurboAutoDigitBotEngine({
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
    engineRef.current?.setMarket({
      symbol,
      currency: auth.selectedAccount?.currency || "USD",
    });
  }, [symbol, auth.selectedAccount?.currency]);

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

    if (!isDemo) {
      window.alert(
        "V51 Turbo Auto Digit Bot is Demo-only until its Auto flow is fully tested."
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
          title="EdgePilot V51 · Turbo Auto Digit Bot"
          subtitle="AUTO, Over, Under, Matches and Differs with continuous execution"
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
              ? "✓ DEMO TURBO BOT"
              : `⚠ REAL LOCKED · ${selectedId || "SELECTED"}`}
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
                    running || settings.predictionMode === "AUTO"
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
            </div>

            <label className="turboUnlimited">
              <input
                type="checkbox"
                checked={settings.unlimited}
                disabled={running}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    unlimited: event.target.checked,
                  }))
                }
              />
              <span>Unlimited runs until Stop, profit target or loss limit</span>
            </label>

            <div className="turboSignalStrip">
              <div>
                <small>ANALYSIS CONTRACT</small>
                <strong>{autoSignal?.setup || "WAIT"}</strong>
              </div>
              <div>
                <small>CONFIDENCE</small>
                <strong>
                  {Number(autoSignal?.confidence || 0).toFixed(1)}%
                </strong>
              </div>
              <div>
                <small>SOURCE</small>
                <strong>{autoSignal?.source || "LIVE ANALYSIS"}</strong>
              </div>
              <div>
                <small>LAST DIGIT</small>
                <strong>{lastDigit ?? "—"}</strong>
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
              AUTO uses the live Analysis and Backtest engines. Manual
              contracts enter continuously using your selected digit.
              V51 is Demo-only because automated digit contracts can lose money.
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
                        <td>{item.contractId}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="6" className="turboEmpty">
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
