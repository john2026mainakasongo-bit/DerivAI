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
import { analyzeDiffersOneShot } from "../analysis/differsOneShotAnalysis";
import "../styles/DiffersOneShotBot.css";

function contractIdOf(value = {}) {
  return String(
    value.contract_id ||
      value.contractId ||
      value.id ||
      ""
  );
}

function settledContract(value = {}) {
  const status = String(value.status || "").toLowerCase();

  return Boolean(
    value.is_sold ||
      value.is_expired ||
      ["won", "lost", "sold", "expired"].includes(status)
  );
}

function contractProfit(value = {}) {
  const profit = Number(
    value.profit ??
      value.profit_loss ??
      value.pnl ??
      (Number(value.sell_price || 0) -
        Number(value.buy_price || 0))
  );

  return Number.isFinite(profit) ? profit : 0;
}

function resultOf(value = {}) {
  const status = String(value.status || "").toUpperCase();
  const profit = contractProfit(value);

  if (status === "WON" || profit > 0) return "WON";
  if (status === "LOST" || profit < 0) return "LOST";
  return "CLOSED";
}

function pct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function lastDigitFromQuote(value, decimals = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;

  const text = numeric
    .toFixed(Math.max(0, Number(decimals) || 0))
    .replace(/\D/g, "");

  return text ? Number(text.at(-1)) : null;
}

function adaptiveRequirements(elapsedMs = 0) {
  if (elapsedMs >= 90000) {
    return {
      confidence: 80,
      safety: 76,
      matchRisk: 13,
      transitionRisk: 20,
      stable: 2,
      fresh: 4,
      label: "ADAPTIVE",
    };
  }

  if (elapsedMs >= 45000) {
    return {
      confidence: 81,
      safety: 77,
      matchRisk: 12.8,
      transitionRisk: 19,
      stable: 2,
      fresh: 5,
      label: "BALANCED",
    };
  }

  return {
    confidence: 82,
    safety: 78,
    matchRisk: 12.5,
    transitionRisk: 18,
    stable: 3,
    fresh: 6,
    label: "STRICT",
  };
}

