import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import DerivVolatilitySelector, { DERIV_VOLATILITY_MARKETS } from "../components/DerivVolatilitySelector";
import "../components/DerivSelectors.css";
import useDerivTicks from "../hooks/useDerivTicks";
import { useDerivAuth } from "../auth/DerivAuthContext";
import derivPublicClient from "../services/derivApi";
import {
  buildTargetTenDecision,
} from "../analysis/targetTenStrategyEngine";
import "../styles/TargetTenBot.css";
import "../styles/V102BotTargetFix.css";
import "../styles/V103TargetTenVisibilityFix.css";
import "../styles/V104TargetTenRunFix.css";
import "../styles/V105TargetTenEntryQuality.css";
import "../styles/V106TargetTenFinal.css";

const pct = (value) => `${Number(value || 0).toFixed(1)}%`;

function getAccountId(account = {}) {
  return String(
    account.id ||
    account.account_id ||
    account.loginid ||
    account.login_id ||
    ""
  );
}

function getAccountBalance(account = {}) {
  const value = Number(
    account.balance ??
    account.amount ??
    account.account_balance ??
    account.display_balance ??
    0
  );
  return Number.isFinite(value) ? value : 0;
}

function getAccountType(account = {}) {
  const id = getAccountId(account).toUpperCase();
  const type = String(account.type || account.account_type || "").toLowerCase();
  return type.includes("demo") || id.startsWith("VRTC") ? "demo" : "real";
}

function contractIdOf(item = {}) {
  return String(item.contract_id || item.id || item.contractId || "");
}

function settledStatus(item = {}) {
  const status = String(item.status || "").toUpperCase();
  if (item.is_sold || item.is_expired || ["WON", "LOST", "SOLD", "EXPIRED"].includes(status)) {
    return status || "CLOSED";
  }
  return status || "OPEN";
}

function profitOf(item = {}) {
  const value = Number(
    item.profit ??
    item.profit_loss ??
    item.pnl ??
    (Number(item.sell_price || 0) - Number(item.buy_price || 0))
  );
  return Number.isFinite(value) ? value : 0;
}

