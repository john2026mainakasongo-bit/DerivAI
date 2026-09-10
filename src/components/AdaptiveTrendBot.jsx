import {useEffect,useMemo,useRef,useState} from "react";
import useDerivTicks from "../hooks/useDerivTicks";
import {useDerivAuth} from "../auth/DerivAuthContext";
import analyzeAdaptiveTrend from "../analysis/adaptiveTrendEngine";
import "../styles/AdaptiveTrendBot.css";

const money=(v,c="USD")=>`$${Number(v||0).toFixed(2)} ${String(c).toUpperCase()}`;
const idOf=x=>String(x?.contract_id||x?.contractId||x?.id||x?.proposal_open_contract?.contract_id||"");
const settled=x=>Boolean(x?.is_sold||x?.is_expired||x?.is_settled||["won","lost","sold","expired","settled"].includes(String(x?.status||x?.contract_status||"").toLowerCase()));
const profit=x=>{const n=Number(x?.profit??x?.profit_loss??x?.pnl);return Number.isFinite(n)?n:0};

export default function AdaptiveTrendBot(){
 const auth=useDerivAuth();
 const {symbol,market,prices,currentPrice,openContracts,selectedAccount,selectedAccountType="demo",selectedAccountId,connected,status,statusDetail,placeTrade}=useDerivTicks();
 const [running,setRunning]=useState(false),[stake,setStake]=useState(.35),[duration,setDuration]=useState(5),[allowReal,setAllowReal]=useState(false);
 const [tp,setTp]=useState(2),[sl,setSl]=useState(1.5),[maxLosses,setMaxLosses]=useState(2),[cooldown,setCooldown]=useState(8);
 const [pnl,setPnl]=useState(0),[losses,setLosses]=useState(0),[message,setMessage]=useState("Scanner ready — demo first.");
 const busy=useRef(false),lastEntry=useRef(0),done=useRef(new Set());
 const analysis=useMemo(()=>analyzeAdaptiveTrend(prices),[prices]),currency=String(selectedAccount?.currency||"USD").toUpperCase();
 const active=openContracts?.find(x=>!settled(x)),real=String(selectedAccountType).toLowerCase()==="real";

 useEffect(()=>{for(const c of openContracts||[]){const id=idOf(c);if(!id||!settled(c)||done.current.has(id))continue;done.current.add(id);const p=profit(c);setPnl(x=>x+p);if(p<0)setLosses(x=>x+1);setMessage(`${p>=0?"WON":"LOST"} ${id} • ${p>=0?"+":""}${money(p,currency)}`)}},[openContracts,currency]);

 useEffect(()=>{if(!running)return;const t=setInterval(async()=>{if(busy.current||active||!selectedAccountId||!symbol)return;
   if(pnl>=Number(tp)){setRunning(false);setMessage(`TAKE PROFIT reached • ${money(pnl,currency)}`);return}
   if(pnl<=-Number(sl)){setRunning(false);setMessage(`STOP LOSS reached • ${money(pnl,currency)}`);return}
   if(losses>=Number(maxLosses)){setRunning(false);setMessage(`MAX LOSSES reached • ${losses}`);return}
   if(real&&!allowReal)return;
   if(analysis.signal==="WAIT"||analysis.grade!=="A+")return;
   if(Date.now()-lastEntry.current<Number(cooldown)*1000)return;
   busy.current=true;lastEntry.current=Date.now();setMessage(`A+ setup found • requesting ${analysis.signal} proposal...`);
   try{await placeTrade({contractType:analysis.signal==="RISE"?"CALL":"PUT",amount:Math.max(.35,Number(stake)||.35),basis:"stake",duration:Math.max(2,Number(duration)||5),durationUnit:"t",symbol});setMessage(`${analysis.signal} opened • monitoring contract...`)}
   catch(e){setMessage(e instanceof Error?e.message:"Entry rejected.")}finally{busy.current=false}
 },1200);return()=>clearInterval(t)},[active,allowReal,analysis,cooldown,currency,duration,losses,maxLosses,pnl,placeTrade,real,running,selectedAccountId,sl,stake,symbol,tp]);

 const reset=()=>{setRunning(false);setPnl(0);setLosses(0);done.current.clear();lastEntry.current=0;setMessage("Session reset — scanner ready.")};
 return <section className="adaptiveBot">
  <div className="adaptiveHeader"><div><span className="adaptiveEyebrow">ZENTORA • ADAPTIVE TREND V1</span><h2>Trend → Pullback → Proposal</h2><p>A+ setups only. The bot waits instead of forcing entries.</p></div><div className={`adaptiveRunState ${running?"on":""}`}>{running?"SCANNING":"STOPPED"}</div></div>
  <div className="adaptiveGrid">
   <div className="adaptivePanel"><div className="adaptivePanelTitle">LIVE STRATEGY</div><div className="adaptiveMetrics">
    <div><span>Trend</span><b>{analysis.trend}</b></div><div><span>Momentum</span><b>{analysis.momentum}</b></div><div><span>Pullback</span><b>{analysis.pullback}</b></div><div><span>RSI</span><b>{Number(analysis.rsi||50).toFixed(1)}</b></div>
    <div><span>Grade</span><b className={analysis.grade==="A+"?"good":""}>{analysis.grade}</b></div><div><span>Score</span><b>{analysis.score}/100</b></div><div><span>Confidence</span><b>{analysis.confidence}%</b></div><div><span>Volatility</span><b>{analysis.volatility}</b></div>
   </div><div className="adaptiveReason">{analysis.reason}</div><div className="adaptiveStatus"><span className={connected?"liveDot":"deadDot"}/><b>{status}</b><small>{statusDetail||"Waiting for Deriv feed"}</small></div></div>
   <div className="adaptivePanel"><div className="adaptivePanelTitle">RISK ENGINE</div><div className="adaptiveControls">
    <label>Stake<input type="number" min=".35" step=".01" value={stake} onChange={e=>setStake(e.target.value)}/></label>
    <label>Duration<input type="number" min="2" max="20" value={duration} onChange={e=>setDuration(e.target.value)}/></label>
    <label>Take profit<input type="number" min=".5" step=".5" value={tp} onChange={e=>setTp(e.target.value)}/></label>
    <label>Stop loss<input type="number" min=".5" step=".5" value={sl} onChange={e=>setSl(e.target.value)}/></label>
    <label>Max losses<input type="number" min="1" max="5" value={maxLosses} onChange={e=>setMaxLosses(e.target.value)}/></label>
    <label>Cooldown<input type="number" min="3" value={cooldown} onChange={e=>setCooldown(e.target.value)}/></label>
   </div><div className="adaptivePnl"><span>Session P/L</span><strong className={pnl>=0?"profit":"loss"}>{pnl>=0?"+":""}{money(pnl,currency)}</strong></div><div className="adaptivePnl"><span>Loss count</span><strong>{losses}/{maxLosses}</strong></div></div>
  </div>
  <div className="adaptiveActionBar"><div><b>{analysis.signal==="WAIT"?"WAITING FOR A+":`READY: ${analysis.signal}`}</b><small>{message}</small></div><div className="adaptiveActions">
   <label className="realArm"><input type="checkbox" checked={allowReal} onChange={e=>setAllowReal(e.target.checked)} disabled={!real}/>Arm REAL trading</label>
   <button className="secondary" onClick={reset}>RESET</button><button className={running?"danger":"primary"} onClick={()=>{if(running){setRunning(false);setMessage("Bot stopped. Protection remains active.")}else{setRunning(true);setMessage(real?(allowReal?"REAL scanner armed. A+ only.":"REAL selected but not armed."):"DEMO scanner armed. A+ only.")}}}>{running?"STOP BOT":"START BOT"}</button>
  </div></div>
  <div className="adaptiveFooter"><span>Price: {Number(currentPrice||0).toFixed(market?.decimals??3)}</span><span>Symbol: {symbol||"—"}</span><span>Open: {active?idOf(active):"0"}</span><span>Account: {auth?.selectedAccount?.id||selectedAccountId||"—"}</span></div>
 </section>;
}
