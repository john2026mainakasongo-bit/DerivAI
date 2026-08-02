
import { useMemo, useState } from "react";

import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import {
  analyzeDigitSetups,
  analyzeRiseFall,
} from "../analysis/v67UnifiedAnalysisEngine";
import "../styles/Analysis.css";

function percent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)}%` : "0.0%";
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(3) : "—";
}

function riskClass(risk) {
  if (risk === "GOOD ENTRY") return "good";
  if (risk === "RISKY") return "risky";
  return "blocked";
}

function digitTrade(signal = "") {
  const text = String(signal || "").toUpperCase();

  if (text === "EVEN") {
    return { label: text, contractType: "DIGITEVEN", barrier: undefined };
  }

  if (text === "ODD") {
    return { label: text, contractType: "DIGITODD", barrier: undefined };
  }

  const over = text.match(/^OVER\s+([0-9])$/);
  if (over) return { label: text, contractType: "DIGITOVER", barrier: over[1] };

  const under = text.match(/^UNDER\s+([0-9])$/);
  if (under) return { label: text, contractType: "DIGITUNDER", barrier: under[1] };

  const match = text.match(/^MATCH\s+([0-9])$/);
  if (match) return { label: text, contractType: "DIGITMATCH", barrier: match[1] };

  const differs = text.match(/^DIFFERS\s+([0-9])$/);
  if (differs) return { label: text, contractType: "DIGITDIFF", barrier: differs[1] };

  return null;
}

function SetupCard({ candidate }) {
  return (
    <div className={`v67SetupCard ${riskClass(candidate.risk)}`}>
      <div>
        <small>{candidate.mode}</small>
        <strong>{candidate.setup}</strong>
      </div>

      <span className={`v67Risk ${riskClass(candidate.risk)}`}>
        {candidate.risk}
      </span>

      <div className="v67SetupMetrics">
        <span>
          <small>Probability</small>
          <strong>{percent(candidate.probability)}</strong>
        </span>
        <span>
          <small>EV</small>
          <strong>
            {candidate.expectedValue >= 0 ? "+" : ""}
            {percent(candidate.expectedValue)}
          </strong>
        </span>
        <span>
          <small>Stability</small>
          <strong>{percent(candidate.stability)}</strong>
        </span>
        <span>
          <small>Confidence</small>
          <strong>{percent(candidate.confidence)}</strong>
        </span>
      </div>

      <p>{candidate.triggerText}</p>
    </div>
  );
}

export default function Analysis() {
  const {
    markets,
    market,
    symbol,
    connected,
    loadingMarket,
    statusDetail,
    prices,
    currentPrice,
    lastDigit,
    digitHistory,
    selectedAccountType,
    tradeBusy,
    tradeError,
    connect,
    disconnect,
    changeSymbol,
    placeTrade,
  } = useDerivTicks();

  const [tab, setTab] = useState("DIGITS");
  const [stake, setStake] = useState(0.35);
  const [duration, setDuration] = useState(1);
  const [tradeMessage, setTradeMessage] = useState("");

  const digitAnalysis = useMemo(
    () =>
      analyzeDigitSetups({
        digitHistory,
        allowHighRisk: false,
      }),
    [digitHistory]
  );

  const riseFall = useMemo(
    () =>
      analyzeRiseFall({
        prices,
        currentPrice,
      }),
    [prices, currentPrice]
  );

  const bestDigit = digitAnalysis.best;
  const bestTrade = digitTrade(bestDigit?.setup);

  async function ensureConnected() {
    if (!connected) {
      await connect();
    }
  }

  async function runDigitTrade() {
    setTradeMessage("");
    await ensureConnected();

    if (selectedAccountType !== "demo") {
      setTradeMessage("Analysis execution is Demo-only.");
      return;
    }

    if (!bestTrade || bestDigit?.risk !== "GOOD ENTRY") {
      setTradeMessage("No GOOD ENTRY digit setup is ready.");
      return;
    }

    try {
      const result = await placeTrade({
        symbol,
        contractType: bestTrade.contractType,
        barrier: bestTrade.barrier,
        amount: Math.max(0.35, Number(stake) || 0.35),
        basis: "stake",
        duration: Math.max(1, Math.min(10, Number(duration) || 1)),
        durationUnit: "t",
      });

      setTradeMessage(
        `${bestTrade.label} sent. Contract ${result?.contractId || "opened"}.`
      );
    } catch (error) {
      setTradeMessage(error instanceof Error ? error.message : "Trade failed.");
    }
  }

  async function runRiseFallTrade() {
    setTradeMessage("");
    await ensureConnected();

    if (selectedAccountType !== "demo") {
      setTradeMessage("Rise/Fall analysis execution is Demo-only.");
      return;
    }

    if (riseFall.risk !== "GOOD ENTRY" || riseFall.signal === "WAIT") {
      setTradeMessage("No GOOD ENTRY Rise/Fall setup is ready.");
      return;
    }

    try {
      const result = await placeTrade({
        symbol,
        contractType: riseFall.signal === "RISE" ? "CALL" : "PUT",
        amount: Math.max(0.35, Number(stake) || 0.35),
        basis: "stake",
        duration: Math.max(1, Math.min(10, Number(duration) || riseFall.duration || 5)),
        durationUnit: "t",
      });

      setTradeMessage(
        `${riseFall.signal} sent. Contract ${result?.contractId || "opened"}.`
      );
    } catch (error) {
      setTradeMessage(error instanceof Error ? error.message : "Trade failed.");
    }
  }

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent">
        <Topbar
          title="EdgePilot V67 · Unified Owner Analysis"
          subtitle="Digit trigger zones, Rise/Fall trend timing, risk labels and Demo execution"
          connected={connected}
          connecting={false}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section className="analysisToolbar">
          <MarketSelector
            markets={markets}
            value={symbol}
            disabled={loadingMarket}
            onChange={changeSymbol}
          />

          <div className="analysisFeedSummary">
            <span className={connected ? "liveDot" : "liveDot offline"} />
            <strong>{connected ? "LIVE" : "OFFLINE"}</strong>
            <span>{market?.label || "Deriv market"}</span>
          </div>
        </section>

        {statusDetail ? (
          <div className="analysisNotice error">{statusDetail}</div>
        ) : null}

        <div className="v67Tabs">
          <button
            className={tab === "DIGITS" ? "active" : ""}
            onClick={() => setTab("DIGITS")}
          >
            Digit Analysis
          </button>
          <button
            className={tab === "RISE_FALL" ? "active" : ""}
            onClick={() => setTab("RISE_FALL")}
          >
            Rise / Fall AI
          </button>
        </div>

        {tab === "DIGITS" ? (
          <>
            <section className="analysisHero">
              <div>
                <small>BEST CURRENT DIGIT SETUP</small>
                <h2>{bestDigit?.setup || "WAIT"}</h2>
                <p>{bestDigit?.triggerText || "Collecting live digit evidence."}</p>
              </div>

              <div className="analysisHeroMetrics">
                <div>
                  <small>Risk</small>
                  <strong>{bestDigit?.risk || "DO NOT TRADE"}</strong>
                </div>
                <div>
                  <small>Confidence</small>
                  <strong>{percent(bestDigit?.confidence)}</strong>
                </div>
                <div>
                  <small>Samples</small>
                  <strong>{digitAnalysis.sampleSize}</strong>
                </div>
                <div>
                  <small>Last digit</small>
                  <strong>{lastDigit ?? "—"}</strong>
                </div>
              </div>
            </section>

            <section className="v67SetupGrid">
              {digitAnalysis.standard.slice(0, 12).map((candidate) => (
                <SetupCard candidate={candidate} key={candidate.setup} />
              ))}
            </section>
          </>
        ) : (
          <>
            <section className="analysisHero">
              <div>
                <small>RISE / FALL ANALYSIS</small>
                <h2>{riseFall.signal}</h2>
                <p>{riseFall.instruction}</p>
              </div>

              <div className="analysisHeroMetrics">
                <div>
                  <small>Risk</small>
                  <strong>{riseFall.risk}</strong>
                </div>
                <div>
                  <small>Confidence</small>
                  <strong>{percent(riseFall.confidence)}</strong>
                </div>
                <div>
                  <small>Trend</small>
                  <strong>{riseFall.trend}</strong>
                </div>
                <div>
                  <small>Price</small>
                  <strong>{money(currentPrice)}</strong>
                </div>
              </div>
            </section>

            <section className="analysisGrid">
              <article className="analysisPanel">
                <div className="analysisPanelHeader">
                  <div>
                    <small>TREND ENGINE</small>
                    <h3>Current direction</h3>
                  </div>
                  <span className={`v67Risk ${riskClass(riseFall.risk)}`}>
                    {riseFall.risk}
                  </span>
                </div>

                <div className="analysisMetricGrid">
                  <div>
                    <small>Signal</small>
                    <strong>{riseFall.signal}</strong>
                  </div>
                  <div>
                    <small>Momentum</small>
                    <strong>{money(riseFall.momentum)}</strong>
                  </div>
                  <div>
                    <small>Support</small>
                    <strong>{money(riseFall.support)}</strong>
                  </div>
                  <div>
                    <small>Resistance</small>
                    <strong>{money(riseFall.resistance)}</strong>
                  </div>
                  <div>
                    <small>Entry level</small>
                    <strong>{money(riseFall.entryPrice)}</strong>
                  </div>
                  <div>
                    <small>Duration</small>
                    <strong>{riseFall.duration || 5} ticks</strong>
                  </div>
                </div>
              </article>

              <article className="analysisPanel">
                <div className="analysisPanelHeader">
                  <div>
                    <small>ENTRY TIMING</small>
                    <h3>{riseFall.signal === "WAIT" ? "Wait for alignment" : "Conditional entry"}</h3>
                  </div>
                </div>

                <div className="v67EntryInstruction">
                  <strong>{riseFall.signal}</strong>
                  <p>{riseFall.instruction}</p>
                  <span>
                    GOOD ENTRY is shown only when trend, momentum and price position agree.
                  </span>
                </div>
              </article>
            </section>
          </>
        )}

        <section className="analysisPanel analysisRunPanel v67RunPanel">
          <div className="analysisPanelHeader">
            <div>
              <small>DEMO EXECUTION</small>
              <h3>Run selected setup</h3>
            </div>
            <span>
              {tab === "DIGITS"
                ? bestDigit?.risk || "WAIT"
                : riseFall.risk}
            </span>
          </div>

          <div className="analysisRunFields">
            <label>
              <span>Stake</span>
              <input
                type="number"
                min="0.35"
                step="0.01"
                value={stake}
                onChange={(event) => setStake(event.target.value)}
              />
            </label>

            <label>
              <span>Duration (ticks)</span>
              <input
                type="number"
                min="1"
                max="10"
                value={duration}
                onChange={(event) => setDuration(event.target.value)}
              />
            </label>
          </div>

          <div className="analysisRunActions">
            <button
              className="analysisRunButton"
              disabled={
                tradeBusy ||
                (tab === "DIGITS"
                  ? bestDigit?.risk !== "GOOD ENTRY"
                  : riseFall.risk !== "GOOD ENTRY")
              }
              onClick={
                tab === "DIGITS"
                  ? runDigitTrade
                  : runRiseFallTrade
              }
            >
              {tradeBusy
                ? "Opening trade..."
                : tab === "DIGITS"
                  ? `Run ${bestDigit?.setup || "Best Digit Trade"}`
                  : `Run ${riseFall.signal}`}
            </button>
          </div>

          <div className="analysisNotice">
            {tradeMessage ||
              tradeError ||
              "Only GOOD ENTRY setups can be executed from this page. No strategy guarantees a win."}
          </div>
        </section>
      </main>
    </div>
  );
}
