import { useEffect, useMemo, useRef, useState } from "react";
import useDerivTicks from "../hooks/useDerivTicks";
import { useDerivAuth } from "../auth/DerivAuthContext";
import derivPublicClient from "../services/derivApi";
import DerivBotEngine from "../bot/DerivBotEngine";
import { analyzeUnifiedSignals } from "../analysis/v71UnifiedSignalEngine";
import { buildValidatedSignals } from "../analysis/backtestEngine";
import { buildEntryTiming } from "../analysis/entryTimingEngine";
import { buildProfessionalDecision } from "../analysis/professionalDecisionEngine";
import "../styles/StrategyEngineV36.css";
import CandlestickChart from "./CandlestickChart";

const INITIAL_SETTINGS = {
  maxRuns: 56,
  stake: 1,
  duration: 1,
  minConfidence: 75,
  minVotes: 3,
  takeProfit: 4,
  stopLoss: 2,
  maxConsecutiveLosses: 3,
  delaySeconds: 3,
  martingaleEnabled: false,
  martingaleMultiplier: 2,
  maxMartingaleSteps: 0,
};

const INITIAL_BOT_STATE = {
  status: "IDLE",
  message: "Bot is ready to trade.",
  runs: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  totalStake: 0,
  totalPayout: 0,
  consecutiveLosses: 0,
  martingaleStep: 0,
  currentStake: 1,
  activeSetup: "—",
  activeContractId: "",
  history: [],
};

function accountId(account) {
  return String(account?.id || account?.account_id || account?.loginid || account?.login_id || "");
}