export default function TargetTenBot() {
  const auth = useDerivAuth();
  const {
    markets = [],
    market = null,
    symbol = "",
    connected = false,
    loadingMarket = false,
    prices = [],
    selectedAccountId = "",
    selectedAccountType = "demo",
    openContracts = [],
    tradeBusy = false,
    tradeError = "",
    connect,
    disconnect,
    changeSymbol,
    placeTrade,
  } = useDerivTicks();

  const [running, setRunning] = useState(false);
  const [stake, setStake] = useState(0.35);
  const [target, setTarget] = useState(10);
  const [duration, setDuration] = useState(1);
  const [switchSeconds, setSwitchSeconds] = useState(8);
  const [runs, setRuns] = useState(0);
  const [wins, setWins] = useState(0);
  const [losses, setLosses] = useState(0);
  const [sessionProfit, setSessionProfit] = useState(0);
  const [message, setMessage] = useState("Target 10 bot is stopped.");
  const [trades, setTrades] = useState([]);
  const [manualBarrier, setManualBarrier] = useState(1);
  const [sessionStartBalance, setSessionStartBalance] = useState(null);
  const [recentContracts, setRecentContracts] = useState([]);
  const [blockedContracts, setBlockedContracts] = useState([]);

  const runningRef = useRef(false);
  const busyRef = useRef(false);
  const waitStartedRef = useRef(Date.now());
  const lastEntryRef = useRef(0);
  const processedRef = useRef(new Set());
  const latestTickCountRef = useRef(0);
  const confirmationRef = useRef({
    key: "",
    count: 0,
    firstSeenAt: 0,
  });
  const lastLossAtRef = useRef(0);
  const lastPlacedSetupRef = useRef(null);
  const blockedExpiryRef = useRef(new Map());

  const accounts = useMemo(() => {
    const list =
      auth.accounts ||
      auth.session?.accounts ||
      auth.accountList ||
      [];
    return Array.isArray(list) ? list : [];
  }, [auth.accounts, auth.session?.accounts, auth.accountList]);

  const selectedAccount =
    auth.selectedAccount ||
    accounts.find((account) => getAccountId(account) === selectedAccountId) ||
    null;

  const accountId = getAccountId(selectedAccount) || selectedAccountId;
  const accountType =
    auth.selectedAccountType ||
    selectedAccountType ||
    getAccountType(selectedAccount);
  const balance = getAccountBalance(selectedAccount);
  const currency = selectedAccount?.currency || "USD";
  const profitTarget = Math.max(1, Number(target) || 10);
  const nextProfitStage = Math.min(
    profitTarget,
    Math.max(2, Math.ceil((Math.max(0, sessionProfit) + 0.001) / 2) * 2)
  );

  const decision = useMemo(
    () =>
      buildTargetTenDecision(prices, {
        minimumSamples: 120,
        minimumScore: 76,
        minimumEdge: 2.5,
        minimumFastEdge: 0.5,
        minimumTransitionEdge: -1,
        minimumConsistency: 58,
        maximumExactRisk: 15,
        maximumConsecutiveUses: 2,
        recentContracts,
        blockedContracts,
      }),
    [prices, recentContracts, blockedContracts]
  );

  const strictEntryQualified =
    Boolean(decision?.qualified) &&
    Number(decision?.best?.score || 0) >= 76 &&
    Number(decision?.best?.expectedEdge || -100) >= 2.5 &&
    Number(decision?.best?.consistency || 0) >= 58 &&
    Number(decision?.best?.exactRisk || 100) <= 15 &&
    !decision?.best?.blocked;

  const setupKey = `${decision?.best?.side || "WAIT"}-${decision?.best?.barrier ?? "X"}`;

  useEffect(() => {
    if (!strictEntryQualified) {
      confirmationRef.current = {
        key: "",
        count: 0,
        firstSeenAt: 0,
      };
      return;
    }

    const now = Date.now();
    const previous = confirmationRef.current;

    if (previous.key !== setupKey || now - previous.firstSeenAt > 5000) {
      confirmationRef.current = {
        key: setupKey,
        count: 1,
        firstSeenAt: now,
      };
      return;
    }

    confirmationRef.current = {
      ...previous,
      count: Math.min(4, previous.count + 1),
    };
  }, [
    strictEntryQualified,
    setupKey,
    decision?.best?.score,
    decision?.best?.probability,
    decision?.best?.transition,
    decision?.best?.exactRisk,
  ]);

  const confirmedEntry =
    strictEntryQualified &&
    confirmationRef.current.key === setupKey &&
    confirmationRef.current.count >= 3;

  const hasOpenTrade = trades.some((trade) => trade.status === "OPEN");

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  useEffect(() => {
    latestTickCountRef.current = Array.isArray(prices) ? prices.length : 0;
  }, [prices]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      let changed = false;

      for (const [key, expiry] of blockedExpiryRef.current.entries()) {
        if (expiry <= now) {
          blockedExpiryRef.current.delete(key);
          changed = true;
        }
      }

      if (changed) {
        setBlockedContracts(Array.from(blockedExpiryRef.current.keys()));
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!connected && typeof connect === "function") {
      Promise.resolve(connect()).catch(() => {});
    }
  }, [connected, connect]);

  useEffect(() => {
    if (!accountId) return;

    const changed = derivPublicClient.configureAccount({
      accessToken: auth.session?.accessToken || "",
      appId: auth.config?.clientId || "",
      accountId,
    });

    if (changed && connected) {
      void derivPublicClient.reconnect();
    }
  }, [
    accountId,
    connected,
    auth.session?.accessToken,
    auth.config?.clientId,
  ]);

  function stopBot(text) {
    runningRef.current = false;
    setRunning(false);
    setMessage(text);
  }

  async function switchAccount(nextId) {
    const nextAccount = accounts.find((account) => getAccountId(account) === nextId);
    const method =
      auth.selectAccount ||
      auth.setSelectedAccount ||
      auth.chooseAccount ||
      auth.switchAccount;

    if (nextAccount && typeof method === "function") {
      await Promise.resolve(method(nextAccount));
      setMessage(`Switched to ${getAccountType(nextAccount).toUpperCase()} account.`);
    }
  }

  async function placeTargetTrade() {
    if (
      busyRef.current ||
      !runningRef.current ||
      !confirmedEntry ||
      hasOpenTrade ||
      tradeBusy ||
      Date.now() - lastEntryRef.current < 3500 ||
      Date.now() - lastLossAtRef.current < 12000
    ) {
      return;
    }

    if (!connected || !accountId) {
      setMessage("Waiting for account connection.");
      return;
    }

    if (sessionProfit >= profitTarget) {
      stopBot(`Profit target ${profitTarget.toFixed(2)} ${currency} reached.`);
      return;
    }

    busyRef.current = true;

    try {
      const result = await placeTrade({
        symbol,
        contractType:
          decision.best.side === "OVER" ? "DIGITOVER" : "DIGITUNDER",
        amount: Math.max(0.35, Number(stake) || 0.35),
        basis: "stake",
        duration: Math.max(1, Number(duration) || 1),
        durationUnit: "t",
        barrier: String(decision.best.barrier),
      });

      const contractId = String(result?.contractId || "");
      const placedSetup = {
        key: decision.best.key,
        side: decision.best.side,
        barrier: decision.best.barrier,
        symbol,
      };
      lastPlacedSetupRef.current = placedSetup;
      setRecentContracts((current) =>
        [...current, decision.best.key].slice(-8)
      );
      setRuns((value) => value + 1);
      setTrades((current) => [
        {
          id: contractId || String(Date.now()),
          contractId,
          time: Date.now(),
          symbol,
          accountType,
          contract: `${decision.best.side} ${decision.best.barrier}`,
          stake: Math.max(0.35, Number(stake) || 0.35),
          status: "OPEN",
          profit: 0,
        },
        ...current,
      ].slice(0, 30));

      lastEntryRef.current = Date.now();
      waitStartedRef.current = Date.now();
      setMessage(
        `${accountType.toUpperCase()}: ${decision.best.side} ${decision.best.barrier} opened.`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Trade failed.");
    } finally {
      busyRef.current = false;
    }
  }

  useEffect(() => {
    if (running && confirmedEntry && !hasOpenTrade) {
      void placeTargetTrade();
    }
  }, [
    running,
    confirmedEntry,
    decision.best.side,
    decision.best.barrier,
    decision.best.score,
    decision.best.probability,
    decision.best.transition,
    decision.best.exactRisk,
    hasOpenTrade,
    symbol,
    accountId,
  ]);

  const marketSymbols = DERIV_VOLATILITY_MARKETS.map((item) => item.id);

  useEffect(() => {
    if (!running || confirmedEntry || hasOpenTrade || tradeBusy || marketSymbols.length < 2) {
      return;
    }

    const timer = window.setInterval(() => {
      const elapsed = Date.now() - waitStartedRef.current;
      const threshold = Math.max(8, Number(switchSeconds) || 20) * 1000;

      if (elapsed < threshold) return;

      const currentIndex = marketSymbols.indexOf(symbol);
      const next =
        marketSymbols[
          currentIndex >= 0
            ? (currentIndex + 1) % marketSymbols.length
            : 0
        ];

      if (next && next !== symbol) {
        setMessage(`No qualified setup. Switching ${symbol} â†’ ${next}.`);
        waitStartedRef.current = Date.now();
        void Promise.resolve(changeSymbol(next));
      }
    }, 500);

    return () => window.clearInterval(timer);
  }, [
    running,
    confirmedEntry,
    hasOpenTrade,
    tradeBusy,
    marketSymbols,
    symbol,
    switchSeconds,
    changeSymbol,
  ]);

  useEffect(() => {
    const contracts = Array.isArray(openContracts) ? openContracts : [];
    if (!contracts.length) return;

    let settlement = null;

    setTrades((current) =>
      current.map((trade) => {
        const match = contracts.find(
          (item) => contractIdOf(item) === trade.contractId
        );
        if (!match) return trade;

        const status = settledStatus(match);
        const profit = profitOf(match);
        const closed = ["WON", "LOST", "SOLD", "EXPIRED"].includes(status);

        if (
          closed &&
          trade.contractId &&
          !processedRef.current.has(trade.contractId)
        ) {
          processedRef.current.add(trade.contractId);
          settlement = { status, profit };
        }

        return { ...trade, status, profit };
      })
    );

    if (!settlement) return;

    setSessionProfit((value) => value + settlement.profit);
    waitStartedRef.current = Date.now();

    if (settlement.status === "WON" || settlement.profit > 0) {
      setWins((value) => value + 1);
      confirmationRef.current = { key: "", count: 0, firstSeenAt: 0 };
      setMessage("Trade won. Rotating contracts and scanning all 14 setups again.");
    } else {
      const lostKey = lastPlacedSetupRef.current?.key;
      lastLossAtRef.current = Date.now();

      if (lostKey) {
        const expiry = Date.now() + 60_000;
        blockedExpiryRef.current.set(lostKey, expiry);
        setBlockedContracts((current) =>
          Array.from(new Set([...current, lostKey]))
        );
      }

      setLosses((value) => value + 1);
      stopBot(
        lostKey
          ? `${lostKey.replace("-", " ")} lost and is blocked for 60 seconds. Bot stopped to protect the account.`
          : "One loss recorded. Bot stopped to protect the account."
      );
    }
  }, [openContracts]);

  useEffect(() => {
    if (running && sessionProfit >= profitTarget) {
      stopBot(`Profit target ${profitTarget.toFixed(2)} ${currency} reached.`);
    }
  }, [running, sessionProfit, profitTarget, currency]);

  async function placeManualTrade(side = "OVER") {
    if (busyRef.current || tradeBusy || hasOpenTrade) {
      setMessage("Wait for the current trade to settle.");
      return;
    }

    if (!connected) {
      await connect();
    }

    if (!accountId) {
      setMessage("Select an account from the top account menu.");
      return;
    }

    if (accountType === "real") {
      const confirmed = window.confirm(
        `PLACE ONE REAL MANUAL TRADE?\n\n` +
          `${side} ${manualBarrier}\n` +
          `Stake: ${Math.max(0.35, Number(stake) || 0.35).toFixed(2)} ${currency}`
      );
      if (!confirmed) return;
    }

    busyRef.current = true;

    try {
      const result = await placeTrade({
        symbol,
        contractType: side === "OVER" ? "DIGITOVER" : "DIGITUNDER",
        amount: Math.max(0.35, Number(stake) || 0.35),
        basis: "stake",
        duration: Math.max(1, Number(duration) || 1),
        durationUnit: "t",
        barrier: String(manualBarrier),
      });

      const contractId = String(result?.contractId || "");
      setRuns((value) => value + 1);
      setTrades((current) => [
        {
          id: contractId || String(Date.now()),
          contractId,
          time: Date.now(),
          symbol,
          accountType,
          contract: `${side} ${manualBarrier}`,
          stake: Math.max(0.35, Number(stake) || 0.35),
          status: "OPEN",
          profit: 0,
        },
        ...current,
      ].slice(0, 30));

      lastEntryRef.current = Date.now();
      waitStartedRef.current = Date.now();
      setMessage(`MANUAL ${side} ${manualBarrier} opened.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Manual trade failed.");
    } finally {
      busyRef.current = false;
    }
  }

  async function toggleRun() {
    if (running) {
      stopBot("Stopped manually.");
      return;
    }

    if (!accountId) {
      setMessage("Select a Demo or Real account from the top account menu.");
      return;
    }

    try {
      if (!connected) {
        setMessage("Connecting Deriv live feedâ€¦");
        await connect();
      }

      setRuns(0);
      setWins(0);
      setLosses(0);
      setSessionProfit(0);
      setTrades([]);
      setRecentContracts([]);
      confirmationRef.current = { key: "", count: 0, firstSeenAt: 0 };
      processedRef.current = new Set();
      setSessionStartBalance(balance);
      lastEntryRef.current = 0;
      waitStartedRef.current = Date.now();

      setMessage("Loading live ticks before the first scanâ€¦");

      const warmupStarted = Date.now();
      while (
        latestTickCountRef.current < 30 &&
        Date.now() - warmupStarted < 8000
      ) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }

      runningRef.current = true;
      setRunning(true);

      if (latestTickCountRef.current < 30) {
        setMessage(
          `${accountType.toUpperCase()} bot running. Collecting more ticks and scanning continuously.`
        );
      } else {
        setMessage(
          `${accountType.toUpperCase()} bot running. ${latestTickCountRef.current} live ticks loaded; scanning now.`
        );
      }
    } catch (error) {
      runningRef.current = false;
      setRunning(false);
      setMessage(error instanceof Error ? error.message : "Unable to start bot.");
    }
  }

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent targetTenPage">
        <Topbar
          title="EdgePilot V106 Â· Final Multi-Contract Target 10"
          subtitle="Scans OVER/UNDER 1â€“7 Â· edge-ranked entries Â· contract rotation Â· loss memory"
          connected={connected}
          connecting={loadingMarket}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section className="targetTopbar">
          <DerivVolatilitySelector
            value={symbol}
            disabled={loadingMarket || running}
            onChange={changeSymbol}
          />

          <button
            type="button"
            className={running ? "targetStop" : "targetStart"}
            disabled={tradeBusy}
            onClick={toggleRun}
          >
            {tradeBusy ? "SENDINGâ€¦" : running ? "STOP" : "START"}
          </button>
        </section>

        <section className="targetProgress">
          <div>
            <small>NEXT PROFIT STAGE</small>
            <strong>+{nextProfitStage.toFixed(2)} {currency}</strong>
          </div>
          <div>
            <small>PROFIT TARGET</small>
            <strong>+{profitTarget.toFixed(2)} {currency}</strong>
          </div>
          <div>
            <small>SESSION P/L</small>
            <strong className={sessionProfit >= 0 ? "positive" : "negative"}>
              {sessionProfit.toFixed(2)} {currency}
            </strong>
          </div>
          <span>
            <i
              style={{
                width: `${Math.max(
                  0,
                  Math.min(100, (Math.max(0, sessionProfit) / profitTarget) * 100)
                )}%`,
              }}
            />
          </span>
        </section>

        <section className="targetControls">
          <label>
            <span>Stake</span>
            <input
              type="number"
              min="0.35"
              step="0.01"
              inputMode="decimal"
              value={stake}
              onChange={(event) => setStake(event.target.value)}
            />
          </label>
          <label>
            <span>Profit target</span>
            <input
              type="number"
              min="1"
              step="0.5"
              inputMode="decimal"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            />
          </label>
          <label>
            <span>Duration</span>
            <select
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
            >
              <option value="1">1 TICK</option>
              <option value="2">2 TICKS</option>
              <option value="3">3 TICKS</option>
            </select>
          </label>
          <label>
            <span>Market switch</span>
            <input
              type="number"
              min="8"
              max="60"
              inputMode="numeric"
              value={switchSeconds}
              onChange={(event) => setSwitchSeconds(event.target.value)}
            />
          </label>
          <div><span>Runs</span><strong>{runs}</strong></div>
          <div><span>Wins</span><strong>{wins}</strong></div>
          <div><span>Losses</span><strong>{losses}</strong></div>
          <div><span>Protection</span><strong>STOP AFTER 1 LOSS</strong></div>
        </section>

        <section className="v103TargetManual">
          <div className="v103ManualIntro">
            <small>MANUAL EXECUTION</small>
            <h2>Direct Over/Under trade</h2>
            <p>
              Uses the stake and duration selected above. Choose the barrier,
              then press OVER or UNDER.
            </p>
          </div>

          <label className="v103Barrier">
            <span>Barrier</span>
            <select
              value={manualBarrier}
              onChange={(event) => setManualBarrier(Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5, 6, 7].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="v103BuyOver"
            disabled={tradeBusy || hasOpenTrade}
            onClick={() => void placeManualTrade("OVER")}
          >
            {tradeBusy ? "SENDINGâ€¦" : `BUY OVER ${manualBarrier}`}
          </button>

          <button
            type="button"
            className="v103BuyUnder"
            disabled={tradeBusy || hasOpenTrade}
            onClick={() => void placeManualTrade("UNDER")}
          >
            {tradeBusy ? "SENDINGâ€¦" : `BUY UNDER ${manualBarrier}`}
          </button>
        </section>

        <section className={`targetDecision ${decision.qualified ? "ready" : ""}`}>
          <div>
            <small>LIVE DECISION</small>
            <h1>
              {confirmedEntry
                ? `BUY ${decision.best.side} ${decision.best.barrier}`
                : strictEntryQualified
                  ? `CONFIRMING ${decision.best.side} ${decision.best.barrier}`
                  : "SCANNING 14 CONTRACTS"}
            </h1>
            <p>{decision.reason}</p>
          </div>

          <div className="targetMetrics">
            <span><small>Score</small><strong>{pct(decision.best.score)}</strong></span>
            <span><small>Edge</small><strong>{Number(decision.best.expectedEdge || 0).toFixed(1)}</strong></span>
            <span><small>Consistency</small><strong>{pct(decision.best.consistency)}</strong></span>
            <span><small>Exact risk</small><strong>{pct(decision.best.exactRisk)}</strong></span>
          </div>
        </section>

        <section className="targetFinalRanking">
          <div className="targetTradesHead">
            <div>
              <small>LIVE CONTRACT RANKING</small>
              <h2>Best OVER and UNDER setups</h2>
            </div>
            <strong>14 scanned</strong>
          </div>

          <div className="targetFinalRankingGrid">
            {decision.candidates.slice(0, 8).map((candidate) => (
              <article
                key={candidate.key}
                className={
                  candidate.key === decision.best.key ? "best" : ""
                }
              >
                <small>{candidate.side} {candidate.barrier}</small>
                <strong>{candidate.score.toFixed(1)}</strong>
                <span>
                  Edge {candidate.expectedEdge.toFixed(1)} Â·
                  Risk {candidate.exactRisk.toFixed(1)}%
                </span>
                {candidate.blocked ? <b>BLOCKED</b> : null}
              </article>
            ))}
          </div>
        </section>

        <section className="targetSignalGrid">
          <article><small>CURRENT DIGIT</small><strong>{decision.currentDigit}</strong></article>
          <article><small>CONTRACT</small><strong>{decision.best.side} {decision.best.barrier}</strong></article>
          <article><small>WINNING DIGITS</small><strong>{Array.isArray(decision.winningDigits) ? decision.winningDigits.join(" Â· ") || "â€”" : "â€”"}</strong></article>
          <article><small>ACCOUNT MODE</small><strong>{accountType.toUpperCase()}</strong></article>
          <article><small>ROTATION</small><strong>{recentContracts.length}/8</strong></article>
          <article><small>STATUS</small><strong>{running ? "RUNNING" : "STOPPED"}</strong></article>
        </section>

        <section className="targetMessage">
          <strong>{running ? "SCANNING" : "STOPPED"}</strong>
          <span>{message || tradeError}</span>
          <small>
            Best: {decision.best.side} {decision.best.barrier} Â·
            Edge {Number(decision.best.expectedEdge || 0).toFixed(1)} Â·
            Confirm {confirmationRef.current.count}/3
          </small>
        </section>

        <section className="targetTrades">
          <div className="targetTradesHead">
            <div>
              <small>TRADE HISTORY</small>
              <h2>Target 10 session</h2>
            </div>
            <strong>{trades.length} trades</strong>
          </div>

          <div className="targetTradeTable">
            <div className="head">
              <span>Time</span><span>Account</span><span>Market</span>
              <span>Contract</span><span>Stake</span><span>Status</span><span>P/L</span>
            </div>
            {trades.map((trade) => (
              <div key={trade.id}>
                <span>{new Date(trade.time).toLocaleTimeString()}</span>
                <span>{trade.accountType.toUpperCase()}</span>
                <span>{trade.symbol}</span>
                <strong>{trade.contract}</strong>
                <span>{Number(trade.stake).toFixed(2)}</span>
                <b>{trade.status}</b>
                <b className={trade.profit >= 0 ? "positive" : "negative"}>
                  {Number(trade.profit).toFixed(2)}
                </b>
              </div>
            ))}
            {!trades.length ? <p>No trades in this session.</p> : null}
          </div>
        </section>

        <div className="targetDisclaimer">
          Demo and Real use identical entry rules. Results may differ because ticks and execution timing vary. No strategy guarantees growth to 10 USD.
        </div>
      </main>
    </div>
  );
}