export default function DiffersOneShotBot() {
  const {
    markets = [],
    market = null,
    symbol = "",
    connected = false,
    loadingMarket = false,
    digitHistory = [],
    ticks = [],
    currentPrice = null,
    selectedAccountType = "demo",
    selectedAccountId = "",
    openContracts = [],
    tradeBusy = false,
    tradeError = "",
    connect,
    disconnect,
    changeSymbol,
    placeTrade,
    refreshContract,
  } = useDerivTicks();

  const [stake, setStake] = useState(0.35);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("STOPPED");
  const [message, setMessage] = useState(
    "One-shot Differs bot is ready."
  );
  const [contractId, setContractId] = useState("");
  const [result, setResult] = useState("");
  const [profit, setProfit] = useState(0);
  const [entry, setEntry] = useState(null);
  const [scanStartedAt, setScanStartedAt] = useState(0);
  const [marketStartedAt, setMarketStartedAt] = useState(0);
  const [marketSwitches, setMarketSwitches] = useState(0);
  const [freshDigits, setFreshDigits] = useState([]);
  const [stableCandidateTicks, setStableCandidateTicks] = useState(0);
  const [stableCandidateDigit, setStableCandidateDigit] = useState(null);
  const [marketScores, setMarketScores] = useState({});
  const [clock, setClock] = useState(Date.now());

  const executionRef = useRef(false);
  const completedRef = useRef(false);
  const switchingRef = useRef(false);
  const lastFreshTickKeyRef = useRef("");

  const combinedDigits = useMemo(
    () =>
      [
        ...(Array.isArray(digitHistory)
          ? digitHistory.slice(-80)
          : []),
        ...freshDigits,
      ].slice(-140),
    [digitHistory, freshDigits]
  );

  const analysis = useMemo(
    () => analyzeDiffersOneShot(combinedDigits),
    [combinedDigits]
  );

  const elapsedMs = running
    ? Math.max(0, clock - scanStartedAt)
    : 0;

  const requirements = useMemo(
    () => adaptiveRequirements(elapsedMs),
    [elapsedMs]
  );

  const qualified =
    analysis.selectedDigit !== null &&
    analysis.confidence >= requirements.confidence &&
    analysis.safetyScore >= requirements.safety &&
    analysis.estimatedMatchProbability <= requirements.matchRisk &&
    analysis.transitionRisk <= requirements.transitionRisk &&
    freshDigits.length >= requirements.fresh &&
    stableCandidateTicks >= requirements.stable;

  useEffect(() => {
    if (!running) return undefined;

    const timer = window.setInterval(() => {
      setClock(Date.now());
    }, 500);

    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (connected) return;

    void Promise.resolve(connect()).catch((error) => {
      setStatus("ERROR");
      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to connect to Deriv."
      );
    });
  }, [connected, connect]);

  async function start() {
    if (running || tradeBusy || executionRef.current) return;

    if (!selectedAccountId) {
      setStatus("ERROR");
      setMessage("Choose a logged-in Demo or Real account first.");
      return;
    }

    try {
      if (!connected) await connect();

      const now = Date.now();

      completedRef.current = false;
      executionRef.current = false;
      setContractId("");
      setResult("");
      setProfit(0);
      setEntry(null);
      setMarketSwitches(0);
      setMarketScores({});
      setFreshDigits([]);
      setStableCandidateTicks(0);
      setStableCandidateDigit(null);
      lastFreshTickKeyRef.current = "";
      setScanStartedAt(now);
      setMarketStartedAt(now);
      setClock(now);
      setRunning(true);
      setStatus("SCANNING");
      setMessage(
        "Fast market scan started. Comparing digit frequency, transitions, match risk and stability."
      );
    } catch (error) {
      setStatus("ERROR");
      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to start the bot."
      );
    }
  }

  function stop(reason = "Bot stopped.") {
    completedRef.current = true;
    executionRef.current = false;
    setRunning(false);
    setStatus("STOPPED");
    setMessage(reason);
  }

  useEffect(() => {
    if (
      !running ||
      completedRef.current ||
      contractId ||
      !scanStartedAt ||
      !ticks.length
    ) {
      return;
    }

    const tick = ticks.at(-1);
    const rawEpoch = Number(tick?.epoch || 0);
    const epochMs =
      rawEpoch > 0 && rawEpoch < 1e12
        ? rawEpoch * 1000
        : rawEpoch;

    if (epochMs && epochMs < marketStartedAt) return;

    const key = `${symbol}:${tick?.epoch || ""}:${tick?.quote || ""}`;

    if (!key || lastFreshTickKeyRef.current === key) return;

    lastFreshTickKeyRef.current = key;

    const digit = lastDigitFromQuote(
      tick?.quote,
      market?.decimals || 3
    );

    if (!Number.isInteger(digit)) return;

    setFreshDigits((current) => [...current, digit].slice(-40));
  }, [
    running,
    contractId,
    scanStartedAt,
    marketStartedAt,
    ticks,
    symbol,
    market?.decimals,
  ]);

  useEffect(() => {
    if (!running || contractId || analysis.selectedDigit === null) {
      setStableCandidateTicks(0);
      setStableCandidateDigit(null);
      return;
    }

    if (analysis.selectedDigit === stableCandidateDigit) {
      setStableCandidateTicks((value) => value + 1);
      return;
    }

    setStableCandidateDigit(analysis.selectedDigit);
    setStableCandidateTicks(1);
  }, [
    running,
    contractId,
    analysis.selectedDigit,
    stableCandidateDigit,
  ]);

  useEffect(() => {
    if (!running || !symbol || analysis.selectedDigit === null) return;

    setMarketScores((current) => ({
      ...current,
      [symbol]: {
        symbol,
        label: market?.label || symbol,
        quality: analysis.marketQuality,
        confidence: analysis.confidence,
        safety: analysis.safetyScore,
        digit: analysis.selectedDigit,
        matchRisk: analysis.estimatedMatchProbability,
        transitionRisk: analysis.transitionRisk,
        updatedAt: Date.now(),
      },
    }));
  }, [
    running,
    symbol,
    market?.label,
    analysis.selectedDigit,
    analysis.marketQuality,
    analysis.confidence,
    analysis.safetyScore,
    analysis.estimatedMatchProbability,
    analysis.transitionRisk,
  ]);

  useEffect(() => {
    if (
      !running ||
      completedRef.current ||
      executionRef.current ||
      tradeBusy ||
      contractId ||
      !connected ||
      loadingMarket ||
      !qualified
    ) {
      return;
    }

    executionRef.current = true;
    setStatus("BUYING");
    setMessage(
      `Qualified ${requirements.label} setup found: DIFFERS ${analysis.selectedDigit}. Buying one contract.`
    );

    void (async () => {
      try {
        const response = await placeTrade({
          symbol,
          contractType: "DIGITDIFF",
          amount: Math.max(0.35, Number(stake) || 0.35),
          basis: "stake",
          duration: 1,
          durationUnit: "t",
          barrier: String(analysis.selectedDigit),
        });

        const id = contractIdOf(response);

        if (!id) {
          throw new Error("Deriv did not return a contract ID.");
        }

        setEntry({
          digit: analysis.selectedDigit,
          confidence: analysis.confidence,
          safetyScore: analysis.safetyScore,
          probability: analysis.differsProbability,
          matchRisk: analysis.estimatedMatchProbability,
          transitionRisk: analysis.transitionRisk,
          market: market?.label || symbol,
          time: Date.now(),
        });

        setContractId(id);
        setStatus("OPEN");
        setMessage(
          `DIFFERS ${analysis.selectedDigit} is open. Waiting for settlement.`
        );

        await refreshContract(id);
      } catch (error) {
        executionRef.current = false;
        setRunning(false);
        setStatus("ERROR");
        setMessage(
          error instanceof Error
            ? error.message
            : "The one-shot trade failed."
        );
      }
    })();
  }, [
    running,
    connected,
    loadingMarket,
    tradeBusy,
    contractId,
    qualified,
    requirements.label,
    analysis,
    placeTrade,
    refreshContract,
    stake,
    symbol,
    market?.label,
  ]);

  useEffect(() => {
    if (
      !running ||
      completedRef.current ||
      executionRef.current ||
      contractId ||
      !connected ||
      loadingMarket ||
      markets.length < 2 ||
      switchingRef.current ||
      !marketStartedAt ||
      qualified
    ) {
      return;
    }

    const marketElapsed = Date.now() - marketStartedAt;

    if (marketElapsed < 15000 || freshDigits.length < 4) return;

    switchingRef.current = true;

    const currentIndex = Math.max(
      0,
      markets.findIndex((item) => item.id === symbol)
    );
    const next = markets[(currentIndex + 1) % markets.length];

    if (!next || next.id === symbol) {
      switchingRef.current = false;
      setMarketStartedAt(Date.now());
      return;
    }

    setStatus("SWITCHING");
    setMessage(
      `No qualified entry on ${market?.label || symbol}. Switching to ${next.label} for a fresh digit scan.`
    );

    void Promise.resolve(changeSymbol(next.id))
      .then(() => {
        const now = Date.now();
        setMarketSwitches((value) => value + 1);
        setFreshDigits([]);
        setStableCandidateTicks(0);
        setStableCandidateDigit(null);
        lastFreshTickKeyRef.current = "";
        setMarketStartedAt(now);
        setStatus("SCANNING");
      })
      .catch((error) => {
        setStatus("ERROR");
        setMessage(
          error instanceof Error
            ? error.message
            : "Unable to switch market."
        );
        setRunning(false);
      })
      .finally(() => {
        switchingRef.current = false;
      });
  }, [
    running,
    contractId,
    connected,
    loadingMarket,
    markets,
    symbol,
    market?.label,
    marketStartedAt,
    qualified,
    freshDigits.length,
    changeSymbol,
  ]);

  useEffect(() => {
    if (!contractId || completedRef.current) return;

    const contract = openContracts.find(
      (item) => contractIdOf(item) === contractId
    );

    if (!contract || !settledContract(contract)) return;

    const finalResult = resultOf(contract);
    const finalProfit = contractProfit(contract);

    completedRef.current = true;
    executionRef.current = false;
    setResult(finalResult);
    setProfit(finalProfit);
    setRunning(false);
    setStatus(finalResult);
    setMessage(
      `${finalResult} ${finalProfit >= 0 ? "+" : ""}${finalProfit.toFixed(
        2
      )} USD — ONE RUN COMPLETE, BOT STOPPED.`
    );
  }, [openContracts, contractId]);

  const rankedMarkets = useMemo(
    () =>
      Object.values(marketScores)
        .sort((a, b) => Number(b.quality) - Number(a.quality))
        .slice(0, 5),
    [marketScores]
  );

  const buttonDisabled =
    running ||
    tradeBusy ||
    !selectedAccountId ||
    loadingMarket;

  return (
    <div className="appShell differsOneShotShell">
      <Sidebar />

      <main className="mainContent differsOneShotPage">
        <Topbar
          connected={connected}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <header className="dosHeader">
          <div>
            <small>ONE-SHOT DIGIT BOT</small>
            <h1>Differs Precision Run</h1>
            <p>
              Scans multiple markets, analyses every digit, takes one
              qualified 1-tick DIGITDIFF entry, then stops.
            </p>
          </div>

          <div className={`dosStatus ${status.toLowerCase()}`}>
            <small>Status</small>
            <strong>{status}</strong>
          </div>
        </header>

        <section className="dosControlCard">
          <MarketSelector
            markets={markets}
            value={symbol}
            onChange={changeSymbol}
            disabled={loadingMarket || running}
          />

          <label>
            <span>Stake (USD)</span>
            <input
              type="number"
              min="0.35"
              step="0.01"
              value={stake}
              disabled={running}
              onChange={(event) =>
                setStake(
                  Math.max(0.35, Number(event.target.value) || 0.35)
                )
              }
            />
          </label>

          <div className="dosAccount">
            <span>Account</span>
            <strong>
              {selectedAccountType.toUpperCase()} ·{" "}
              {selectedAccountId || "NOT SELECTED"}
            </strong>
          </div>

          <button
            type="button"
            className="dosStart"
            disabled={buttonDisabled}
            onClick={start}
          >
            {running ? "RUNNING…" : "START ONE RUN"}
          </button>

          {running ? (
            <button
              type="button"
              className="dosStop"
              onClick={() => stop("Stopped manually before a new entry.")}
              disabled={Boolean(contractId)}
            >
              STOP SCAN
            </button>
          ) : null}
        </section>

        <section className="dosMessage">
          <strong>{message}</strong>
          <span>
            Mode {requirements.label} · elapsed{" "}
            {Math.floor(elapsedMs / 1000)}s · market switches{" "}
            {marketSwitches}
          </span>
          {tradeError ? <span>{tradeError}</span> : null}
        </section>

        <section className="dosMetrics">
          <article>
            <small>Selected digit</small>
            <strong>{entry?.digit ?? analysis.selectedDigit ?? "—"}</strong>
          </article>
          <article>
            <small>Estimated differs</small>
            <strong>{pct(analysis.differsProbability)}</strong>
          </article>
          <article>
            <small>Confidence</small>
            <strong>{pct(analysis.confidence)}</strong>
          </article>
          <article>
            <small>Safety score</small>
            <strong>{pct(analysis.safetyScore)}</strong>
          </article>
          <article>
            <small>Match risk</small>
            <strong>{pct(analysis.estimatedMatchProbability)}</strong>
          </article>
          <article>
            <small>Transition risk</small>
            <strong>{pct(analysis.transitionRisk)}</strong>
          </article>
          <article>
            <small>Entropy</small>
            <strong>{pct(analysis.entropy)}</strong>
          </article>
          <article>
            <small>Stable candidate</small>
            <strong>
              {stableCandidateTicks}/{requirements.stable}
            </strong>
          </article>
        </section>

        <section className="dosAnalysisGrid">
          <article>
            <small>Market quality</small>
            <strong>{pct(analysis.marketQuality)}</strong>
          </article>
          <article>
            <small>Candidate separation</small>
            <strong>{Number(analysis.separation || 0).toFixed(2)}</strong>
          </article>
          <article>
            <small>Repeat risk</small>
            <strong>{pct(analysis.repeatRisk)}</strong>
          </article>
          <article>
            <small>Recent frequency</small>
            <strong>{pct(analysis.recentRate)}</strong>
          </article>
          <article>
            <small>Micro frequency</small>
            <strong>{pct(analysis.microRate)}</strong>
          </article>
          <article>
            <small>Fresh confirmation</small>
            <strong>
              {freshDigits.length}/{requirements.fresh}
            </strong>
          </article>
          <article>
            <small>History samples</small>
            <strong>{combinedDigits.length}</strong>
          </article>
          <article>
            <small>Current price</small>
            <strong>
              {Number.isFinite(Number(currentPrice))
                ? Number(currentPrice).toFixed(
                    Number(market?.decimals || 3)
                  )
                : "—"}
            </strong>
          </article>
        </section>

        <section className="dosDigits">
          {(analysis.candidates || []).map((candidate, index) => (
            <article
              key={candidate.digit}
              className={[
                candidate.digit === analysis.selectedDigit
                  ? "selected"
                  : "",
                index < 3 ? "topCandidate" : "",
              ].join(" ")}
            >
              <div>
                <strong>{candidate.digit}</strong>
                <em>#{index + 1}</em>
              </div>
              <span>DIFF {pct(candidate.differsProbability)}</span>
              <small>
                Match {pct(candidate.weightedMatchProbability)}
              </small>
              <small>
                Transition {pct(candidate.transitionRate)}
              </small>
              <small>Safety {pct(candidate.safetyScore)}</small>
              <small>Gap {candidate.gap}</small>
            </article>
          ))}
        </section>

        {rankedMarkets.length ? (
          <section className="dosMarketRanking">
            <header>
              <strong>Markets scanned</strong>
              <span>Best observed quality first</span>
            </header>

            <div>
              {rankedMarkets.map((item) => (
                <article key={item.symbol}>
                  <strong>{item.label}</strong>
                  <span>Quality {pct(item.quality)}</span>
                  <span>Digit {item.digit}</span>
                  <span>Match risk {pct(item.matchRisk)}</span>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <section className="dosResultCard">
          <div>
            <small>Entry</small>
            <strong>
              {entry
                ? `DIFFERS ${entry.digit} · ${entry.market}`
                : "No trade placed yet"}
            </strong>
          </div>

          <div>
            <small>Result</small>
            <strong className={result.toLowerCase()}>
              {result || "—"}
            </strong>
          </div>

          <div>
            <small>Profit</small>
            <strong>
              {profit >= 0 ? "+" : ""}
              {Number(profit || 0).toFixed(2)} USD
            </strong>
          </div>
        </section>

        <p className="dosRiskNote">
          It will not wait forever: thresholds adapt gradually and the
          bot changes market every 15 seconds when no qualified setup
          appears. It still makes one trade only. No analysis can
          guarantee the next digit.
        </p>
      </main>
    </div>
  );
}
