
import { useEffect, useRef, useState } from "react";

import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { useDerivAuth } from "../auth/DerivAuthContext";
import derivPublicClient from "../services/derivApi";
import QuickDigitBotEngine from "../bot/QuickDigitBotEngine";
import "../styles/Bot.css";

const INITIAL_SETTINGS = {
  contractMode: "OVER",
  prediction: 2,
  stake: 0.35,
  duration: 5,
  maxRuns: 10,
  delayMs: 100,
};

const INITIAL_STATE = {
  status: "IDLE",
  message: "Quick Digit Bot is ready.",
  runs: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  activeContractId: "",
  activeSetup: "—",
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
  return (
    <label className="botField">
      <span>{label}</span>
      {children}
    </label>
  );
}

export default function Bot() {
  const auth = useDerivAuth();
  const engineRef = useRef(null);

  const [settings, setSettings] = useState(INITIAL_SETTINGS);
  const [botState, setBotState] = useState(INITIAL_STATE);

  const {
    markets,
    symbol,
    connected,
    connecting,
    loadingMarket,
    statusDetail,
    connect,
    disconnect,
    changeSymbol,
  } = useDerivTicks();

  const selectedId = accountId(auth.selectedAccount);
  const isDemo = auth.selectedAccountType === "demo";
  const running = ["RUNNING", "BUYING", "MONITORING", "WON", "LOST"].includes(
    botState.status
  ) && botState.status !== "STOPPED";

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
    const engine = new QuickDigitBotEngine({
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
        "Quick Digit Bot V1 is locked to Demo until it has been tested safely."
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
        error instanceof Error ? error.message : "Unable to start the bot."
      );
    }
  }

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent">
        <Topbar
          title="EdgePilot Quick Digit Bot V1"
          subtitle="Press Run to enter the selected digit contract immediately"
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
              ? "✓ DEMO QUICK BOT"
              : `⚠ REAL LOCKED · ${selectedId || "SELECTED"}`}
          </div>
        </section>

        {statusDetail ? (
          <div className="connectionError">{statusDetail}</div>
        ) : null}

        <section className="botLayout">
          <article className="botCard botExecutionCard">
            <div className="botCardHeader">
              <div>
                <small>NEW BOT</small>
                <h2>Immediate digit execution</h2>
              </div>

              <span className={`botStatus ${botState.status.toLowerCase()}`}>
                {botState.status}
              </span>
            </div>

            <div className="botFormGrid">
              <Field label="Contract">
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
                  <option value="OVER">Over</option>
                  <option value="UNDER">Under</option>
                  <option value="DIFFERS">Differs</option>
                  <option value="MATCH">Matches</option>
                </select>
              </Field>

              <Field label="Prediction digit">
                <select
                  value={settings.prediction}
                  disabled={running}
                  onChange={updateNumber("prediction")}
                >
                  {Array.from({ length: 10 }, (_, digit) => (
                    <option key={digit} value={digit}>
                      {digit}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Stake">
                <input
                  type="number"
                  min="0.35"
                  step="0.01"
                  value={settings.stake}
                  disabled={running}
                  onChange={updateNumber("stake")}
                />
              </Field>

              <Field label="Duration (ticks)">
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={settings.duration}
                  disabled={running}
                  onChange={updateNumber("duration")}
                />
              </Field>

              <Field label="Maximum runs">
                <input
                  type="number"
                  min="1"
                  max="1000"
                  value={settings.maxRuns}
                  disabled={running}
                  onChange={updateNumber("maxRuns")}
                />
              </Field>

              <Field label="Delay between runs (ms)">
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="100"
                  value={settings.delayMs}
                  disabled={running}
                  onChange={updateNumber("delayMs")}
                />
              </Field>
            </div>

            <div className="botTerminalStrip">
              <div>
                <small>MODE</small>
                <strong>IMMEDIATE ENTRY</strong>
              </div>
              <div>
                <small>CONTRACT</small>
                <strong>
                  {settings.contractMode} {settings.prediction}
                </strong>
              </div>
              <div>
                <small>DURATION</small>
                <strong>{settings.duration} TICKS</strong>
              </div>
              <div>
                <small>ACCOUNT</small>
                <strong>{isDemo ? "DEMO" : "REAL LOCKED"}</strong>
              </div>
            </div>

            <div className="botMessageBar">{botState.message}</div>

            <div className="botActions">
              {!running ? (
                <button className="botStartButton" onClick={startBot}>
                  Run Quick Bot
                </button>
              ) : (
                <button
                  className="botStopButton"
                  onClick={() => engineRef.current?.stop()}
                >
                  Stop
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
              Run opens the selected contract immediately without analysis.
              This first version is Demo-only because immediate automated
              entries can lose money.
            </p>
          </article>

          <article className="botCard">
            <div className="botCardHeader">
              <div>
                <small>LIVE PERFORMANCE</small>
                <h2>
                  Run {botState.runs}/{settings.maxRuns}
                </h2>
              </div>
            </div>

            <div className="botMetricGrid">
              <div>
                <small>Wins</small>
                <strong>{botState.wins}</strong>
              </div>
              <div>
                <small>Losses</small>
                <strong>{botState.losses}</strong>
              </div>
              <div>
                <small>Win rate</small>
                <strong>
                  {botState.runs
                    ? `${((botState.wins / botState.runs) * 100).toFixed(1)}%`
                    : "0.0%"}
                </strong>
              </div>
              <div>
                <small>Total P&L</small>
                <strong>{botState.profit.toFixed(2)} USD</strong>
              </div>
            </div>

            <div className="botTerminalStrip">
              <div>
                <small>ACTIVE SETUP</small>
                <strong>{botState.activeSetup}</strong>
              </div>
              <div>
                <small>CONTRACT ID</small>
                <strong>{botState.activeContractId || "—"}</strong>
              </div>
              <div>
                <small>STATUS</small>
                <strong>{botState.status}</strong>
              </div>
            </div>

            <div className="botHistory">
              <div className="botHistoryHeader">
                <strong>Recent runs</strong>
                <span>{botState.history.length}</span>
              </div>

              {botState.history.length ? (
                botState.history.map((item) => (
                  <div className="botHistoryRow" key={item.id}>
                    <div>
                      <strong>{item.setup}</strong>
                      <small>{item.contractId}</small>
                    </div>
                    <strong className={item.result === "WIN" ? "win" : "loss"}>
                      {item.result} {item.profit >= 0 ? "+" : ""}
                      {item.profit.toFixed(2)}
                    </strong>
                  </div>
                ))
              ) : (
                <div className="botHistoryEmpty">No completed runs yet.</div>
              )}
            </div>
          </article>
        </section>
      </main>
    </div>
  );
}
