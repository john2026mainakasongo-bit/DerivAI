import {useEffect,useMemo,useRef,useState} from "react";
import useDerivTicks from "../hooks/useDerivTicks";
import {useDerivAuth} from "../auth/DerivAuthContext";
import analyzeAdaptiveTrend from "../analysis/adaptiveTrendEngine";
import "../styles/AdaptiveTrendBot.css";

const money=(v,c="USD")=>`$${Number(v||0).toFixed(2)} ${String(c).toUpperCase()}`;
const idOf=x=>String(x?.contract_id||x?.contractId||x?.id||x?.proposal_open_contract?.contract_id||"");
const settled=x=>Boolean(x?.is_sold||x?.is_expired||x?.is_settled||["won","lost","sold","expired","settled"].includes(String(x?.status||x?.contract_status||"").toLowerCase()));
const profit=x=>{const n=Number(x?.profit??x?.profit_loss??x?.pnl);return Number.isFinite(n)?n:0};
const perfKey=(symbol,duration,direction)=>`${symbol||"-"}|${Math.max(2,Number(duration)||5)}t|${direction||"WAIT"}`;
const readPerformance=()=>{try{const raw=localStorage.getItem("zentora_adaptive_trend_v4_performance");const parsed=raw?JSON.parse(raw):{};return parsed&&typeof parsed==="object"?parsed:{}}catch{return {}}};