function buildPath(values, width = 720, height = 250) {
  if (!Array.isArray(values) || values.length < 2) return "";
  const visible = values.slice(-90).map(Number).filter(Number.isFinite);
  if (visible.length < 2) return "";
  const min = Math.min(...visible);
  const max = Math.max(...visible);
  const range = max - min || 1;
  return visible.map((value, index) => {
    const x = (index / Math.max(1, visible.length - 1)) * width;
    const y = height - ((value - min) / range) * (height - 24) - 12;
    return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
}

function Sparkline({ values = [] }) {
  const path = buildPath(values, 160, 46);
  return path ? (
    <svg className="v30Spark" viewBox="0 0 160 46" preserveAspectRatio="none">
      <path d={path} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  ) : null;
}

function Stat({ label, value, tone = "" }) {
  return <div className={`v30Stat ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function Stepper({ value, min, max, step = 1, onChange, disabled = false }) {
  const safe = Number.isFinite(Number(value)) ? Number(value) : min;
  const change = (delta) => onChange(Math.min(max, Math.max(min, Number((safe + delta).toFixed(2)))));
  return (
    <div className="v30Stepper">
      <input type="number" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
      <div className="v30StepButtons">
        <button type="button" disabled={disabled || safe <= min} onClick={() => change(-step)}>−</button>
        <button type="button" disabled={disabled || safe >= max} onClick={() => change(step)}>+</button>
      </div>
    </div>
  );
}

export default function StrategyEngineV36() {
  const auth = useDerivAuth();
  const engineRef = useRef(null);
  const [settings, setSettings] = useState(INITIAL_SETTINGS);
  const [botState, setBotState] = useState(INITIAL_BOT_STATE);
  const [filter, setFilter] = useState("ALL");
  const [connectionError, setConnectionError] = useState("");
  const autoConnectRef = useRef(false);

  const {
    markets,
    market,
    symbol,
    status,
    statusDetail,
    connected,
    loadingMarket,
    tradingReady,
    prices,
    currentPrice,
    lastDigit,
    digitHistory,
    connect,
    disconnect,
    changeSymbol,
    openContracts,
    transactions,
  } = useDerivTicks();

  const effectiveSymbol = symbol || "1HZ100V";
  const selectedId = accountId(auth.selectedAccount);
  const selectedAccount = auth.selectedAccount || {};
  const selectedLoginId = accountId(selectedAccount);
  const selectedAccountKind = String(
    auth.selectedAccountType || selectedAccount.type || selectedAccount.account_type || selectedAccount.accountType || ""
  ).toLowerCase();
  // V36: VRTC/virtual accounts are the safe executable lane; REAL remains selectable but locked.
  const isDemo = selectedAccountKind === "demo" || selectedAccountKind === "virtual" || selectedAccountKind === "vrt" ||
    selectedLoginId.toUpperCase().startsWith("VRTC");
  const running = ["RUNNING", "WAITING", "BUYING", "MONITORING", "COOLDOWN", "WON", "LOST"].includes(botState.status);
  const busy = running || botState.status === "PAUSED";
  const [executionReady, setExecutionReady] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const changed = derivPublicClient.configureAccount({
      accessToken: auth.session?.accessToken || "",
      appId: auth.config?.clientId || "",
      accountId: selectedId,
    });

    setExecutionReady(false);

    async function prepareExecution() {
      if (!auth.authenticated || !selectedId || !isDemo) return;
      try {
        if (changed && connected) await derivPublicClient.reconnect();
        await derivPublicClient.ensureTradingConnection();
        if (!cancelled) setExecutionReady(true);
      } catch {
        if (!cancelled) setExecutionReady(false);
      }
    }

    void prepareExecution();
    return () => { cancelled = true; };
  }, [
    auth.authenticated,
    auth.session?.accessToken,
    auth.config?.clientId,
    selectedId,
    isDemo,
    connected,
  ]);

  useEffect(() => {
    const engine = new DerivBotEngine({ client: derivPublicClient, onState: setBotState });
    engineRef.current = engine;
    return () => { engine.destroy(); engineRef.current = null; };
  }, []);

  useEffect(() => { engineRef.current?.configure(settings); }, [settings]);
  useEffect(() => {
    engineRef.current?.setMarket({ symbol: effectiveSymbol, currency: auth.selectedAccount?.currency || "USD" });
  }, [effectiveSymbol, auth.selectedAccount?.currency]);

  // V29: never leave the engine without a market. Default to 1HZ100V.
  useEffect(() => {
    if (!symbol && typeof changeSymbol === "function") {
      try { changeSymbol("1HZ100V"); } catch { /* hook may select asynchronously */ }
    }
  }, [symbol, changeSymbol]);

  // V29: establish the public tick feed automatically once a market exists.
  useEffect(() => {
    if (autoConnectRef.current || connected || loadingMarket || typeof connect !== "function") return;
    autoConnectRef.current = true;
    setConnectionError("");
    Promise.resolve(connect()).catch((error) => {
      autoConnectRef.current = false;
      setConnectionError(error?.message || "Unable to connect to Deriv feed.");
    });
  }, [connected, loadingMarket, connect, effectiveSymbol]);

  const snapshot = useMemo(() => ({ prices, currentPrice, lastDigit, digitHistory }), [prices, currentPrice, lastDigit, digitHistory]);
  const validatedSignals = useMemo(() => buildValidatedSignals(snapshot), [snapshot]);
  const entryTiming = useMemo(() => buildEntryTiming(validatedSignals, snapshot, { tradeTicks: settings.duration, validitySeconds: 15 }), [validatedSignals, snapshot, settings.duration]);
  const professionalDecision = useMemo(() => buildProfessionalDecision(snapshot, validatedSignals), [snapshot, validatedSignals]);
  const unified = useMemo(() => analyzeUnifiedSignals({ ...snapshot, minimumConfidence: settings.minConfidence }), [snapshot, settings.minConfidence]);

  const best = unified?.digit?.best || null;
  const signal = best?.setup || professionalDecision?.setup || "WAIT";
  const confidence = Number(best?.qualityScore ?? best?.probability ?? professionalDecision?.confidence ?? 0);
  const historySize = Array.isArray(digitHistory) ? digitHistory.length : 0;
  const historyProgress = Math.min(100, (historySize / 500) * 100);
  const chartPath = buildPath((prices || []).map((item) => Number(item?.quote ?? item?.price ?? item)));
  const model = historySize >= 8 ? "CALIBRATED TRANSITION BLEND" : "CALIBRATING";
  const winRate = botState.runs ? (botState.wins / botState.runs) * 100 : 0;
  const totalLoss = botState.history.filter((x) => Number(x.profit) < 0).reduce((s, x) => s + Math.abs(Number(x.profit || 0)), 0);
  const totalProfit = botState.history.filter((x) => Number(x.profit) >= 0).reduce((s, x) => s + Number(x.profit || 0), 0);
  const netProfit = Number(botState.profit || 0);
  const transactions = (botState.history || []).slice().reverse().filter((item) => filter === "ALL" || String(item.result).toUpperCase() === filter);
  const equity = (botState.history || []).slice().reverse().reduce((acc, item) => {
    const next = (acc.at(-1) || 0) + Number(item.profit || 0);
    acc.push(next);
    return acc;
  }, []);
  const equityPath = buildPath(equity, 520, 110);

  const setNumber = (key, value) => setSettings((current) => ({ ...current, [key]: value }));

  async function startBot() {
    setConnectionError("");
    if (!auth.authenticated) {
      auth.login();
      return;
    }
    if (!selectedId) {
      setConnectionError("Choose a Deriv DEMO/VRTC account first.");
      return;
    }
    if (!isDemo) {
      setConnectionError("REAL account selected. Real-money bot execution is locked in this build. Switch to DEMO/VRTC.");
      return;
    }
    if (!effectiveSymbol) {
      setConnectionError("Select a Deriv market before starting the bot.");
      return;
    }

    try {
      // V36 fixes the V36 deadlock: Start establishes the authenticated
      // execution socket itself instead of waiting on tradingReady.
      await derivPublicClient.ensureTradingConnection();
      // The market feed and transaction stream are owned by useDerivTicks.
      // Do not subscribe them again here: Deriv rejects duplicate subscriptions.
      setExecutionReady(true);
    } catch (error) {
      setExecutionReady(false);
      setConnectionError(error?.message || "Authenticated Deriv trading connection failed.");
      return;
    }

    if (!connected && historySize < 8) {
      setConnectionError("Waiting for the live Deriv feed. Collect at least 8 ticks before starting.");
      return;
    }
    if (historySize < 8) {
      setConnectionError("Collecting live history. The bot will unlock after the minimum calibration window.");
      return;
    }
    // V36: START means start the bot engine, not "place a trade immediately".
    // The engine owns signal qualification and will remain in WAITING until
    // a fresh, validated setup passes its trading gate.
    try {
      setConnectionError("");
      await engineRef.current?.start();
    } catch (error) {
      setConnectionError(error?.message || "Bot could not start.");
    }
  }

  function stopBot() {
    setConnectionError("");
    engineRef.current?.stop();
    setExecutionReady(false);
  }

  const accountOptions = useMemo(() => {
    const raw = auth.accounts || auth.availableAccounts || auth.accountList || auth.user?.accounts || [];
    const list = Array.isArray(raw) ? raw : Object.values(raw || {});
    const normalized = list.filter((a) => a && accountId(a)).map((a) => ({
      id: accountId(a),
      type: String(a.type || a.account_type || a.accountType ||
        (String(a.loginid || a.id || "").startsWith("VRTC") ? "demo" : "real")).toLowerCase(),
      currency: a.currency || "USD",
      balance: Number(a.balance ?? a.available_balance ?? 0),
      label: a.loginid || a.id || a.account_id || "Account",
    }));

    // Keep the selected account visible even before the provider refreshes its list.
    if (selectedId && !normalized.some((a) => a.id === selectedId)) {
      normalized.unshift({
        id: selectedId,
        type: isDemo ? "demo" : "real",
        currency: selectedAccount.currency || "USD",
        balance: Number(selectedAccount.balance ?? selectedAccount.available_balance ?? 0),
        label: selectedLoginId || selectedId,
      });
    }
    return normalized;
  }, [
    auth.accounts,
    auth.availableAccounts,
    auth.accountList,
    auth.user?.accounts,
    selectedId,
    selectedAccount.currency,
    selectedAccount.balance,
    selectedAccount.available_balance,
    selectedLoginId,
    isDemo,
  ]);

  async function refreshAccounts() {
    const fn = auth.refreshAccounts || auth.loadAccounts || auth.fetchAccounts || auth.refreshAccountList;
    if (typeof fn !== "function") return;
    setAccountBusy(true);
    try {
      await fn();
      setConnectionError("");
    } catch (error) {
      setConnectionError(error?.message || "Unable to refresh Deriv accounts.");
    } finally {
      setAccountBusy(false);
    }
  }

  async function selectAccount(id) {
    if (!id || id === selectedId) return;
    const fn = auth.selectAccount || auth.switchAccount || auth.setSelectedAccount || auth.setAccount;
    if (typeof fn !== "function") {
      setConnectionError("Account switching is not exposed by the Deriv authorization provider.");
      return;
    }

    setAccountBusy(true);
    setConnectionError("");
    setExecutionReady(false);
    try {
      await fn(id);
    } catch (error) {
      setConnectionError(error?.message || "Unable to switch Deriv account.");
    } finally {
      setAccountBusy(false);
    }
  }


  const liveOpenTrade = Array.isArray(openContracts) ? openContracts[0] : null;
  const accountBalance = Number(selectedAccount?.balance ?? selectedAccount?.available_balance ?? 0);
  const liveLedger = Array.isArray(transactions) ? transactions : [];
  const displayTransactions = liveLedger.length ? liveLedger : (botState.history || []);
  const liveContractId = String(liveOpenTrade?.contract_id || liveOpenTrade?.contractId || liveOpenTrade?.id || botState.activeContractId || "");
  const liveProfit = Number(liveOpenTrade?.profit ?? liveOpenTrade?.profit_loss ?? liveOpenTrade?.payout ?? 0);

  return (
    <div className="v30Shell">
      <aside className="v30Sidebar">
        <div className="v30Brand"><div className="v30BrandMark">Z</div><div><strong>DERIVAI <span>AI</span></strong><small>Trading Engine</small></div></div>
        <div className="v30LivePill"><i /> DERIV LIVE · {effectiveSymbol}</div>
        <nav className="v30Nav">
          <a className="active" href="#engine">⌂ <span>Dashboard</span><b>LIVE</b></a>
          <a href="#chart">◫ <span>Live Market</span></a>
          <a href="#bot-control">◈ <span>Bot Control</span></a>
          <a href="#open-trades">▣ <span>Open Trades</span></a>
          <a href="#transactions">☷ <span>Transactions</span></a>
          <a href="#performance">◔ <span>Performance</span></a>
          <a href="#recovery">◇ <span>Recovery Control</span></a>
          <a href="#settings">⚙ <span>Settings</span></a>
        </nav>
        <div className="v30BotCard">
          <div className="v30BotTop"><span>ACTIVE BOT</span><b className={running ? "on" : ""}><i />{running ? "RUNNING" : "READY"}</b></div>
          <div className="v30BotOrb">✦</div>
          <strong>DerivAI Bot</strong>
          <small>{running ? "Analyzing live market" : "Ready to analyze"}</small>
          <div className="v30BotMini"><span>Signals<strong>{botState.runs}</strong></span><span>Win rate<strong>{winRate.toFixed(0)}%</strong></span></div>
        </div>
        <div className="v30Footer">DERIVAI v1.0.0<br />Dashboard only · © 2026</div>
      </aside>

      <main className="v30Main" id="engine">
        <header className="v30Topbar">
          <div className="v30TopLeft">
            <select className="v30Market" value={effectiveSymbol} disabled>
              <option value="1HZ100V">Volatility 100 (1s)</option>
            </select>
            <span className={`v30Connection ${connected ? "connected" : "error"}`}><i />{connected ? "LIVE CONNECTED" : (loadingMarket ? "CONNECTING…" : status || "DISCONNECTED")}</span>
          </div>
          <div className="v30TopRight">
            <span className="v30Server">Server Time<strong>{new Date().toLocaleTimeString()}</strong></span>
            <div className="v30Account">
              <span>◉</span>
              <select aria-label="Deriv account" value={selectedId} disabled={busy || accountBusy} onChange={(e) => { void selectAccount(e.target.value); }}>
                {accountOptions.length ? accountOptions.map((account) => <option key={account.id} value={account.id}>{account.type === "demo" || account.type === "virtual" ? "DEMO" : "REAL"} · {account.label} · {Number(account.balance || 0).toFixed(2)} {account.currency}</option>) : <option value="">{auth.authenticated ? "No Deriv accounts" : "Connect Deriv Account"}</option>}
              </select>
              <small>{!auth.authenticated ? "Login required" : isDemo ? "Demo / VRTC · bot execution available" : "REAL selected · bot locked"}</small>
            </div>
            <button className="v30AccountRefresh" type="button" disabled={accountBusy} onClick={() => { if (!auth.authenticated) auth.login(); else void refreshAccounts(); }}>↻</button>
            <button className="v30Logout" type="button" onClick={() => { if (!auth.authenticated) auth.login(); else disconnect(); }}>{auth.authenticated ? "↪" : "↗"}</button>
          </div>
        </header>

        <section className="v30Hero">
          <div><div className="v30Eyebrow">DERIVAI · LIVE TRADING DASHBOARD</div><h1>Trading Command Center</h1><p>One market · live analysis · bot execution · transaction monitoring</p></div>
          <div className={`v30Feed ${connected ? "on" : ""}`}><i />{connected ? "Deriv market feed is live" : "Deriv feed offline"}<button type="button" onClick={async () => { setConnectionError(""); try { if (connected) disconnect(); else await connect(); } catch (error) { setConnectionError(error?.message || "Unable to connect to Deriv."); } }}>{connected ? "Disconnect" : "Connect"}</button></div>
        </section>

        <section className="v30Summary">
          <article className="v30Card signalHero"><div className="radar">{/CALL|RISE|OVER|EVEN|MATCH/i.test(signal) ? "↑" : "↓"}</div><div><span>AI LIVE SIGNAL</span><strong>{signal}</strong><small>Confidence <b>{confidence.toFixed(1)}%</b></small></div></article>
          <article className="v30Card"><span>ACCOUNT BALANCE</span><strong className="v30MetricBig">{accountBalance.toFixed(2)} {selectedAccount?.currency || "USD"}</strong><small>{isDemo ? "DEMO / VRTC" : "REAL ACCOUNT"}</small></article>
          <article className="v30Card"><span>LIVE PRICE</span><strong className="v30MetricBig">{Number.isFinite(currentPrice) ? currentPrice.toFixed(market?.decimals ?? 2) : "—"}</strong><small>{effectiveSymbol}</small></article>
          <article className="v30Card"><span>TOTAL TRADES</span><strong className="v30MetricBig">{botState.runs}</strong><small>{botState.wins} wins · {botState.losses} losses</small></article>
          <article className="v30Card"><span>NET PROFIT</span><strong className="v30MetricBig" style={{color:netProfit >= 0 ? "#16a66a" : "#ef4444"}}>{netProfit >= 0 ? "+" : ""}{netProfit.toFixed(2)} USD</strong><small>Current session</small></article>
        </section>

        {(statusDetail || connectionError) ? <div className="v29Notice"><strong>{connectionError ? "BOT CHECK" : "FEED STATUS"}</strong><span>{connectionError || statusDetail}</span></div> : null}

        <section className="v30Workspace" id="chart">
          <div className="v30Center">
            <article className="v30Card v30ChartCard">
              <div className="v30CardHead"><div><span>LIVE MARKET · CANDLESTICK ANALYSIS <em>● LIVE</em></span><strong>{Number.isFinite(currentPrice) ? currentPrice.toFixed(market?.decimals ?? 2) : "—"}</strong></div><span>Volatility 100 (1s)</span></div>
              <CandlestickChart prices={prices} currentPrice={currentPrice} signal={signal} confidence={confidence} />
            </article>

            <div className="v30AnalyticsGrid">
              <article className="v30Card walkCard" id="bot-control"><div className="v30CardHead"><div><span>BOT CONTROL</span><strong>DerivAI · {running ? "Running" : "Ready"}</strong></div><span>{executionReady ? "EXECUTION READY" : "WAITING"}</span></div><div className="v30WFTop"><Stat label="WIN RATE" value={`${winRate.toFixed(1)}%`} tone="green" /><Stat label="WINS" value={botState.wins} tone="green" /><Stat label="LOSSES" value={botState.losses} tone="red" /></div><div className="v30WFBottom"><Stat label="LIVE HISTORY" value={`${historySize}/500`} /><Stat label="LAST DIGIT" value={lastDigit ?? "—"} /><Stat label="LOSS STREAK" value={botState.consecutiveLosses} /></div></article>
              <article className="v30Card equityCard" id="performance"><div className="v30CardHead"><div><span>SESSION PERFORMANCE</span><strong>Equity curve</strong></div><span>{netProfit >= 0 ? "POSITIVE" : "NEGATIVE"}</span></div>{equityPath ? <svg viewBox="0 0 520 110" preserveAspectRatio="none"><path className="line purple" d={equityPath} /></svg> : <div className="v30Empty">Trades will build the live equity curve.</div>}</article>
            </div>
          </div>

          <aside className="v30Right">
            <article className="v30Card tradeCard" id="settings">
              <div className="v30PurpleHead"><span>◉ BOT SETTINGS</span><small>{isDemo ? "DEMO SAFE" : "LOCKED"}</small></div>
              <label>Stake (USD)<Stepper value={settings.stake} min={0.35} max={100} step={0.5} disabled={busy} onChange={(v) => setNumber("stake", v)} /></label>
              <label>Stop Loss (R)<Stepper value={settings.stopLoss} min={0} max={100} step={1} disabled={busy} onChange={(v) => setNumber("stopLoss", v)} /></label>
              <label>Take Profit (R)<Stepper value={settings.takeProfit} min={0} max={100} step={1} disabled={busy} onChange={(v) => setNumber("takeProfit", v)} /></label>
              <label>Duration<select value={settings.duration} disabled={busy} onChange={(e) => setNumber("duration", Number(e.target.value))}><option value="1">1 Tick</option><option value="2">2 Ticks</option><option value="3">3 Ticks</option><option value="5">5 Ticks</option></select></label>
              <button className="v30Start" type="button" disabled={busy || !auth.authenticated || !selectedId || !isDemo || !connected || historySize < 8 || accountBusy} onClick={startBot}>▶ {busy ? "BOT RUNNING" : "START DEMO BOT"}</button>
              <button className="v30Stop" type="button" disabled={!busy} onClick={stopBot}>■ STOP BOT</button>
              <div className={`v30BotReady ${connected && historySize >= 8 && isDemo && executionReady ? "ready" : ""}`}><i />{!auth.authenticated ? "Connect your Deriv account." : !selectedId ? "Choose a Deriv account." : !isDemo ? "REAL account selected. Bot execution is locked." : !connected ? "Connect the market feed." : historySize < 8 ? `Calibrating live feed… ${historySize}/8 ticks.` : !executionReady ? "Preparing demo execution…" : botState.message}</div>
            </article>

            <article className="v30Card openTradeCard" id="open-trades"><div className="sectionTitle">OPEN TRADE · LIVE</div>{liveOpenTrade || botState.activeContractId ? <><div className="tradeRow"><span>Contract</span><strong>#{liveContractId || "—"}</strong></div><div className="tradeRow"><span>Market</span><strong>{effectiveSymbol}</strong></div><div className="tradeRow"><span>Type</span><strong>{botState.activeSetup || liveOpenTrade?.contract_type || "—"}</strong></div><div className="tradeRow"><span>Entry</span><strong>{liveOpenTrade?.entry_spot ?? liveOpenTrade?.entrySpot ?? "—"}</strong></div><div className="tradeRow"><span>Current P/L</span><strong className={liveProfit >= 0 ? "tradeLive" : "txLoss"}>{liveProfit >= 0 ? "+" : ""}{liveProfit.toFixed(2)} USD</strong></div><div className="tradeRow"><span>Status</span><strong className="tradeLive">LIVE</strong></div></> : <div className="zaNoOpen">No open trade. The bot will show a live contract here immediately after execution.</div>}</article>

            <article className="v30Card perfCard" id="recovery"><div className="v30PurpleHead"><span>◉ RECOVERY CONTROL</span><small>{settings.martingaleEnabled ? "ENABLED" : "SAFE MODE"}</small></div><div className="v30PerfBody"><div className="v30Donut" style={{"--p":`${Math.min(100, winRate)}%`}}><strong>{winRate.toFixed(0)}%</strong><small>Win Rate</small></div><div className="v30PerfStats"><span>Consecutive Losses<b>{botState.consecutiveLosses}</b></span><span>Max Losses<b>{settings.maxConsecutiveLosses}</b></span><span>Recovery<b className="green">{settings.martingaleEnabled ? "ON" : "OFF"}</b></span><span>Net P/L<b className={netProfit >= 0 ? "green" : "red"}>{netProfit >= 0 ? "+" : ""}{netProfit.toFixed(2)}</b></span></div></div><div className="v30Excellent">Controlled recovery · no uncontrolled stake escalation</div></article>
          </aside>
        </section>

        <section className="v30Card transactions" id="transactions"><div className="v30TxHead"><div><span>▣ TRANSACTIONS</span><small>Live Deriv transaction stream + bot ledger</small></div><select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="ALL">All</option><option value="WIN">Wins</option><option value="LOSS">Losses</option></select></div><div className="v30TableWrap"><table><thead><tr><th>ID</th><th>TIME</th><th>TYPE</th><th>MARKET</th><th>STAKE</th><th>ENTRY</th><th>EXIT</th><th>RESULT</th><th>P/L</th><th>STATUS</th></tr></thead><tbody>{displayTransactions.length ? displayTransactions.slice(0, 10).map((item, index) => { const result = String(item.result || item.status || "").toUpperCase(); const profit = Number(item.profit ?? item.profit_loss ?? 0); return <tr key={`${item.id || item.transaction_id || index}-${item.time || index}`}><td>#{item.id || item.transaction_id || 1000 + index}</td><td>{item.time ? new Date(Number(item.time) > 1e12 ? Number(item.time) : Number(item.time) * 1000).toLocaleTimeString() : "—"}</td><td><b className="txType">{item.setup || item.action || botState.activeSetup || item.contract_type || "TRADE"}</b></td><td>{item.symbol || effectiveSymbol}</td><td>{Number(item.stake ?? item.amount ?? settings.stake).toFixed(2)}</td><td>{item.entrySpot ?? item.entry_spot ?? "—"}</td><td>{item.exitSpot ?? item.exit_spot ?? "—"}</td><td><b className={result === "WIN" || result === "WON" ? "txWin" : result === "LOSS" || result === "LOST" ? "txLoss" : ""}>{item.result || item.status || "—"}</b></td><td className={profit >= 0 ? "txWin" : "txLoss"}>{profit >= 0 ? "+" : ""}{profit.toFixed(2)}</td><td><span className="settled">{item.status || "Settled"}</span></td></tr>; }) : <tr><td colSpan="10" className="v30NoTx">No transactions yet — run the Demo Bot and live Deriv events will appear here.</td></tr>}</tbody></table></div></section>
      </main>
    </div>
  );
}