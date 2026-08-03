
import { useEffect, useMemo, useRef, useState } from "react";

import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import {
  analyzeUnifiedSignals,
} from "../analysis/v71UnifiedSignalEngine";
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
  const [feedMessage, setFeedMessage] = useState("Connecting Deriv feed...");
  const connectBusyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let retryTimer;

    async function ensureLiveFeed() {
      if (cancelled || connected || connectBusyRef.current) return;

      connectBusyRef.current = true;
      setFeedMessage("Connecting authenticated Deriv feed...");

      try {
        await connect();

        if (!cancelled) {
          setFeedMessage("Deriv feed connection requested.");
        }
      } catch (error) {
        if (!cancelled) {
          setFeedMessage(
            error instanceof Error
              ? `Feed connection failed: ${error.message}`
              : "Feed connection failed. Retrying..."
          );
        }
      } finally {
        connectBusyRef.current = false;

        if (!cancelled && !connected) {
          retryTimer = window.setTimeout(ensureLiveFeed, 2500);
        }
      }
    }

    if (connected) {
      setFeedMessage("Deriv live feed connected.");
    } else {
      void ensureLiveFeed();
    }

    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [connected, connect]);

  const unifiedSignals = useMemo(
    () =>
      analyzeUnifiedSignals({
        digitHistory,
        prices,
        currentPrice,
        allowHighRisk: false,
        minimumConfidence: 78,
      }),
    [digitHistory, prices, currentPrice]
  );

  const digitAnalysis = unifiedSignals.digit;
  const riseFall = unifiedSignals.riseFall;

  const bestDigit = digitAnalysis.best;
  const bestTrade = digitTrade(bestDigit?.setup);

  const digitDistribution = useMemo(() => {
    const counts = Array.from({ length: 10 }, () => 0);
    digitHistory.forEach((value) => {
      const digit = Number(value);
      if (Number.isInteger(digit) && digit >= 0 && digit <= 9) {
        counts[digit] += 1;
      }
    });

    const total = Math.max(1, counts.reduce((sum, value) => sum + value, 0));

    return counts.map((count, digit) => ({
      digit,
      count,
      percent: (count / total) * 100,
    }));
  }, [digitHistory]);

  const marketMode = useMemo(() => {
    const standard = digitAnalysis.standard.slice(0, 8);
    if (!standard.length || digitAnalysis.sampleSize < 25) return "COLLECTING";

    const averageStability =
      standard.reduce((sum, item) => sum + Number(item.stability || 0), 0) /
      standard.length;

    const executableCount = standard.filter((item) => item.executable).length;

    if (averageStability >= 78 && executableCount >= 2) return "CLEAN";
    if (averageStability >= 62) return "RANGING";
    return "CHAOTIC";
  }, [digitAnalysis]);

  const ownerAi = useMemo(() => {
    if (!connected) {
      return {
        action: "CONNECTING",
        detail: "Reconnecting the authenticated Deriv feed.",
        waitSeconds: 0,
      };
    }

    if (digitAnalysis.sampleSize < 40) {
      return {
        action: "WAIT",
        detail: `Collecting evidence: ${digitAnalysis.sampleSize}/40 ticks.`,
        waitSeconds: Math.max(1, Math.ceil((40 - digitAnalysis.sampleSize) / 4)),
      };
    }

    if (bestDigit?.risk === "GOOD ENTRY") {
      return {
        action: `ENTER ${bestDigit.setup}`,
        detail: bestDigit.triggerText,
        waitSeconds: 0,
      };
    }

    return {
      action: "AVOID TRADING",
      detail:
        marketMode === "CHAOTIC"
          ? "Market is unstable. Wait for stronger stability and positive EV."
          : "No contract currently passes the GOOD ENTRY gate.",
      waitSeconds: marketMode === "CHAOTIC" ? 12 : 6,
    };
  }, [
    connected,
    digitAnalysis.sampleSize,
    bestDigit,
    marketMode,
  ]);

  async function ensureConnected() {
    if (connected) return;

    await connect();
    await new Promise((resolve) => setTimeout(resolve, 900));
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
          title="EdgePilot V73 · Stable Unified Analysis"
          subtitle="Shared socket and idempotent subscriptions across Analysis and Auto Bot"
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

        <div
          className={`analysisNotice ${
            connected ? "v69FeedLive" : "v69FeedWaiting"
          }`}
        >
          {connected
            ? `LIVE FEED · ${market?.label || symbol || "Deriv market"}`
            : feedMessage}
        </div>

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

            <section className="v68DashboardGrid">
              <article className="analysisPanel v68Heatmap">
                <div className="analysisPanelHeader">
                  <div>
                    <small>DIGIT HEATMAP</small>
                    <h3>Live distribution 0–9</h3>
                  </div>
                  <span>{digitAnalysis.sampleSize} ticks</span>
                </div>

                <div className="v68HeatRows">
                  {digitDistribution.map((item) => (
                    <div key={item.digit}>
                      <strong>{item.digit}</strong>
                      <span>
                        <i style={{ width: `${Math.max(2, item.percent)}%` }} />
                      </span>
                      <small>{item.percent.toFixed(1)}%</small>
                    </div>
                  ))}
                </div>
              </article>

              <article className="analysisPanel">
                <div className="analysisPanelHeader">
                  <div>
                    <small>LIVE DIGIT FLOW</small>
                    <h3>Most recent digits</h3>
                  </div>
                </div>

                <div className="v68DigitFlow">
                  {digitHistory.slice(-30).map((digit, index) => (
                    <span key={`${digit}-${index}`}>{digit}</span>
                  ))}
                  {!digitHistory.length ? <em>Waiting for live ticks…</em> : null}
                </div>

                <div className="v68ModeRow">
                  <div>
                    <small>MARKET MODE</small>
                    <strong>{marketMode}</strong>
                  </div>
                  <div>
                    <small>OWNER AI</small>
                    <strong>{ownerAi.action}</strong>
                  </div>
                </div>

                <div className="v68OwnerMessage">
                  <p>{ownerAi.detail}</p>
                  {ownerAi.waitSeconds > 0 ? (
                    <span>Recheck in about {ownerAi.waitSeconds}s</span>
                  ) : null}
                </div>
              </article>
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

            <section className="v70RiseSummary">
              <div>
                <small>DIRECTION</small>
                <strong>{riseFall.signal}</strong>
              </div>
              <div>
                <small>ENTRY QUALITY</small>
                <strong className={riskClass(riseFall.risk)}>
                  {riseFall.risk}
                </strong>
              </div>
              <div>
                <small>CONFIDENCE</small>
                <strong>{percent(riseFall.confidence)}</strong>
              </div>
              <div>
                <small>TREND</small>
                <strong>{riseFall.trend}</strong>
              </div>
              <div>
                <small>ENTRY LEVEL</small>
                <strong>{money(riseFall.entryPrice)}</strong>
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