export default function AdaptiveTrendBot(){
 const auth=useDerivAuth();
 const {symbol,market,prices,currentPrice,openContracts,selectedAccount,selectedAccountType="demo",selectedAccountId,connected,status,statusDetail,quoteTrade,placeQuotedTrade,tradeBusy,tradeError}=useDerivTicks();
 const [running,setRunning]=useState(false),[stake,setStake]=useState(.35),[duration,setDuration]=useState(5),[allowReal,setAllowReal]=useState(false);
 const [tp,setTp]=useState(2),[sl,setSl]=useState(1.5),[maxLosses,setMaxLosses]=useState(2),[cooldown,setCooldown]=useState(10),[minEdge,setMinEdge]=useState(.05);
 const [pnl,setPnl]=useState(0),[losses,setLosses]=useState(0),[message,setMessage]=useState("Scanner ready - DEMO first."),[executionState,setExecutionState]=useState(""),[tradeHistory,setTradeHistory]=useState([]);
 const [shadow,setShadow]=useState({samples:0,wins:0,losses:0,winRate:.5}),[shadowEnabled,setShadowEnabled]=useState(true);
 const [performance,setPerformance]=useState(readPerformance);
 const busy=useRef(false),lastEntry=useRef(0),done=useRef(new Set()),analysisRef=useRef(null),shadowRef=useRef([]),lastShadowTick=useRef(-1),shadowCandidateRef=useRef("");
 const analysis=useMemo(()=>analyzeAdaptiveTrend(prices,{duration}),[prices,duration]),currency=String(selectedAccount?.currency||"USD").toUpperCase();
 const active=openContracts?.find(x=>!settled(x)),real=String(selectedAccountType).toLowerCase()==="real";
 const tradingAccountId=selectedAccountId||auth?.selectedAccount?.id||"";
 const balance=Number(selectedAccount?.balance);
 const maxStakeByBalance=Number.isFinite(balance)&&balance>0?Math.max(.35,balance*.01):Infinity;
 const riskCappedStake=Math.min(Math.max(.35,Number(stake)||.35),maxStakeByBalance);
 const currentKey=perfKey(symbol,duration,analysis.rawDirection);
 const keyStats=performance[currentKey]||{samples:0,wins:0,losses:0,winRate:.5};
 const evidenceReady=shadow.samples<30||shadow.winRate>=0.56;
 const keyEvidenceReady=keyStats.samples<50||keyStats.winRate>=0.56;
 const strictRealEvidence=keyStats.samples>=100&&keyStats.winRate>=0.56;

 useEffect(()=>{try{localStorage.setItem("zentora_adaptive_trend_v4_performance",JSON.stringify(performance))}catch{}},[performance]);

 useEffect(()=>{analysisRef.current=analysis},[analysis]);

 // Shadow-book exactly one candidate for a key until its horizon completes.
 // This prevents duplicate/unkeyed samples from inflating aggregate evidence and keeps per-key telemetry valid.
 useEffect(()=>{
   if(!shadowEnabled||prices.length<analysis.horizon+2||analysis.rawDirection==="WAIT") return;
   const tickIndex=prices.length-1;
   const horizon=Math.max(2,Number(analysis.horizon)||5);
   const key=perfKey(symbol,horizon,analysis.rawDirection);
   if(shadowCandidateRef.current===`${key}|${tickIndex}`) return;
   const last=shadowRef.current.at(-1);
   if(last&&last.key===key&&tickIndex-last.index<horizon) return;
   shadowCandidateRef.current=`${key}|${tickIndex}`;
   shadowRef.current.push({index:tickIndex,entry:Number(currentPrice),direction:analysis.rawDirection,horizon,model:Number(analysis.probability||.5),key});
   shadowRef.current=shadowRef.current.slice(-200);
 },[analysis,currentPrice,prices.length,shadowEnabled,symbol]);


 useEffect(()=>{
   if(!prices.length||!shadowRef.current.length)return;
   const now=prices.length-1;
   const keep=[];
   const outcomes=[];
   for(const s of shadowRef.current){
     if(now>=s.index+s.horizon){
       const exit=Number(prices[s.index+s.horizon]?.quote??prices[s.index+s.horizon]);
       if(!Number.isFinite(exit)) { keep.push(s); continue; }
       const win=s.direction==="RISE"?exit>s.entry:exit<s.entry;
       outcomes.push({key:s.key,win});
     }else keep.push(s);
   }
   if(!outcomes.length)return;
   shadowRef.current=keep;
   setShadow(prev=>{const wins=outcomes.filter(x=>x.win).length;const total=Math.min(200,prev.samples+outcomes.length);const totalWins=Math.min(total,prev.wins+wins);return {samples:total,wins:totalWins,losses:total-totalWins,winRate:total?totalWins/total:.5}});
   setPerformance(prev=>{const next={...prev};for(const o of outcomes){const old=next[o.key]||{samples:0,wins:0,losses:0,winRate:.5};const samples=old.samples+1;const wins=old.wins+(o.win?1:0);next[o.key]={samples,wins,losses:samples-wins,winRate:wins/samples};}return next;});
 },[prices]);

 useEffect(()=>{for(const c of openContracts||[]){const id=idOf(c);if(!id||!settled(c)||done.current.has(id))continue;done.current.add(id);const p=profit(c);setPnl(x=>x+p);if(p<0)setLosses(x=>x+1);setExecutionState(p>=0?"WON":"LOST");setMessage(`${p>=0?"WON":"LOST"} ${id} - ${p>=0?"+":""}${money(p,currency)}`);setTradeHistory(prev=>prev.map(t=>t.id===id?{...t,result:p>=0?"WON":"LOST",pnl:p}:t))}},[openContracts,currency]);

 useEffect(()=>{if(!running)return;const t=setInterval(async()=>{
   if(busy.current||tradeBusy||active||!tradingAccountId||!symbol||!connected)return;
   const a=analysisRef.current;if(!a)return;
   if(pnl>=Number(tp)){setRunning(false);setMessage(`TAKE PROFIT reached - ${money(pnl,currency)}`);return}
   if(pnl<=-Number(sl)){setRunning(false);setMessage(`STOP LOSS reached - ${money(pnl,currency)}`);return}
   if(losses>=Number(maxLosses)){setRunning(false);setMessage(`MAX LOSSES reached - ${losses}`);return}
   if(real&&!allowReal)return;
   if(a.grade!=="A+"||a.signal==="WAIT")return;
   if(real&&!strictRealEvidence){setMessage(`REAL EVIDENCE LOCK · ${keyStats.samples}/100 ${symbol} · ${duration}t · ${a.rawDirection} · ${(keyStats.winRate*100).toFixed(1)}% key win rate`);return;}
   if(!keyEvidenceReady){setMessage(`KEY FILTER · ${keyStats.samples} samples · ${(keyStats.winRate*100).toFixed(1)}% win rate · ${symbol} ${duration}t ${a.rawDirection}`);return;}
   if(!evidenceReady){setMessage(`EVIDENCE FILTER · ${shadow.samples} shadow samples · ${(shadow.winRate*100).toFixed(1)}% win rate`);return}
   if(a.samples<12){setMessage(`HISTORICAL FILTER · only ${a.samples} comparable states`);return}
   if(Date.now()-lastEntry.current<Number(cooldown)*1000)return;

   busy.current=true;
   const contractType=a.signal==="RISE"?"CALL":"PUT";
   const amount=riskCappedStake;
   const tradeArgs={contractType,amount,basis:"stake",duration:Math.max(2,Number(duration)||5),durationUnit:"t",symbol};
   setMessage(`A+ ${a.signal} · model ${(a.probability*100).toFixed(1)}% · ${a.samples} matches · pricing...`);
   try{
     let result=null,quote=null,lastError=null;
     for(let attempt=1;attempt<=2;attempt++){
       try{
         quote=await quoteTrade(tradeArgs);
         if(!quote?.proposalId)throw new Error("Deriv returned no valid proposal ID.");
         const ask=Number(quote.askPrice), payout=Number(quote.payout);
         const implied=ask/payout, model=Number(a.probability||.5), edge=model-implied, ev=(model*payout)-ask;
         if(!Number.isFinite(ask)||!Number.isFinite(payout)||payout<=ask)throw new Error("Invalid Deriv proposal pricing.");
         if(model<.56||edge<Number(minEdge)||ev<=0){setMessage(`VALUE FILTER · model ${(model*100).toFixed(1)}% · BE ${(implied*100).toFixed(1)}% · edge ${(edge*100).toFixed(1)}% · EV ${ev.toFixed(3)}`);busy.current=false;return;}
         if(real&&Number.isFinite(balance)&&balance<35){setMessage(`RISK LOCK · REAL trading requires at least $35 balance for the $0.35 minimum stake to remain within 1%.`);busy.current=false;return;}
         if(real&&Number.isFinite(balance)&&amount>balance*.01){setMessage(`RISK FILTER · stake capped at 1% of balance (${money(amount,currency)})`);busy.current=false;return;}
         setMessage(`${real?"REAL":"DEMO"} VALUE CONFIRMED · edge ${(edge*100).toFixed(1)}% · EV ${ev.toFixed(3)} · buying...`);
         result=await placeQuotedTrade({quote});if(result!==false)break;
       }catch(e){lastError=e;if(attempt<2){setMessage(`Proposal retry ${attempt+1}/2...`);await new Promise(r=>setTimeout(r,400));}}
     }
     if(lastError&&!result)throw lastError;
     lastEntry.current=Date.now();
     const returnedId=idOf(result);
     if(returnedId){const entryPrice=Number(quote?.spot||currentPrice||0);const journalEntry={id:returnedId,side:a.signal,score:Number(a.score||0),confidence:Number(a.confidence||0),probability:Number(a.probability||0),samples:Number(a.samples||0),rsi:Number(a.rsi||50),entryPrice,result:"OPEN",pnl:null,time:new Date().toLocaleTimeString()};setTradeHistory(prev=>[journalEntry,...prev.filter(t=>t.id!==returnedId)].slice(0,8));}
     setMessage(returnedId?`A+ ${a.signal} OPENED · Contract ${returnedId}`:`A+ ${a.signal} EXECUTION ACCEPTED`);
   }catch(e){const detail=e instanceof Error?e.message:String(e||tradeError||"Entry rejected.");setMessage(`EXECUTION FAILED · ${detail}`)}finally{busy.current=false}
 },1200);return()=>clearInterval(t)
 },[active,allowReal,cooldown,currency,duration,evidenceReady,losses,maxLosses,pnl,quoteTrade,placeQuotedTrade,real,running,tradingAccountId,sl,riskCappedStake,symbol,tp,connected,tradeBusy,tradeError,minEdge,shadow.samples,shadow.winRate,balance,keyStats.samples,keyStats.winRate,keyEvidenceReady,strictRealEvidence,currentKey]);

 const reset=()=>{setRunning(false);setPnl(0);setLosses(0);setExecutionState("");setTradeHistory([]);done.current.clear();lastEntry.current=0;shadowRef.current=[];lastShadowTick.current=-1;setShadow({samples:0,wins:0,losses:0,winRate:.5});setMessage("Session reset - scanner ready.")};
 return <section className="adaptiveBot">
  <div className="adaptiveHeader"><div><span className="adaptiveEyebrow">ZENTORA - ADAPTIVE TREND V4</span><h2>Regime → Evidence → Proposal → Execution</h2><p>No blind A+ buys. V4 adds per-symbol + per-duration evidence and a strict REAL unlock.</p></div><div className={`adaptiveRunState ${running?"on":""}`}>{running?"SCANNING":"STOPPED"}</div></div>
  <div className="adaptiveGrid">
   <div className="adaptivePanel"><div className="adaptivePanelTitle">LIVE STRATEGY</div><div className="adaptiveMetrics">
    <div><span>Trend</span><b>{analysis.trend}</b></div><div><span>Momentum</span><b>{analysis.momentum}</b></div><div><span>Pullback</span><b>{analysis.pullback}</b></div><div><span>RSI</span><b>{Number(analysis.rsi||50).toFixed(1)}</b></div>
    <div><span>Grade</span><b className={analysis.grade==="A+"?"good":""}>{analysis.grade}</b></div><div><span>Score</span><b>{analysis.score}/100</b></div><div><span>Model</span><b>{(Number(analysis.probability||.5)*100).toFixed(1)}%</b></div><div><span>Matches</span><b>{analysis.samples||0}</b></div>
   </div><div className="adaptiveReason">{analysis.reason}</div><div className="adaptiveStatus"><span className={connected?"liveDot":"deadDot"}/><b>{status}</b><small>{statusDetail||"Waiting for Deriv feed"}</small></div></div>
   <div className="adaptivePanel"><div className="adaptivePanelTitle">RISK + EVIDENCE</div><div className="adaptiveControls">
    <label>Stake<input type="number" min=".35" step=".01" value={stake} onChange={e=>setStake(e.target.value)}/></label>
    <label>Duration<input type="number" min="2" max="20" value={duration} onChange={e=>setDuration(e.target.value)}/></label>
    <label>Take profit<input type="number" min=".5" step=".5" value={tp} onChange={e=>setTp(e.target.value)}/></label>
    <label>Stop loss<input type="number" min=".5" step=".5" value={sl} onChange={e=>setSl(e.target.value)}/></label>
    <label>Max losses<input type="number" min="1" max="5" value={maxLosses} onChange={e=>setMaxLosses(e.target.value)}/></label>
    <label>Cooldown<input type="number" min="3" value={cooldown} onChange={e=>setCooldown(e.target.value)}/></label>
   </div><div className="adaptivePnl"><span>Shadow win rate</span><strong>{shadow.samples<30?"BUILDING":`${(shadow.winRate*100).toFixed(1)}%`} ({shadow.samples})</strong></div><div className="adaptivePnl"><span>Key evidence</span><strong>{keyStats.samples<50?`BUILDING ${keyStats.samples}/50`:`${(keyStats.winRate*100).toFixed(1)}% (${keyStats.samples})`}</strong></div><div className="adaptivePnl"><span>REAL gate</span><strong>{strictRealEvidence?"UNLOCKED":"LOCKED · 100 key samples"}</strong></div><div className="adaptivePnl"><span>Session P/L</span><strong className={pnl>=0?"profit":"loss"}>{pnl>=0?"+":""}{money(pnl,currency)}</strong></div><div className="adaptivePnl"><span>Loss count</span><strong>{losses}/{maxLosses}</strong></div></div>
  </div>
  <div className="adaptiveActionBar"><div><b>{active?`TRADE OPEN: ${idOf(active)}`:executionState==="OPENED"?"TRADE OPENED":executionState==="WON"?"LAST TRADE: WON":executionState==="LOST"?"LAST TRADE: LOST":analysis.signal==="WAIT"?"WAITING FOR EVIDENCE":`READY: ${analysis.signal}`}</b><small>{message}</small></div><div className="adaptiveActions">
   <label className="realArm"><input type="checkbox" checked={allowReal} onChange={e=>setAllowReal(e.target.checked)} disabled={!real}/>Arm REAL trading</label>
   <label className="realArm">Shadow test <input type="checkbox" checked={shadowEnabled} onChange={e=>setShadowEnabled(e.target.checked)}/></label>
   <label className="realArm">Min edge <input type="number" min=".02" max=".15" step=".01" value={minEdge} onChange={e=>setMinEdge(e.target.value)}/></label>
   <button className="secondary" onClick={reset}>RESET</button><button className={running?"danger":"primary"} onClick={()=>{if(running){setRunning(false);setMessage("Bot stopped. Protection remains active.")}else{setRunning(true);setMessage(real?(allowReal?"REAL scanner armed · evidence + EV gates active.":"REAL selected but not armed."):"DEMO scanner armed · evidence + EV gates active.")}}}>{running?"STOP BOT":"START BOT"}</button>
  </div></div>
  <div className="adaptiveJournal"><div className="adaptiveJournalHead"><div><b>TRADE JOURNAL</b><small>Latest {tradeHistory.length} Adaptive Trend executions</small></div><strong>{tradeHistory.length}/8</strong></div><div className="adaptiveJournalList">{tradeHistory.length===0?<div className="adaptiveJournalEmpty">No executions yet.</div>:tradeHistory.map(t=><div className="adaptiveJournalRow" key={t.id}><span className={t.result==="WON"?"journalWon":t.result==="LOST"?"journalLost":"journalOpen"}>{t.result}</span><span>{t.side}</span><span>C {t.id}</span><span>Score {Number(t.score).toFixed(0)}</span><span>Model {(Number(t.probability||0)*100).toFixed(1)}%</span><span>Matches {t.samples}</span><span>Entry {Number(t.entryPrice||0).toFixed(market?.decimals??3)}</span><span>{t.pnl===null?"-":`${t.pnl>=0?"+":""}${money(t.pnl,currency)}`}</span></div>)}</div></div>
  <div className="adaptiveFooter"><span>Price: {Number(currentPrice||0).toFixed(market?.decimals??3)}</span><span>Symbol: {symbol||"-"}</span><span>Open: {active?idOf(active):"0"}</span><span>Account: {auth?.selectedAccount?.id||selectedAccountId||"-"}</span><span>Balance: {Number.isFinite(balance)?money(balance,currency):"-"}</span><span>Key: {currentKey}</span></div>
 </section>;
}
