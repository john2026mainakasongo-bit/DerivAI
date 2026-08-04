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

export default function DiffersOneShotBot() {
  const {
    markets = [],
    market = null,
    symbol = "",
    connected = false,
    loadingMarket = false,
    digitHistory = [],
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
  const [marketSwitches, setMarketSwitches] = useState(0);

  const executionRef = useRef(false);
  const completedRef = useRef(false);
  const switchingRef = useRef(false);

  const analysis = useMemo(
    () => analyzeDiffersOneShot(digitHistory),
    [digitHistory]
  );

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

      completedRef.current = false;
      executionRef.current = false;
      setContractId("");
      setResult("");
      setProfit(0);
      setEntry(null);
      setMarketSwitches(0);
      setScanStartedAt(Date.now());
      setRunning(true);
      setStatus("SCANNING");
      setMessage(
        "Scanning digits for one controlled DIFFERS entry."
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
      executionRef.current ||
      tradeBusy ||
      contractId ||
      !connected ||
      loadingMarket
    ) {
      return;
    }

    if (!analysis.ready) return;

    executionRef.current = true;
    setStatus("BUYING");
    setMessage(
      `Buying one DIGITDIFF contract against ${analysis.selectedDigit}.`
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
      !scanStartedAt
    ) {
      return;
    }

    if (analysis.ready) return;

    const elapsed = Date.now() - scanStartedAt;
    if (elapsed < 4500) return;

    switchingRef.current = true;

    const currentIndex = Math.max(
      0,
      markets.findIndex((item) => item.id === symbol)
    );
    const next = markets[(currentIndex + 1) % markets.length];

    if (!next || next.id === symbol) {
      switchingRef.current = false;
      setScanStartedAt(Date.now());
      return;
    }

    setStatus("SWITCHING");
    setMessage(
      `No clean setup on ${market?.label || symbol}. Checking ${next.label}.`
    );

    void Promise.resolve(changeSymbol(next.id))
      .then(() => {
        setMarketSwitches((value) => value + 1);
        setScanStartedAt(Date.now());
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
    scanStartedAt,
    analysis.ready,
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
              Scans quickly, buys one 1-tick DIGITDIFF contract,
              waits for the result, then stops.
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
          {tradeError ? <span>{tradeError}</span> : null}
        </section>

        <section className="dosMetrics">
          <article>
            <small>Selected digit</small>
            <strong>
              {analysis.selectedDigit ?? "—"}
            </strong>
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
            <small>Entropy</small>
            <strong>{pct(analysis.entropy)}</strong>
          </article>
          <article>
            <small>Samples</small>
            <strong>{analysis.samples || 0}</strong>
          </article>
          <article>
            <small>Market switches</small>
            <strong>{marketSwitches}</strong>
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
          {(analysis.candidates || []).map((candidate) => (
            <article
              key={candidate.digit}
              className={
                candidate.digit === analysis.selectedDigit
                  ? "selected"
                  : ""
              }
            >
              <strong>{candidate.digit}</strong>
              <span>
                DIFF {pct(candidate.differsProbability)}
              </span>
              <small>
                Match est. {pct(candidate.weightedMatchProbability)}
              </small>
            </article>
          ))}
        </section>

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
          This bot makes one controlled attempt only. Analysis can
          filter weak setups, but no digit contract can be guaranteed
          to win.
        </p>
      </main>
    </div>
  );
}
