
import { useEffect, useMemo, useRef, useState } from "react";

import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { analyzeUnifiedSignals } from "../analysis/v71UnifiedSignalEngine";
import "../styles/Analysis.css";

function percent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)}%` : "0.0%";
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(3) : "—";
}

function tradeFromCandidate(candidate) {
  if (!candidate) return null;

  const mode = String(candidate.mode || "").toUpperCase();

  if (mode === "OVER") {
    return {
      label: candidate.setup,
      contractType: "DIGITOVER",
      barrier: String(candidate.prediction),
    };
  }

  if (mode === "UNDER") {
    return {
      label: candidate.setup,
      contractType: "DIGITUNDER",
      barrier: String(candidate.prediction),
    };
  }

  if (mode === "EVEN") {
    return {
      label: "EVEN",
      contractType: "DIGITEVEN",
    };
  }

  if (mode === "ODD") {
    return {
      label: "ODD",
      contractType: "DIGITODD",
    };
  }

  if (mode === "DIFFERS") {
    return {
      label: candidate.setup,
      contractType: "DIGITDIFF",
      barrier: String(candidate.prediction),
    };
  }

  return null;
}

function candidateTone(candidate) {
  if (candidate?.executable) return "good";
  if (Number(candidate?.qualityScore || 0) >= 80) return "risky";
  return "blocked";
}

function CandidateCard({ candidate }) {
  const tone = candidateTone(candidate);

  return (
    <article className={`v67SetupCard ${tone}`}>
      <div>
        <small>{candidate.mode || "DIGIT"}</small>
        <strong>{candidate.setup || "WAIT"}</strong>
      </div>

      <span className={`v67Risk ${tone}`}>
        {candidate.executable ? "READY" : "WAIT"}
      </span>

      <div className="v67SetupMetrics">
        <span>
          <small>Probability</small>
          <strong>{percent(candidate.probability)}</strong>
        </span>
        <span>
          <small>Quality</small>
          <strong>{percent(candidate.qualityScore)}</strong>
        </span>
        <span>
          <small>Stability</small>
          <strong>{percent(candidate.stability)}</strong>
        </span>
        <span>
          <small>History LB</small>
          <strong>{percent(candidate.historicalLowerBound)}</strong>
        </span>
      </div>

      <p>{candidate.reason || "Collecting calibrated evidence."}</p>
    </article>
  );
}

export default function Analysis() {
  const {
    markets = [],
    market = null,
    symbol = "",
    connected = false,
    loadingMarket = false,
    statusDetail = "",
    prices = [],
    currentPrice = null,
    lastDigit = null,
    digitHistory = [],
    selectedAccountType = "demo",
    tradeBusy = false,
    tradeError = "",
    connect,
    disconnect,
    changeSymbol,
    placeTrade,
  } = useDerivTicks();

  const [stake, setStake] = useState(0.35);
  const [tradeMessage, setTradeMessage] = useState("");
  const [feedMessage, setFeedMessage] = useState("Connecting Deriv feed...");
  const connectBusyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let retryTimer = null;

    async function ensureFeed() {
      if (
        cancelled ||
        connected ||
        connectBusyRef.current ||
        typeof connect !== "function"
      ) {
        return;
      }

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
          retryTimer = window.setTimeout(ensureFeed, 3000);
        }
      }
    }

    if (connected) {
      setFeedMessage("Deriv live feed connected.");
    } else {
      void ensureFeed();
    }

    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [connected, connect]);

  const unified = useMemo(() => {
    try {
      return analyzeUnifiedSignals({
        digitHistory: Array.isArray(digitHistory) ? digitHistory : [],
        prices: Array.isArray(prices) ? prices : [],
        currentPrice,
        minimumConfidence: 90,
      });
    } catch (error) {
      console.error("[V53] Analysis engine error", error);

      return {
        digit: {
          candidates: [],
          best: null,
          executable: false,
          sampleSize: Array.isArray(digitHistory)
            ? digitHistory.length
            : 0,
          currentDigit: lastDigit,
          reason:
            error instanceof Error
              ? error.message
              : "Analysis engine failed safely.",
        },
      };
    }
  }, [digitHistory, prices, currentPrice, lastDigit]);

  const digitAnalysis = unified?.digit || {};
  const candidates = Array.isArray(digitAnalysis.candidates)
    ? digitAnalysis.candidates
    : [];
  const best = digitAnalysis.best || null;
  const bestTrade = tradeFromCandidate(best);

  const distribution = useMemo(() => {
    const counts = Array(10).fill(0);
    const safeDigits = Array.isArray(digitHistory) ? digitHistory : [];

    safeDigits.forEach((value) => {
      const digit = Number(value);
      if (Number.isInteger(digit) && digit >= 0 && digit <= 9) {
        counts[digit] += 1;
      }
    });

    const total = Math.max(
      1,
      counts.reduce((sum, value) => sum + value, 0)
    );

    return counts.map((count, digit) => ({
      digit,
      count,
      percent: (count / total) * 100,
    }));
  }, [digitHistory]);

  async function runBestTrade() {
    setTradeMessage("");

    if (!connected && typeof connect === "function") {
      await connect();
    }

    if (selectedAccountType !== "demo") {
      setTradeMessage("Analysis execution remains Demo-only.");
      return;
    }

    if (!best?.executable || !bestTrade) {
      setTradeMessage("No calibrated digit entry is ready.");
      return;
    }

    if (typeof placeTrade !== "function") {
      setTradeMessage("Trade function is unavailable.");
      return;
    }

    try {
      const result = await placeTrade({
        symbol,
        contractType: bestTrade.contractType,
        barrier: bestTrade.barrier,
        amount: Math.max(0.35, Number(stake) || 0.35),
        basis: "stake",
        duration: 1,
        durationUnit: "t",
      });

      setTradeMessage(
        `${bestTrade.label} sent. Contract ${
          result?.contractId || "opened"
        }.`
      );
    } catch (error) {
      setTradeMessage(
        error instanceof Error ? error.message : "Trade failed."
      );
    }
  }

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent">
        <Topbar
          title="EdgePilot V53 · Calibrated Digit Analysis"
          subtitle="Adaptive transitions, historical lower bounds and digits-only signals"
          connected={connected}
          connecting={false}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section className="analysisToolbar">
          <MarketSelector
            markets={Array.isArray(markets) ? markets : []}
            value={symbol}
            disabled={loadingMarket}
            onChange={changeSymbol}
          />

          <div className="analysisFeedSummary">
            <span className={connected ? "liveDot" : "liveDot offline"} />
            <strong>{connected ? "LIVE" : "OFFLINE"}</strong>
            <span>{market?.label || symbol || "Deriv market"}</span>
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

        <section className="analysisHero">
          <div>
            <small>BEST CALIBRATED DIGIT SETUP</small>
            <h2>{best?.setup || "WAIT"}</h2>
            <p>
              {best?.reason ||
                digitAnalysis.reason ||
                "Collecting calibrated digit evidence."}
            </p>
          </div>

          <div className="analysisHeroMetrics">
            <div>
              <small>Status</small>
              <strong>{best?.executable ? "READY" : "WAIT"}</strong>
            </div>
            <div>
              <small>Probability</small>
              <strong>{percent(best?.probability)}</strong>
            </div>
            <div>
              <small>Samples</small>
              <strong>{digitAnalysis.sampleSize || 0}</strong>
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
              <span>{digitAnalysis.sampleSize || 0} ticks</span>
            </div>

            <div className="v68HeatRows">
              {distribution.map((item) => (
                <div key={item.digit}>
                  <strong>{item.digit}</strong>
                  <span>
                    <i
                      style={{
                        width: `${Math.max(2, item.percent)}%`,
                      }}
                    />
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
              {(Array.isArray(digitHistory) ? digitHistory : [])
                .slice(-30)
                .map((digit, index) => (
                  <span key={`${digit}-${index}`}>{digit}</span>
                ))}

              {!digitHistory?.length ? (
                <em>Waiting for live ticks…</em>
              ) : null}
            </div>

            <div className="analysisMetricGrid">
              <div>
                <small>Price</small>
                <strong>{money(currentPrice)}</strong>
              </div>
              <div>
                <small>Market</small>
                <strong>{market?.short || market?.label || "—"}</strong>
              </div>
              <div>
                <small>Executable setups</small>
                <strong>
                  {candidates.filter((candidate) => candidate.executable).length}
                </strong>
              </div>
              <div>
                <small>Engine</small>
                <strong>V52 CALIBRATED</strong>
              </div>
            </div>
          </article>
        </section>

        <section className="v67SetupGrid">
          {candidates.slice(0, 18).map((candidate) => (
            <CandidateCard
              candidate={candidate}
              key={candidate.setup}
            />
          ))}

          {!candidates.length ? (
            <article className="analysisPanel">
              <p>
                No candidates were returned. The page stayed active and
                reported the problem instead of rendering blank.
              </p>
            </article>
          ) : null}
        </section>

        <section className="analysisPanel">
          <div className="analysisPanelHeader">
            <div>
              <small>DEMO EXECUTION</small>
              <h3>Run the calibrated setup manually</h3>
            </div>
          </div>

          <div className="analysisTradeControls">
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

            <button
              type="button"
              onClick={runBestTrade}
              disabled={
                tradeBusy ||
                !best?.executable ||
                !bestTrade ||
                selectedAccountType !== "demo"
              }
            >
              {tradeBusy
                ? "Sending..."
                : bestTrade
                  ? `Trade ${bestTrade.label}`
                  : "No entry"}
            </button>
          </div>

          <p>
            {tradeMessage ||
              tradeError ||
              "Rise/Fall is disabled. This page uses calibrated digit contracts only."}
          </p>
        </section>
      </main>
    </div>
  );
}
