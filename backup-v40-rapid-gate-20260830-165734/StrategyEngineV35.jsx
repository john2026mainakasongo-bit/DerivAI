import { useEffect, useMemo, useRef, useState } from "react";
import useDerivTicks from "../hooks/useDerivTicks";
import { useDerivAuth } from "../auth/DerivAuthContext";
import derivPublicClient from "../services/derivApi";
import DerivBotEngine from "../bot/DerivBotEngine";
import { analyzeUnifiedSignals } from "../analysis/v71UnifiedSignalEngine";
import { buildValidatedSignals } from "../analysis/backtestEngine";
import { buildEntryTiming } from "../analysis/entryTimingEngine";
import { buildProfessionalDecision } from "../analysis/professionalDecisionEngine";
import { analyzeRapidEntry } from "../analysis/rapidEntryEngine";
import "../styles/StrategyEngineV35.css";

const INITIAL_SETTINGS = {
  maxRuns: 56,
  stake: 1,
  duration: 1,
  analysisTimeframe: 30,
  minConfidence: 68,
  minVotes: 2,
  takeProfit: 4,
  stopLoss: 2,
  maxConsecutiveLosses: 3,
  delaySeconds: 0,
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
  activeSetup: "Ã¢â‚¬â€",
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
        <button type="button" disabled={disabled || safe <= min} onClick={() => change(-step)}>Ã¢Ë†â€™</button>
        <button type="button" disabled={disabled || safe >= max} onClick={() => change(step)}>+</button>
      </div>
    </div>
  );
}

