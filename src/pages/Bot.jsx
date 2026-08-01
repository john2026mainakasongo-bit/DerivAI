import {
  useEffect,
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

import DerivBotEngine from "../bot/DerivBotEngine";
import "../styles/Bot.css";

const INITIAL_SETTINGS = {
  maxRuns: 56,
  stake: 1,
  duration: 5,
  minConfidence: 75,
  minVotes: 3,
  takeProfit: 20,
  stopLoss: 10,
  maxConsecutiveLosses: 3,
  delaySeconds: 3,
  martingaleEnabled: false,
  martingaleMultiplier: 2,
  maxMartingaleSteps: 3,
};

const INITIAL_BOT_STATE = {
  status: "IDLE",
  message: "Bot is ready.",
  runs: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  consecutiveLosses: 0,
  martingaleStep: 0,
  currentStake: 1,
  activeSetup: "—",
  activeContractId: "",
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

function Field({ label, children }) {
  async function testOneTrade() {
    if (!auth.authenticated) {
      auth.login();
      return;
    }

    if (!isDemo) {
      window.alert(
        "The test trade is locked to a Demo Account."
      );
      return;
    }

    try {
      if (!connected) {
        await connect();
      }

      await engineRef.current?.testOneDemoTrade(
        professionalDecision.setup === "FALL"
          ? "FALL"
          : "RISE"
      );
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Unable to complete the Demo test trade."
      );
    }
  }

  return (
    <label className="botField">
      <span>{label}</span>
      {children}
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

  const [settings, setSettings] =
    useState(INITIAL_SETTINGS);

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
          tradeTicks: settings.duration,
          validitySeconds: 15,
        }
      ),
    [
      validatedSignals,
      snapshot,
      settings.duration,
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

  useEffect(() => {
    engineRef.current?.updateSignal({
      professionalDecision,
      entryTiming,
      analysis,
    });
  }, [
    professionalDecision,
    entryTiming,
    analysis,
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
    "WON",
    "LOST",
  ].includes(botState.status);

  const paused =
    botState.status === "PAUSED";

  const winRate =
    botState.runs > 0
      ? (
          (botState.wins /
            botState.runs) *
          100
        ).toFixed(1)
      : "0.0";

  const updateNumber = (key) => (event) => {
    setSettings((current) => ({
      ...current,
      [key]: Number(event.target.value),
    }));
  };

  async function startBot() {
    if (!auth.authenticated) {
      auth.login();
      return;
    }

    if (!isDemo) {
      window.alert(
        "For safety, the 56-run bot is locked to a Demo Account."
      );
      return;
    }

    if (!connected) {
      await connect();
    }

    await engineRef.current?.start();
  }

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent">
        <Topbar
          title="56-Run Auto Bot"
          subtitle="Demo-only automated execution with strict risk controls"
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
            className={
              isDemo
                ? "botDemoLock safe"
                : "botDemoLock"
            }
          >
            {isDemo
              ? "✓ DEMO ACCOUNT"
              : "DEMO ACCOUNT REQUIRED"}
          </div>
        </section>

        {statusDetail ? (
          <div className="connectionError">
            {statusDetail}
          </div>
        ) : null}

        <section className="botLayout">
          <article className="botCard">
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

              <Field label="Duration (ticks)">
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={settings.duration}
                  disabled={running || paused}
                  onChange={updateNumber("duration")}
                />
              </Field>

              <Field label="Minimum confidence">
                <input
                  type="number"
                  min="50"
                  max="99"
                  value={settings.minConfidence}
                  disabled={running || paused}
                  onChange={updateNumber("minConfidence")}
                />
              </Field>

              <Field label="Minimum votes">
                <input
                  type="number"
                  min="1"
                  max="7"
                  value={settings.minVotes}
                  disabled={running || paused}
                  onChange={updateNumber("minVotes")}
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

              <Field label="Maximum consecutive losses">
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={settings.maxConsecutiveLosses}
                  disabled={running || paused}
                  onChange={updateNumber("maxConsecutiveLosses")}
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

              <Field label="Martingale multiplier">
                <input
                  type="number"
                  min="1"
                  max="5"
                  step="0.1"
                  value={settings.martingaleMultiplier}
                  disabled={
                    running ||
                    paused ||
                    !settings.martingaleEnabled
                  }
                  onChange={updateNumber("martingaleMultiplier")}
                />
              </Field>

              <Field label="Maximum martingale steps">
                <input
                  type="number"
                  min="0"
                  max="10"
                  value={settings.maxMartingaleSteps}
                  disabled={
                    running ||
                    paused ||
                    !settings.martingaleEnabled
                  }
                  onChange={updateNumber("maxMartingaleSteps")}
                />
              </Field>
            </div>

            <div className="botDecisionBox">
              <div>
                <small>CURRENT DECISION</small>
                <strong>
                  {professionalDecision.setup ||
                    "WAIT"}
                </strong>
              </div>

              <div>
                <small>CONFIDENCE</small>
                <strong>
                  {Number(
                    professionalDecision.confidence ||
                      0
                  ).toFixed(1)}
                  %
                </strong>
              </div>

              <div>
                <small>VOTES</small>
                <strong>
                  {professionalDecision.passedCount ||
                    0}
                  /
                  {professionalDecision.totalChecks ||
                    0}
                </strong>
              </div>

              <div>
                <small>ENTRY</small>
                <strong>
                  {entryTiming.state || "WAIT"}
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
                  Start Demo Bot
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
                    Test 1 Demo Trade
                  </button>

                  <button
                    type="button"
                    className="secondaryButton"
                    onClick={() =>
                      engineRef.current?.reset()
                    }
                  >
                    Reset Stats
                  </button>
                </>
              ) : null}
            </div>
          </article>

          <aside className="botCard">
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
                label="Martingale step"
                value={botState.martingaleStep}
              />
              <Metric
                label="Active setup"
                value={botState.activeSetup}
              />
            </div>

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
                    className="botHistoryRow"
                    key={`${item.id}-${item.time}`}
                  >
                    <div>
                      <strong>{item.setup}</strong>
                      <small>
                        {new Date(
                          item.time
                        ).toLocaleTimeString()}
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
                      {Number(
                        item.profit || 0
                      ).toFixed(2)}
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
