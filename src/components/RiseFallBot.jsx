import { useEffect, useMemo, useRef, useState } from "react";
import useDerivTicks from "../hooks/useDerivTicks";
import { useDerivAuth } from "../auth/DerivAuthContext";
import { analyzeRiseFall } from "../analysis/riseFallEngine";
import { createRiskManager } from "../bot/riskManager";
import "../styles/RiseFallBot.css";

const pct = (value) => `${Number(value || 0).toFixed(1)}%`;
const money = (value, currency = "USD") => `${currency} ${Number(value || 0).toFixed(2)}`;
const idOf = (value) => String(value?.contract_id || value?.contractId || value?.id || value?.buy?.contract_id || value?.proposal_open_contract?.contract_id || "");
const profitOf = (value) => {
  const direct = Number(value?.profit ?? value?.profit_loss ?? value?.pnl);
  if (Number.isFinite(direct)) return direct;
  return Number(value?.sell_price || value?.payout || 0) - Number(value?.buy_price || value?.purchase_price || 0);
};
const settled = (value) => Boolean(value?.is_sold || value?.is_expired || ["won", "lost", "sold", "expired", "settled"].includes(String(value?.status || value?.contract_status || "").toLowerCase()));
const timeOf = (value) => {
  const epoch = Number(value?.date_start || value?.transaction_time || value?.date || value?.purchase_time || value?.epoch);
  if (!Number.isFinite(epoch)) return "â€”";
  return new Date(epoch * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

export default function RiseFallBot() {
  const auth = useDerivAuth();
  const {
    markets = [], market = null, symbol = "", status = "DISCONNECTED", statusDetail = "", connected = false,
    authenticatedFeed = false, selectedAccountType = "demo", selectedAccount = null, prices = [], currentPrice = null,
    openContracts = [], transactions = [], tradeBusy = false, tradeError = "", connect, disconnect, changeSymbol, placeTrade,
  } = useDerivTicks();

  const currency = String(selectedAccount?.currency || "USD").toUpperCase();
  const [running, setRunning] = useState(false);
  const [stake, setStake] = useState(0.35);
  const [duration, setDuration] = useState(5);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [allowReal, setAllowReal] = useState(false);
  const [message, setMessage] = useState("Scanner ready.");
  const riskRef = useRef(createRiskManager());
  const busyRef = useRef(false);
  const processedRef = useRef(new Set());
  const lastAutoSignalRef = useRef("");
  const lastAutoAttemptRef = useRef(0);

  const analysis = useMemo(() => analyzeRiseFall(prices, { minimumSamples: 60, minimumConfidence: 68 }), [prices]);
  const risk = riskRef.current.snapshot();
  const winRate = risk.wins + risk.losses ? (risk.wins / (risk.wins + risk.losses)) * 100 : 0;
  const price = Number.isFinite(currentPrice) ? currentPrice.toFixed(market?.decimals ?? 3) : "â€”";

  useEffect(() => {
    for (const contract of openContracts) {
      if (!settled(contract)) continue;
      const id = idOf(contract);
      if (!id || processedRef.current.has(id)) continue;
      processedRef.current.add(id);
      riskRef.current.onResult(id, profitOf(contract));
    }
  }, [openContracts]);

  const execute = async (source = "manual") => {
    if (busyRef.current) return;
    if (!connected) return setMessage("Connect the Deriv feed first.");
    if (!authenticatedFeed) return setMessage("Authenticated trading feed is not ready.");
    if (analysis.signal === "WAIT" || !analysis.READY) return setMessage("No qualified Rise/Fall signal.");
    if (String(selectedAccountType).toLowerCase() === "real" && !allowReal) return setMessage("REAL ACCOUNT LOCKED.");
    const gate = riskRef.current.canTrade();
    if (!gate.ok) return setMessage(gate.reason);
    busyRef.current = true;
    setMessage(`${source === "auto" ? "Auto" : "Manual"}: executing ${analysis.signal} ${analysis.confidence}%...`);
    try {
      const result = await placeTrade({ contractType: analysis.contractType, amount: Number(stake), basis: "stake", duration: Number(duration), durationUnit: "t", symbol });
      const id = idOf(result);
      riskRef.current.onEntry(id);
      setMessage(`${analysis.signal} opened${id ? ` #${id}` : ""}. Waiting for result...`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Trade failed.");
    } finally { busyRef.current = false; }
  };

  useEffect(() => {
    if (!running || !analysis.READY || analysis.signal === "WAIT") return;
    const now = Date.now();
    const signalKey = `${symbol}:${analysis.signal}`;
    if (signalKey === lastAutoSignalRef.current && now - lastAutoAttemptRef.current < 3000) return;
    if (signalKey === lastAutoSignalRef.current) return;
    lastAutoSignalRef.current = signalKey;
    lastAutoAttemptRef.current = now;
    void execute("auto");
  }, [analysis, authenticatedFeed, running, symbol]);

  const toggle = () => {
    if (running) {
      setRunning(false); setMessage("Bot stopped."); lastAutoSignalRef.current = ""; return;
    }
    riskRef.current.reset(); processedRef.current.clear(); lastAutoSignalRef.current = ""; lastAutoAttemptRef.current = 0;
    setRunning(true); setMessage("Bot scanning live ticks and waiting for a qualified signal.");
  };

  const recentTrades = transactions.filter((tx) => tx?.action === "buy" || tx?.transaction?.action === "buy" || tx?.contract_id || tx?.buy_price).slice(0, 8);
  const open = openContracts.filter((c) => !settled(c)).slice(0, 8);
  const chartPrices = prices.slice(-90);

  return (
    <section className="rfBot">
      <header className="rfHero">
        <div className="rfHeroCopy">
          <small>DERIV RISE / FALL ENGINE</small>
          <h1>Pulse Rise/Fall</h1>
          <p>Real-time ticks â€¢ Smart analysis â€¢ Trade with confidence</p>
        </div>
        <div className="rfHeroQuote">â€œSMALL STEPS<br /><b>BIG RESULTS</b>â€</div>
        <div className="rfConnection"><span className={connected ? "rfDot live" : "rfDot"} />{connected ? (authenticatedFeed ? "LIVE TRADING" : "LIVE FEED") : status}</div>
      </header>

      <div className="rfAccountBalance">
        <div><small>ACCOUNT</small><strong>{selectedAccountType === "real" ? "REAL" : "DEMO"}</strong><span>{selectedAccount?.id || "â€”"}</span></div>
        <div className="rfBalance"><small>BALANCE</small><strong>{Number.isFinite(Number(selectedAccount?.balance)) ? money(selectedAccount.balance, currency) : "â€”"}</strong><span>{auth.balanceStatus === "live" ? "LIVE BALANCE" : auth.balanceStatus === "connecting" ? "CONNECTING" : "BALANCE OFFLINE"}</span></div>
      </div>

      <div className="rfTradeControls">
        <label>Market<select value={symbol} disabled={!connected} onChange={(e) => void changeSymbol(e.target.value)}>{markets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>Stake ({currency})<div className="rfInputGroup"><input type="number" min="0.35" step="0.01" value={stake} onChange={(e) => setStake(Math.max(0.35, Number(e.target.value) || 0.35))} /><button type="button" onClick={() => setStake((v) => Math.max(0.35, v - 0.05))}>âˆ’</button><button type="button" onClick={() => setStake((v) => v + 0.05)}>+</button></div></label>
        <label>Duration<div className="rfInputGroup"><select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>{[1,2,3,5,8,10].map((v) => <option key={v} value={v}>{v}</option>)}</select><span>Ticks</span></div></label>
        <button className="rfBigTrade rise" disabled={tradeBusy || !analysis.READY || analysis.signal === "FALL"} onClick={() => { if (analysis.signal === "RISE") void execute("manual"); }}>â–² RISE<small>Higher than entry</small></button>
        <button className="rfBigTrade fall" disabled={tradeBusy || !analysis.READY || analysis.signal === "RISE"} onClick={() => { if (analysis.signal === "FALL") void execute("manual"); }}>â–¼ FALL<small>Lower than entry</small></button>
      </div>

      <div className="rfMarketGrid">
        <div className="rfChartCard">
          <div className="rfCardHead"><div><b>{market?.label || "Market"}</b><span className="liveLabel">â— Live</span></div><div className="rfPrice">{price} <small>{currency}</small></div></div>
          <div className="rfChartTabs"><span className="active">Ticks</span><span>1M</span><span>5M</span><span>15M</span></div>
          <MiniChart values={chartPrices} />
        </div>
        <div className="rfAiCard"><div className="rfCardHead"><b>AI ANALYSIS</b><span className="rfPill">{analysis.momentum || "WAIT"}</span></div><Metric label="Trend" value={analysis.trend || "WAIT"}/><Metric label="Momentum" value={analysis.momentum || "WAIT"}/><Metric label="Volatility" value={analysis.volatility || "WAIT"}/><div className="rfConfidenceBar"><span>Confidence</span><b>{analysis.READY ? pct(analysis.confidence) : "WAIT"}</b><i><em style={{width:`${Math.max(2, analysis.confidence || 0)}%`}} /></i></div><div className="rfNext"><span>Next Signal</span><b>{analysis.signal}</b></div></div>
        <div className="rfStatsCard"><div className="rfCardHead"><b>SESSION STATS</b><button type="button" onClick={() => riskRef.current.reset()}>Reset</button></div><Stat label="Trades" value={`${risk.trades}/10`}/><Stat label="Wins" value={risk.wins}/><Stat label="Losses" value={risk.losses}/><Stat label="Win rate" value={pct(winRate)}/><Stat label="Session P/L" value={money(risk.sessionPnl, currency)}/></div>
      </div>

      <div className="rfTables">
        <TradeTable title="OPEN TRADES" count={open.length} rows={open} open currency={currency}/>
        <TradeTable title="RECENT TRADES" rows={recentTrades} currency={currency}/>
      </div>

      <div className="rfBottomBar"><span className={connected ? "ok" : ""}>â— Deriv API {connected ? "Connected" : "Offline"}</span><span className={connected ? "ok" : ""}>â— Live market feed</span><span>â— {selectedAccountType === "real" ? "Real" : "Demo"} Account</span><span className="spacer">Server Time: {new Date().toLocaleTimeString()} (GMT+3)</span><span>â— Ping: â€”</span></div>

      <div className="rfActions"><button onClick={() => (connected ? disconnect() : connect())}>{connected ? "Disconnect" : "Connect"}</button><button className={running ? "danger" : "primary"} onClick={toggle}>{running ? "STOP BOT" : "START BOT"}</button><label className="realToggle"><input type="checkbox" checked={allowReal} onChange={(e) => setAllowReal(e.target.checked)} disabled={selectedAccountType !== "real"}/> ALLOW REAL</label><button className="rfSettings" onClick={() => setSettingsOpen((v) => !v)}>{settingsOpen ? "Hide Risk" : "Risk"}</button></div>
      {settingsOpen && <div className="rfRiskPanel"><span>Max session loss <b>{money(3, currency)}</b></span><span>Max trades <b>10</b></span><span>Max open <b>1</b></span><span>2 losses <b>60s pause</b></span></div>}
      <div className="rfStatus"><span>{running ? "SCANNING" : "READY"}</span><span>{message}</span></div>
      {(statusDetail || tradeError) && <div className="rfError">{tradeError || statusDetail}</div>}
    </section>
  );
}

function Metric({ label, value }) { return <div className="rfMetricRow"><span>{label}</span><b>{value}</b></div>; }
function Stat({ label, value }) { return <div className="rfStatRow"><span>{label}</span><b>{value}</b></div>; }
function TradeTable({ title, count, rows, open, currency }) {
  return <div className="rfTableCard"><div className="rfTableTitle"><b>{title} {typeof count === "number" ? `(${count})` : ""}</b><span>{open ? "" : "View All"}</span></div><div className="rfTableHead"><span>#</span><span>TIME</span><span>MARKET</span><span>TYPE</span><span>STAKE</span><span>{open ? "CURRENT" : "P/L"}</span><span>STATUS</span></div>{rows.length ? rows.map((row, i) => { const pnl = profitOf(row); return <div className="rfTableRow" key={idOf(row) || `${title}-${i}`}><span>{i+1}</span><span>{timeOf(row)}</span><span>{row.symbol || row.underlying || row.display_name || "1HZ100V"}</span><span>{row.contract_type || row.type || row.action || "â€”"}</span><span>{money(row.buy_price || row.purchase_price || row.amount || row.stake, currency)}</span><span>{open ? money(row.bid_price || row.current_spot || row.sell_price || 0, currency) : money(pnl, currency)}</span><span className={settled(row) ? (pnl >= 0 ? "win" : "loss") : "liveState"}>{settled(row) ? (pnl >= 0 ? "WON" : "LOST") : "OPEN"}</span></div>; }) : <div className="rfEmpty"><strong>{open ? "No open trades" : "No trade history yet"}</strong><span>{open ? "Your active trades will appear here" : "Your completed trades will appear here"}</span></div>}</div>;
}
function MiniChart({ values }) {
  if (!values.length) return <div className="rfEmpty chartEmpty"><strong>Waiting for live ticks</strong><span>Connect to load the chart.</span></div>;
  const w=760,h=240,p=22; const nums=values.map(v=>Number(v.quote)).filter(Number.isFinite); const min=Math.min(...nums),max=Math.max(...nums); const range=max-min || 1;
  const points=nums.map((v,i)=>`${p+(i/Math.max(1,nums.length-1))*(w-p*2)},${h-p-((v-min)/range)*(h-p*2)}`).join(" ");
  return <svg className="rfChart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"><defs><linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="rgba(20,220,180,.35)"/><stop offset="1" stopColor="rgba(20,220,180,0)"/></linearGradient></defs>{[.2,.4,.6,.8].map((n)=><line key={n} x1="0" x2={w} y1={h*n} y2={h*n} className="gridLine"/>)}<polyline points={`${p},${h-p} ${points} ${w-p},${h-p}`} className="chartArea"/><polyline points={points} className="chartLine"/></svg>;
}

