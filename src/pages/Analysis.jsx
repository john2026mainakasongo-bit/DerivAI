
import { useMemo, useState } from "react";

import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { analyzeMarket } from "../analysis/analysisEngine";
import { buildValidatedSignals } from "../analysis/backtestEngine";
import { buildEntryTiming } from "../analysis/entryTimingEngine";
import "../styles/Analysis.css";

function percent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)}%` : "0.0%";
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(3) : "—";
}

function signalToTrade(signal = "") {
  const text = String(signal || "").trim().toUpperCase();

  const over = text.match(/^OVER\s+([0-9])$/);
  if (over) {
    return {
      label: text,
      contractType: "DIGITOVER",
      barrier: over[1],
    };
  }

  const under = text.match(/^UNDER\s+([0-9])$/);
  if (under) {
    return {
      label: text,
      contractType: "DIGITUNDER",
      barrier: under[1],
    };
  }

  const match = text.match(/^MATCH\s+([0-9])$/);
  if (match) {
    return {
      label: text,
      contractType: "DIGITMATCH",
      barrier: match[1],
    };
  }

  const differs = text.match(/^DIFFERS\s+([0-9])$/);
  if (differs) {
    return {
      label: text,
      contractType: "DIGITDIFF",
      barrier: differs[1],
    };
  }

  return null;
}

function SignalCard({ title, signal, detail }) {
  const active = signal && signal !== "WAIT";

  return (
    <div className={`analysisSignalCard ${active ? "active" : ""}`}>
      <small>{title}</small>
      <strong>{signal || "WAIT"}</strong>
      <p>{detail || "Collecting live market data."}</p>
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

  const [stake, setStake] = useState(0.35);
  const [duration, setDuration] = useState(1);
  const [tradeMessage, setTradeMessage] = useState("");

  const snapshot = useMemo(
    () => ({
      digitHistory,
      prices,
      currentPrice,
      lastDigit,
    }),
    [digitHistory, prices, currentPrice, lastDigit]
  );

  const analysis = useMemo(
    () => analyzeMarket(snapshot),
    [snapshot]
  );

  const validated = useMemo(
    () => buildValidatedSignals(snapshot),
    [snapshot]
  );

  const timing = useMemo(
    () =>
      buildEntryTiming(validated, snapshot, {
        tradeTicks: duration,
        validitySeconds: 15,
      }),
    [validated, snapshot, duration]
  );

  const digitSignals = useMemo(() => {
    const candidates = [
      analysis.signals?.threshold,
      analysis.signals?.matchDiff,
      analysis.signals?.parity,
    ].filter(Boolean);

    return candidates
      .filter((item) => item.signal !== "WAIT")
      .filter((item) => signalToTrade(item.signal))
      .sort(
        (left, right) =>
          Number(right.confidence || 0) -
          Number(left.confidence || 0)
      );
  }, [analysis]);

  const bestSignal =
    validated.best?.approved &&
    signalToTrade(validated.best.action)
      ? {
          signal: validated.best.action,
          confidence: validated.best.lowerBound,
          detail: validated.best.reason,
          source: "BACKTEST VALIDATED",
        }
      : digitSignals[0]
      ? {
          ...digitSignals[0],
          source: "LIVE ANALYSIS",
        }
      : null;

  const bestTrade = signalToTrade(bestSignal?.signal);

  async function runBestTrade() {
    setTradeMessage("");

    if (!connected) {
      await connect();
    }

    if (selectedAccountType !== "demo") {
      setTradeMessage(
        "V50 is locked to Demo while the new analysis flow is being tested."
      );
      return;
    }

    if (!bestTrade) {
      setTradeMessage(
        "No supported Over, Under, Match or Differs setup is ready yet."
      );
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
        `${bestTrade.label} sent successfully. Contract ${
          result?.contractId || "opened"
        }.`
      );
    } catch (error) {
      setTradeMessage(
        error instanceof Error ? error.message : "Trade failed."
      );
    }
  }

  async function copySignal() {
    const text = bestTrade
      ? `${bestTrade.label} | Confidence ${percent(
          bestSignal?.confidence
        )} | ${market?.label || symbol}`
      : "WAIT — no supported digit setup yet";

    await navigator.clipboard?.writeText(text);
    setTradeMessage("Signal copied.");
  }

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent">
        <Topbar
          title="EdgePilot V50 · Owner Digit Analysis"
          subtitle="Live Over/Under, Matches/Differs statistics and one-click Demo execution"
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
            <span>{market?.label || "Connect Deriv feed"}</span>
          </div>
        </section>

        {statusDetail ? (
          <div className="analysisNotice error">{statusDetail}</div>
        ) : null}

        <section className="analysisHero">
          <div>
            <small>BEST CURRENT DIGIT SETUP</small>
            <h2>{bestTrade?.label || "WAIT"}</h2>
            <p>
              {bestSignal?.detail ||
                "Collecting enough live digits to identify the strongest supported setup."}
            </p>
          </div>

          <div className="analysisHeroMetrics">
            <div>
              <small>Confidence</small>
              <strong>{percent(bestSignal?.confidence)}</strong>
            </div>
            <div>
              <small>Samples</small>
              <strong>{analysis.sampleSize}</strong>
            </div>
            <div>
              <small>Last digit</small>
              <strong>{lastDigit ?? "—"}</strong>
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
                <small>LIVE DIGITS</small>
                <h3>Distribution 0–9</h3>
              </div>
              <span>{analysis.sampleSize} samples</span>
            </div>

            <div className="digitDistributionGrid">
              {analysis.distribution.map((item) => (
                <div
                  className={
                    item.digit === lastDigit
                      ? "digitDistributionItem current"
                      : "digitDistributionItem"
                  }
                  key={item.digit}
                >
                  <strong>{item.digit}</strong>
                  <span>{percent(item.percent)}</span>
                  <div className="digitBar">
                    <i style={{ width: `${Math.min(100, item.percent * 5)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </article>

          <article className="analysisPanel">
            <div className="analysisPanelHeader">
              <div>
                <small>CONTRACT ANALYSIS</small>
                <h3>Live setup comparison</h3>
              </div>
            </div>

            <div className="analysisSignalGrid">
              <SignalCard
                title="OVER / UNDER"
                signal={analysis.signals?.threshold?.signal}
                detail={analysis.signals?.threshold?.detail}
              />
              <SignalCard
                title="MATCHES / DIFFERS"
                signal={analysis.signals?.matchDiff?.signal}
                detail={analysis.signals?.matchDiff?.detail}
              />
              <SignalCard
                title="EVEN / ODD"
                signal={analysis.signals?.parity?.signal}
                detail={analysis.signals?.parity?.detail}
              />
              <SignalCard
                title="ENTRY TIMING"
                signal={timing.state}
                detail={timing.instruction}
              />
            </div>
          </article>

          <article className="analysisPanel">
            <div className="analysisPanelHeader">
              <div>
                <small>MARKET QUALITY</small>
                <h3>Current evidence</h3>
              </div>
            </div>

            <div className="analysisMetricGrid">
              <div>
                <small>Entropy</small>
                <strong>{percent(Number(analysis.entropy?.normalized || 0) * 100)}</strong>
              </div>
              <div>
                <small>Even</small>
                <strong>{percent(analysis.parity?.evenPercent)}</strong>
              </div>
              <div>
                <small>Odd</small>
                <strong>{percent(analysis.parity?.oddPercent)}</strong>
              </div>
              <div>
                <small>Over 2</small>
                <strong>{percent(analysis.threshold2?.overPercent)}</strong>
              </div>
              <div>
                <small>Under 2</small>
                <strong>{percent(analysis.threshold2?.underPercent)}</strong>
              </div>
              <div>
                <small>Best digit</small>
                <strong>{analysis.bestDigit?.digit ?? "—"}</strong>
              </div>
            </div>
          </article>

          <article className="analysisPanel analysisRunPanel">
            <div className="analysisPanelHeader">
              <div>
                <small>DEMO EXECUTION</small>
                <h3>Run selected setup</h3>
              </div>
              <span>{bestSignal?.source || "WAIT"}</span>
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
                disabled={tradeBusy || !bestTrade}
                onClick={runBestTrade}
              >
                {tradeBusy
                  ? "Opening trade..."
                  : `Run ${bestTrade?.label || "Best Trade"}`}
              </button>

              <button
                className="analysisCopyButton"
                onClick={copySignal}
              >
                Copy Signal
              </button>
            </div>

            <div className="analysisNotice">
              {tradeMessage ||
                tradeError ||
                "This page executes one Demo trade at a time. No strategy guarantees a win."}
            </div>
          </article>
        </section>
      </main>
    </div>
  );
}