export default function StrategyEngineV35() {
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
  } = useDerivTicks();

  const effectiveSymbol = symbol || "1HZ100V";
  const selectedId = accountId(auth.selectedAccount);
  const selectedAccount = auth.selectedAccount || {};
  const selectedLoginId = accountId(selectedAccount);
  const selectedAccountKind = String(
    auth.selectedAccountType || selectedAccount.type || selectedAccount.account_type || selectedAccount.accountType || ""
  ).toLowerCase();
  // V35: VRTC/virtual accounts are the safe executable lane; REAL remains selectable but locked.
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
  const rapidEntry = useMemo(() => analyzeRapidEntry({ ...snapshot, decimals: market?.decimals ?? 3 }, settings.analysisTimeframe), [snapshot, settings.analysisTimeframe, market?.decimals]);
  const validatedSignals = useMemo(() => buildValidatedSignals(snapshot), [snapshot]);
  const entryTiming = useMemo(() => buildEntryTiming(validatedSignals, snapshot, { tradeTicks: settings.duration, validitySeconds: 15 }), [validatedSignals, snapshot, settings.duration]);
  const professionalDecision = useMemo(() => buildProfessionalDecision(snapshot, validatedSignals), [snapshot, validatedSignals]);
  const unified = useMemo(() => analyzeUnifiedSignals({ ...snapshot, minimumConfidence: settings.minConfidence }), [snapshot, settings.minConfidence]);

  const displayBest = rapidEntry?.best || rapidEntry?.candidate || unified?.digit?.best || null;
  const best = rapidEntry?.best || unified?.digit?.best || null;
  const signal = displayBest?.setup || professionalDecision?.setup || "WAIT";
  const confidence = Number(displayBest?.confidence ?? displayBest?.qualityScore ?? displayBest?.probability ?? professionalDecision?.confidence ?? 0);
  const rapidGateStatus = rapidEntry?.gateStatus || (rapidEntry?.executable ? "READY" : "WAITING");

  // Feed the live analysis into the execution engine on every fresh tick.
  // The previous V35 build could start the UI loop but never supplied a signal.
  useEffect(() => {
    engineRef.current?.setAccountMode({ isDemo });
    const latestTick = prices?.at?.(-1);
    engineRef.current?.updateSignal({
      symbol: effectiveSymbol,
      updatedAt: Number(latestTick?.epoch ? latestTick.epoch * 1000 : Date.now()),
      tickKey: String(latestTick?.epoch ?? `${effectiveSymbol}-${lastDigit}-${currentPrice}`),
      quoteTime: latestTick?.epoch,
      probability: rapidEntry?.probability ?? confidence,
      confidence,
      digitHistory,
      recentDigits: digitHistory?.slice(-120),
      analysis: {
        ...rapidEntry,
        probability: rapidEntry?.probability ?? confidence,
        confidence,
        selectedProbability: rapidEntry?.probability ?? confidence,
        selectedEdge: rapidEntry?.edge ?? 0,
        candidates: [
          ...(rapidEntry?.candidates || []),
          ...(unified?.digit?.candidates || []),
        ],
        digitHistory,
        recentDigits: digitHistory?.slice(-120),
      },
    });
  }, [isDemo, effectiveSymbol, prices, lastDigit, currentPrice, digitHistory, rapidEntry, unified, confidence]);
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
      // V35 fixes the V35 deadlock: Start establishes the authenticated
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
    if (historySize < 18) {
      setConnectionError(`Collecting rapid-entry history. ${historySize}/18 ticks loaded.`);
      return;
    }

    try {
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

  return (
    <div className="v30Shell">
      <aside className="v30Sidebar">
        <div className="v30Brand"><div className="v30BrandMark">Ã¢Å“Â¦</div><div><strong>Deriv<span>AI</span></strong><small>Strategy Engine</small></div></div>
        <div className="v30LivePill"><i /> DERIV LIVE</div>
        <nav className="v30Nav">
          <a className="active" href="#engine">Ã¢Å’â€š <span>Strategy Engine</span><b>LIVE</b></a>
          <a href="#transactions">Ã¢â€“Â£ <span>Bot Transactions</span></a>
          <a href="#performance">Ã¢â€”â€ <span>Performance</span></a>
          <a href="#settings">Ã¢Å¡â„¢ <span>Settings</span></a>
        </nav>
        <div className="v30BotCard">
          <div className="v30BotTop"><span>BOT STATUS</span><b className={running ? "on" : ""}><i />{running ? "ACTIVE" : "READY"}</b></div>
          <div className="v30BotOrb">Ã¢â€”â€°</div>
          <strong>DerivAI Bot</strong>
          <small>{running ? "Running smoothly" : "Ready to trade"}</small>
          <div className="v30BotMini"><span>Trades<strong>{botState.runs}</strong></span><span>Win rate<strong>{winRate.toFixed(0)}%</strong></span></div>
        </div>
        <div className="v30Footer">Ã‚Â© 2026 DerivAI<br />All rights reserved.</div>
      </aside>

      <main className="v30Main" id="engine">
        <header className="v30Topbar">
          <div className="v30TopLeft">
            <select
              className="v30Market"
              value={effectiveSymbol}
              disabled={busy || loadingMarket}
              onChange={(e) => {
                setConnectionError("");
                if (typeof changeSymbol === "function") changeSymbol(e.target.value);
              }}
            >
              {(Array.isArray(markets) && markets.length ? markets : [{ symbol: "1HZ100V", label: "1HZ100V" }]).map((item, index) => {
                const value = String(item?.symbol || item?.code || item?.id || item || "1HZ100V");
                const label = String(item?.label || item?.display_name || item?.name || value);
                return <option key={`${value}-${index}`} value={value}>{label}</option>;
              })}
            </select>
            <span className={`v30Connection ${connected ? "connected" : "error"}`}><i />{connected ? "CONNECTED" : (loadingMarket ? "CONNECTINGÃ¢â‚¬Â¦" : status || "DISCONNECTED")}</span>
          </div>
          <div className="v30TopRight">
            <span className="v30Server">Server Time<strong>{new Date().toLocaleTimeString()}</strong></span>
            <span className="v30Icon">Ã¢Å¡â„¢</span><span className="v30Icon">Ã¢ËœÂ¾</span>
            <div className="v30Account">
              <span>Ã¢â€”â€°</span>
              <select
                aria-label="Deriv account"
                value={selectedId}
                disabled={busy || accountBusy}
                onChange={(e) => { void selectAccount(e.target.value); }}
              >
                {accountOptions.length ? accountOptions.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.type === "demo" || account.type === "virtual" ? "DEMO" : "REAL"} Ã‚Â· {account.label} Ã‚Â· {Number(account.balance || 0).toFixed(2)} {account.currency}
                  </option>
                )) : <option value="">{auth.authenticated ? "No Deriv accounts Ã¢â‚¬â€ Refresh" : "Connect Deriv Account"}</option>}
              </select>
              <small>{!auth.authenticated ? "Login required" : isDemo ? "Demo / VRTC Ã‚Â· execution ready" : "REAL selected Ã‚Â· bot locked"}</small>
            </div>
            <button
              className="v30AccountRefresh"
              type="button"
              title="Refresh Deriv accounts"
              disabled={accountBusy}
              onClick={() => {
                if (!auth.authenticated) auth.login();
                else void refreshAccounts();
              }}
            >Ã¢â€ Â»</button>
            <button
              className="v30Logout"
              type="button"
              onClick={() => {
                if (!auth.authenticated) auth.login();
                else disconnect();
              }}
              title={auth.authenticated ? "Disconnect market feed" : "Connect Deriv account"}
            >{auth.authenticated ? "Ã¢â€ Âª" : "Ã¢â€ â€”"}</button>
          </div>
        </header>

        <section className="v30Hero">
          <div><div className="v30Eyebrow">CALIBRATED STRATEGY ENGINE Ã‚Â· V35</div><h1>Deriv Strategy Engine</h1><p>Live analysis Ã‚Â· Smart signals Ã‚Â· Real results</p></div>
          <div className={`v30Feed ${connected ? "on" : ""}`}>
            <i />{connected ? `Live feed Ã‚Â· ${effectiveSymbol}` : "Deriv feed offline"}
            <button type="button" onClick={async () => {
              setConnectionError("");
              try {
                if (connected) disconnect();
                else await connect();
              } catch (error) {
                setConnectionError(error?.message || "Unable to connect to Deriv.");
              }
            }}>{connected ? "Disconnect" : "Connect"}</button>
          </div>
        </section>

        <section className="v30Summary">
          <article className="v30Card signalHero"><div className="radar">Ã¢â€”Å½</div><div><span>CURRENT SIGNAL</span><strong>{signal}</strong><small>Confidence <b>{confidence.toFixed(1)}%</b></small><small className="rapidGateText">RAPID GATE: <b>{rapidGateStatus}</b></small></div></article>
          <article className="v30Card"><span>CURRENT DIGIT</span><div className="v30BigDigit">{lastDigit ?? "Ã¢â‚¬â€"}</div><Sparkline values={(digitHistory || []).slice(-50)} /></article>
          <article className="v30Card"><span>HISTORY</span><strong className="v30MetricBig">{historySize}/500</strong><div className="v30Progress"><i style={{ width: `${historyProgress}%` }} /></div><small>Digits collected</small></article>
          <article className="v30Card"><span>MODEL</span><strong className="v30Model">{model}</strong><small>Live calibrated state</small></article>
          <article className="v30Card riskCard"><span>RISK MODE</span><strong>FIXED / NO</strong><small>MARTINGALE</small><b>Ã¢â€”Ë†</b></article>
        </section>

        {(statusDetail || connectionError) ? <div className="v29Notice">
          <strong>{connectionError ? "CONNECTION / BOT CHECK" : "FEED STATUS"}</strong>
          <span>{connectionError || statusDetail}</span>
        </div> : null}

        <section className="v30Workspace">
          <div className="v30Center">
            <article className="v30Card v30ChartCard">
              <div className="v30CardHead"><div><span>LIVE MARKET FEED <em>Ã¢â€”Â LIVE</em></span><strong>{Number.isFinite(currentPrice) ? currentPrice.toFixed(market?.decimals ?? 2) : "Ã¢â‚¬â€"}</strong></div><div className="lastDigitBadge"><b>{lastDigit ?? "Ã¢â‚¬â€"}</b><small>Last Digit</small></div></div>
              <div className="v30Chart">{chartPath ? <svg viewBox="0 0 720 250" preserveAspectRatio="none"><path className="area" d={`${chartPath} L 720 250 L 0 250 Z`} /><path className="line" d={chartPath} /></svg> : <div className="v30Empty">Connect Deriv and wait for live ticks.</div>}</div>
              <div className="v30Digits">{Array.from({ length: 10 }, (_, digit) => { const count = (digitHistory || []).filter((d) => Number(d) === digit).length; const pct = historySize ? (count / historySize) * 100 : 0; return <div key={digit} className={digit === lastDigit ? "active" : ""}><b>{digit}</b><span>{pct.toFixed(1)}%</span></div>; })}</div>
            </article>

            <div className="v30AnalyticsGrid">
              <article className="v30Card walkCard"><div className="v30CardHead"><div><span>BOUNDED WALK-FORWARD TEST</span><strong>Strategy validation</strong></div><button type="button">View Details</button></div><div className="v30WFTop"><Stat label="WIN RATE" value={`${winRate.toFixed(1)}%`} tone="green" /><Stat label="WINS" value={botState.wins} tone="green" /><Stat label="LOSSES" value={botState.losses} tone="red" /></div><div className="v30WFBottom"><Stat label="TOTAL SIGNALS" value={botState.runs} /><Stat label="NORMALIZED R" value={`${netProfit >= 0 ? "+" : ""}${netProfit.toFixed(2)}R`} tone={netProfit >= 0 ? "green" : "red"} /><Stat label="MAX DRAWDOWN" value="1R" /><Stat label="MAX LOSS STREAK" value={botState.consecutiveLosses} /></div></article>
              <article className="v30Card equityCard"><div className="v30CardHead"><div><span>FORWARD TEST EQUITY</span><strong>Normalized R</strong></div></div>{equityPath ? <svg viewBox="0 0 520 110" preserveAspectRatio="none"><path className="line purple" d={equityPath} /></svg> : <div className="v30Empty small">Run the strategy to build equity.</div>}</article>
            </div>
          </div>

          <aside className="v30Right">
            <article className="v30Card tradeCard" id="settings">
              <div className="v30PurpleHead"><span>Ã¢â€”â€° TRADE CONTROL</span><small>{isDemo ? "DEMO SAFE" : "LOCKED"}</small></div>
              <label>Set Amount (USD)<Stepper value={settings.stake} min={0.35} max={100} step={0.5} disabled={busy} onChange={(v) => setNumber("stake", v)} /></label>
              <label>Stop Loss (R)<Stepper value={settings.stopLoss} min={0} max={100} step={1} disabled={busy} onChange={(v) => setNumber("stopLoss", v)} /></label>
              <label>Take Profit (R)<Stepper value={settings.takeProfit} min={0} max={100} step={1} disabled={busy} onChange={(v) => setNumber("takeProfit", v)} /></label>
              <label>Entry Analysis<select value={settings.analysisTimeframe} disabled={busy} onChange={(e) => setNumber("analysisTimeframe", Number(e.target.value))}><option value="30">30 Seconds Ã‚Â· RAPID</option><option value="60">1 Minute Ã‚Â· DEEP</option></select></label><label>Contract Duration<select value={settings.duration} disabled={busy} onChange={(e) => setNumber("duration", Number(e.target.value))}><option value="1">1 Tick (1s)</option><option value="2">2 Ticks (2s)</option><option value="3">3 Ticks (3s)</option><option value="5">5 Ticks (5s)</option></select></label>
              <button
                className="v30Start"
                type="button"
                disabled={busy || !auth.authenticated || !selectedId || !isDemo || !connected || historySize < 18 || accountBusy}
                onClick={startBot}
              >Ã¢â€“Â¶ {busy ? "BOT RUNNING" : executionReady ? "START DEMO BOT" : "CONNECT & START DEMO"}</button>
              <button className="v30Stop" type="button" disabled={!busy} onClick={stopBot}>Ã¢â€“Â  STOP BOT</button>
              <div className={`v30BotReady ${connected && historySize >= 8 && isDemo && executionReady ? "ready" : ""}`}>
                <i />{!auth.authenticated
                  ? "Connect your Deriv account to enable account selection and trading."
                  : !selectedId
                    ? "Choose a Deriv account."
                    : !isDemo
                      ? "REAL account selected. Bot execution is locked; switch to DEMO/VRTC."
                      : !connected
                        ? "Market feed is offline. Connect the Deriv feed."
                        : historySize < 18
                          ? `Calibrating rapid entryÃ¢â‚¬Â¦ ${historySize}/18 ticks.`
                          : !executionReady
                            ? "Authenticated demo trading connection is being preparedÃ¢â‚¬Â¦"
                            : botState.message}
              </div>
            </article>

            <article className="v30Card perfCard" id="performance"><div className="v30PurpleHead"><span>Ã¢â€”â€° PERFORMANCE SUMMARY</span></div><div className="v30PerfBody"><div className="v30Donut" style={{ "--p": `${Math.min(100, winRate)}%` }}><strong>{winRate.toFixed(0)}%</strong><small>Win Rate</small></div><div className="v30PerfStats"><span>Total Signals<b>{botState.runs}</b></span><span>Total Profit<b className="green">+{totalProfit.toFixed(2)} USD</b></span><span>Total Loss<b className="red">-{totalLoss.toFixed(2)} USD</b></span><span>Net Profit<b className={netProfit >= 0 ? "green" : "red"}>{netProfit >= 0 ? "+" : ""}{netProfit.toFixed(2)} USD</b></span></div></div><div className="v30Excellent">Ã¢â€ â€” Performance: {winRate >= 70 ? "EXCELLENT" : winRate >= 50 ? "STABLE" : "LEARNING"}</div></article>
          </aside>
        </section>

        <section className="v30Card transactions" id="transactions"><div className="v30TxHead"><div><span>Ã¢â€“Â£ BOT TRANSACTION VIEW</span><small>Live execution ledger</small></div><select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="ALL">All Transactions</option><option value="WIN">Wins</option><option value="LOSS">Losses</option></select></div><div className="v30TableWrap"><table><thead><tr><th>ID</th><th>TIME</th><th>TYPE</th><th>DURATION</th><th>AMOUNT</th><th>ENTRY</th><th>EXIT</th><th>RESULT</th><th>PROFIT/LOSS</th><th>STATUS</th></tr></thead><tbody>{transactions.length ? transactions.slice(0, 8).map((item, index) => <tr key={`${item.id || index}-${item.time || index}`}><td>#{item.id || 1000 + index}</td><td>{item.time ? new Date(item.time).toLocaleTimeString() : "Ã¢â‚¬â€"}</td><td><b className="txType">{item.setup || botState.activeSetup || "DIGIT"}</b></td><td>{settings.duration} Tick</td><td>{Number(item.stake ?? settings.stake).toFixed(2)}</td><td>{item.entrySpot ?? "Ã¢â‚¬â€"}</td><td>{item.exitSpot ?? "Ã¢â‚¬â€"}</td><td><b className={String(item.result).toLowerCase() === "win" ? "txWin" : "txLoss"}>{item.result || "Ã¢â‚¬â€"}</b></td><td className={Number(item.profit) >= 0 ? "txWin" : "txLoss"}>{Number(item.profit) >= 0 ? "+" : ""}{Number(item.profit || 0).toFixed(2)}</td><td><span className="settled">Settled</span></td></tr>) : <tr><td colSpan="10" className="v30NoTx">No transactions yet Ã¢â‚¬â€ start the Demo Bot to populate this view.</td></tr>}</tbody></table></div><button className="v30AllTx" type="button">Ã¢ËœÂ· View All Transactions</button></section>
      </main>
    </div>
  );
}

