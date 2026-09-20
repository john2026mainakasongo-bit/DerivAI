import {useEffect,useMemo,useRef,useState} from "react";
import useDerivTicks from "../hooks/useDerivTicks";
import {useDerivAuth} from "../auth/DerivAuthContext";
import analyzeAdaptiveTrend from "../analysis/adaptiveTrendEngine";
import "../styles/AdaptiveTrendBot.css";

const STORAGE_KEY="zentora_adaptive_trend_deriv_v6_performance";
const money=(v,c="USD")=>`$${Number(v||0).toFixed(2)} ${String(c).toUpperCase()}`;
const idOf=x=>String(x?.contract_id||x?.contractId||x?.id||x?.proposal_open_contract?.contract_id||"");
const settled=x=>Boolean(x?.is_sold||x?.is_expired||x?.is_settled||["won","lost","sold","expired","settled"].includes(String(x?.status||x?.contract_status||"").toLowerCase()));
const profit=x=>{const n=Number(x?.profit??x?.profit_loss??x?.pnl);return Number.isFinite(n)?n:0};
const durationValue=v=>Math.max(2,Math.min(20,Math.round(Number(v)||5)));
const contractFor=direction=>direction==="RISE"?"CALL":direction==="FALL"?"PUT":"";
const perfKey=(symbol,duration,direction,currency)=>`${symbol||"-"}|${durationValue(duration)}t|${direction||"WAIT"}|${String(currency||"USD").toUpperCase()}`;
const blankStats=()=>({samples:0,wins:0,losses:0,winRate:.5});
const readPerformance=()=>{try{const raw=localStorage.getItem(STORAGE_KEY);const parsed=raw?JSON.parse(raw):{};if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return {};const source=parsed.performance&&typeof parsed.performance==="object"?parsed.performance:parsed;const next={};for(const [key,value] of Object.entries(source)){const samples=Math.max(0,Number(value?.samples)||0);const wins=Math.min(samples,Math.max(0,Number(value?.wins)||0));next[key]={samples,wins,losses:samples-wins,winRate:samples?wins/samples:.5};}return next}catch{return {}}};
const aggregate=performance=>Object.values(performance).reduce((a,s)=>({samples:a.samples+s.samples,wins:a.wins+s.wins,losses:a.losses+s.losses}),{samples:0,wins:0,losses:0});

export default function AdaptiveTrendBot(){
 const auth=useDerivAuth();
 const {symbol,market,prices,currentPrice,openContracts,selectedAccount,selectedAccountType="demo",selectedAccountId,connected,status,statusDetail,quoteTrade,placeQuotedTrade,tradeBusy,tradeError}=useDerivTicks();
 const [running,setRunning]=useState(false),[stake,setStake]=useState(.35),[duration,setDuration]=useState(5),[allowReal,setAllowReal]=useState(false);
 const [tp,setTp]=useState(2),[sl,setSl]=useState(1.5),[maxLosses,setMaxLosses]=useState(2),[cooldown,setCooldown]=useState(10),[minEdge,setMinEdge]=useState(.05);
 const [pnl,setPnl]=useState(0),[losses,setLosses]=useState(0),[message,setMessage]=useState("Deriv scanner ready - DEMO first."),[executionState,setExecutionState]=useState(""),[tradeHistory,setTradeHistory]=useState([]);
 const [shadowEnabled,setShadowEnabled]=useState(true),[performance,setPerformance]=useState(readPerformance);
 const busy=useRef(false),lastEntry=useRef(0),done=useRef(new Set()),analysisRef=useRef(null),pendingRef=useRef([]);
 const analysis=useMemo(()=>analyzeAdaptiveTrend(prices,{duration}),[prices,duration]);
 const currency=String(selectedAccount?.currency||"USD").toUpperCase();
 const active=openContracts?.find(x=>!settled(x)),real=String(selectedAccountType).toLowerCase()==="real";
 const tradingAccountId=selectedAccountId||auth?.selectedAccount?.id||"";
 const balance=Number(selectedAccount?.balance);
 const horizon=durationValue(analysis.horizon||duration);
 const direction=analysis.rawDirection;
 const contractType=contractFor(direction);
 const currentKey=perfKey(symbol,horizon,direction,currency);
 const keyStats=performance[currentKey]||blankStats();
 const total=aggregate(performance);
 const aggregateWinRate=total.samples?total.wins/total.samples:.5;
 const minKeySamples=50;
 const realKeySamples=100;
 const keyEvidenceReady=keyStats.samples>=minKeySamples&&keyStats.winRate>=.56;
 const strictRealEvidence=keyStats.samples>=realKeySamples&&keyStats.winRate>=.56;
 const maxStakeByBalance=Number.isFinite(balance)&&balance>0?balance*.01:Infinity;
 const riskCappedStake=Math.min(Math.max(.35,Number(stake)||.35),maxStakeByBalance);

 useEffect(()=>{try{localStorage.setItem(STORAGE_KEY,JSON.stringify({version:6,source:"deriv",updatedAt:Date.now(),performance}))}catch{}},[performance]);
 useEffect(()=>{analysisRef.current=analysis},[analysis]);

 // Deriv-native shadow book: one hypothetical CALL/PUT outcome per exact
 // symbol + duration + direction + currency key, with no duplicate candidate
 // while an earlier candidate for the same key is still inside its horizon.
 useEffect(()=>{
   if(!shadowEnabled||!connected||!symbol||!Number.isFinite(Number(currentPrice))||prices.length<horizon+2||!contractType)return;
   const tickIndex=prices.length-1;
   const sameKey=pendingRef.current.filter(x=>x.key===currentKey);
   if(sameKey.some(x=>tickIndex-x.index<horizon))return;
   pendingRef.current.push({index:tickIndex,entry:Number(currentPrice),direction,horizon,key:currentKey,contractType,model:Number(analysis.probability||.5)});
   pendingRef.current=pendingRef.current.slice(-300);
 },[analysis,currentPrice,prices.length,shadowEnabled,connected,symbol,currentKey,horizon,direction,contractType]);

 useEffect(()=>{
   if(!prices.length||!pendingRef.current.length)return;
   const now=prices.length-1,keep=[],outcomes=[];
   for(const s of pendingRef.current){
     if(now<s.index+s.horizon){keep.push(s);continue;}
     const exit=Number(prices[s.index+s.horizon]?.quote??prices[s.index+s.horizon]);
     if(!Number.isFinite(exit)){keep.push(s);continue;}
     // Match the vanilla Deriv CALL/PUT directional payoff. Ties are ignored
     // rather than fabricated into a win or loss.
     const delta=exit-s.entry;
     if(delta===0)continue;
     const win=s.contractType==="CALL"?delta>0:delta<0;
     outcomes.push({key:s.key,win});
   }
   pendingRef.current=keep;
   if(!outcomes.length)return;
   setPerformance(prev=>{
     const next={...prev};
     for(const o of outcomes){
       const old=next[o.key]||blankStats();
       const samples=old.samples+1;
       const wins=old.wins+(o.win?1:0);
       next[o.key]={samples,wins,losses:samples-wins,winRate:wins/samples};
     }
     return next;
   });
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
   if(!keyEvidenceReady){setMessage(`DERIV KEY EVIDENCE · ${keyStats.samples}/${minKeySamples} · ${(keyStats.winRate*100).toFixed(1)}% · ${symbol} ${horizon}t ${direction}`);return;}
   if(real&&!strictRealEvidence){setMessage(`REAL LOCK · ${keyStats.samples}/${realKeySamples} ${symbol} ${horizon}t ${direction} · ${(keyStats.winRate*100).toFixed(1)}%`);return;}
   if(a.samples<12){setMessage(`HISTORICAL FILTER · ${a.samples} comparable states`);return;}
   if(Date.now()-lastEntry.current<Number(cooldown)*1000)return;
   busy.current=true;
   const amount=Math.max(.35,Number(riskCappedStake)||.35);
   const tradeArgs={contractType,amount,basis:"stake",duration:horizon,durationUnit:"t",symbol};
   setMessage(`DERIV PROPOSAL · ${contractType} ${symbol} · ${horizon}t · model ${(a.probability*100).toFixed(1)}%`);
   try{
     let result=null,quote=null,lastError=null;
     for(let attempt=1;attempt<=2;attempt++){
       try{
         quote=await quoteTrade(tradeArgs);
         if(!quote?.proposalId)throw new Error("Deriv returned no proposal ID.");
         const ask=Number(quote.askPrice),payout=Number(quote.payout),model=Number(a.probability||.5);
         if(!Number.isFinite(ask)||!Number.isFinite(payout)||ask<=0||payout<=ask)throw new Error("Invalid Deriv proposal pricing.");
         const implied=ask/payout,edge=model-implied,ev=model*payout-ask;
         if(model<.56||edge<Number(minEdge)||ev<=0){setMessage(`DERIV VALUE FILTER · model ${(model*100).toFixed(1)}% · BE ${(implied*100).toFixed(1)}% · edge ${(edge*100).toFixed(1)}% · EV ${ev.toFixed(3)}`);busy.current=false;return;}
         if(real&&(!Number.isFinite(balance)||balance<35)){setMessage("DERIV RISK LOCK · REAL requires at least $35 for $0.35 to stay within 1%.");busy.current=false;return;}
         if(real&&amount>balance*.01){setMessage(`DERIV RISK FILTER · ${money(amount,currency)} exceeds 1% balance.`);busy.current=false;return;}
         setMessage(`${real?"REAL":"DEMO"} DERIV VALUE CONFIRMED · ${contractType} · edge ${(edge*100).toFixed(1)}% · EV ${ev.toFixed(3)} · buying...`);
         result=await placeQuotedTrade({quote});if(result!==false)break;
       }catch(e){lastError=e;if(attempt<2){setMessage(`Deriv proposal retry ${attempt+1}/2...`);await new Promise(r=>setTimeout(r,400));}}
     }
     if(lastError&&!result)throw lastError;
     lastEntry.current=Date.now();
     const returnedId=idOf(result);
     if(returnedId){const entryPrice=Number(quote?.spot||currentPrice||0);const journalEntry={id:returnedId,side:a.signal,contractType,symbol,duration:horizon,score:Number(a.score||0),confidence:Number(a.confidence||0),probability:Number(a.probability||0),samples:Number(a.samples||0),rsi:Number(a.rsi||50),entryPrice,result:"OPEN",pnl:null,time:new Date().toLocaleTimeString()};setTradeHistory(prev=>[journalEntry,...prev.filter(t=>t.id!==returnedId)].slice(0,8));}
     setMessage(returnedId?`DERIV ${contractType} OPENED · Contract ${returnedId}`:`DERIV ${contractType} EXECUTION ACCEPTED`);
   }catch(e){const detail=e instanceof Error?e.message:String(e||tradeError||"Deriv execution rejected.");setMessage(`DERIV EXECUTION FAILED · ${detail}`)}finally{busy.current=false}
 },1200);return()=>clearInterval(t)
 },[active,allowReal,balance,connected,contractType,cooldown,currency,direction,duration,horizon,keyEvidenceReady,keyStats.samples,keyStats.winRate,losses,maxLosses,minEdge,pnl,quoteTrade,placeQuotedTrade,real,riskCappedStake,running,sl,symbol,tp,tradeBusy,tradeError,tradingAccountId,strictRealEvidence]);

 const reset=()=>{setRunning(false);setPnl(0);setLosses(0);setExecutionState("");setTradeHistory([]);done.current.clear();lastEntry.current=0;pendingRef.current=[];setMessage("Session reset - Deriv scanner ready.")};
 const clearEvidence=()=>{try{localStorage.removeItem(STORAGE_KEY)}catch{};setPerformance({});pendingRef.current=[];setMessage("Deriv evidence reset. Building fresh key statistics.")};
 return <section className="adaptiveBot">
  <div className="adaptiveHeader"><div><span className="adaptiveEyebrow">ZENTORA - ADAPTIVE TREND V6</span><h2>Deriv → Regime → Evidence → Proposal → Execution</h2><p>Deriv-native CALL/PUT proposal pricing, exact-key evidence and strict REAL unlock.</p></div><div className={`adaptiveRunState ${running?"on":""}`}>{running?"SCANNING":"STOPPED"}</div></div>
  <div className="adaptiveGrid">
   <div className="adaptivePanel"><div className="adaptivePanelTitle">LIVE DERIV STRATEGY</div><div className="adaptiveMetrics">
    <div><span>Symbol</span><b>{symbol||"-"}</b></div><div><span>Contract</span><b>{contractType||"WAIT"}</b></div><div><span>Duration</span><b>{horizon}t</b></div><div><span>RSI</span><b>{Number(analysis.rsi||50).toFixed(1)}</b></div>
    <div><span>Grade</span><b className={analysis.grade==="A+"?"good":""}>{analysis.grade}</b></div><div><span>Score</span><b>{analysis.score}/100</b></div><div><span>Model</span><b>{(Number(analysis.probability||.5)*100).toFixed(1)}%</b></div><div><span>Matches</span><b>{analysis.samples||0}</b></div>
   </div><div className="adaptiveReason">{analysis.reason}</div><div className="adaptiveStatus"><span className={connected?"liveDot":"deadDot"}/><b>{status}</b><small>{statusDetail||"Waiting for Deriv feed"}</small></div></div>
   <div className="adaptivePanel"><div className="adaptivePanelTitle">DERIV RISK + EVIDENCE</div><div className="adaptiveControls">
    <label>Stake<input type="number" min=".35" step=".01" value={stake} onChange={e=>setStake(e.target.value)}/></label>
    <label>Duration<input type="number" min="2" max="20" value={duration} onChange={e=>setDuration(e.target.value)}/></label>
    <label>Take profit<input type="number" min=".5" step=".5" value={tp} onChange={e=>setTp(e.target.value)}/></label>
    <label>Stop loss<input type="number" min=".5" step=".5" value={sl} onChange={e=>setSl(e.target.value)}/></label>
    <label>Max losses<input type="number" min="1" max="5" value={maxLosses} onChange={e=>setMaxLosses(e.target.value)}/></label>
    <label>Cooldown<input type="number" min="3" value={cooldown} onChange={e=>setCooldown(e.target.value)}/></label>
   </div><div className="adaptivePnl"><span>Exact key</span><strong>{keyStats.samples} · {(keyStats.winRate*100).toFixed(1)}%</strong></div><div className="adaptivePnl"><span>Key gate</span><strong>{keyStats.samples>=minKeySamples&&keyStats.winRate>=.56?"READY":"BUILDING"}</strong></div><div className="adaptivePnl"><span>Aggregate</span><strong>{total.samples} · {(aggregateWinRate*100).toFixed(1)}%</strong></div><div className="adaptivePnl"><span>REAL gate</span><strong>{strictRealEvidence?"UNLOCKED":"LOCKED · 100 exact-key samples"}</strong></div><div className="adaptivePnl"><span>Session P/L</span><strong className={pnl>=0?"profit":"loss"}>{pnl>=0?"+":""}{money(pnl,currency)}</strong></div><div className="adaptivePnl"><span>Loss count</span><strong>{losses}/{maxLosses}</strong></div></div>
  </div>
  <div className="adaptiveActionBar"><div><b>{active?`DERIV TRADE OPEN: ${idOf(active)}`:executionState==="OPENED"?"DERIV TRADE OPENED":executionState==="WON"?"LAST DERIV TRADE: WON":executionState==="LOST"?"LAST DERIV TRADE: LOST":analysis.signal==="WAIT"?"WAITING FOR DERIV EVIDENCE":`READY: ${analysis.signal}`}</b><small>{message}</small></div><div className="adaptiveActions">
   <label className="realArm"><input type="checkbox" checked={allowReal} onChange={e=>setAllowReal(e.target.checked)} disabled={!real}/>Arm REAL trading</label>
   <label className="realArm">Shadow test <input type="checkbox" checked={shadowEnabled} onChange={e=>setShadowEnabled(e.target.checked)}/></label>
   <label className="realArm">Min edge <input type="number" min=".02" max=".15" step=".01" value={minEdge} onChange={e=>setMinEdge(e.target.value)}/></label>
   <button className="secondary" onClick={reset}>RESET</button><button className="secondary" onClick={clearEvidence}>RESET EVIDENCE</button><button className={running?"danger":"primary"} onClick={()=>{if(running){setRunning(false);setMessage("Deriv bot stopped. Protection remains active.")}else{setRunning(true);setMessage(real?(allowReal?"REAL Deriv scanner armed · evidence + EV gates active.":"REAL selected but not armed."):"DEMO Deriv scanner armed · evidence + EV gates active.")}}}>{running?"STOP BOT":"START BOT"}</button>
  </div></div>
  <div className="adaptiveJournal"><div className="adaptiveJournalHead"><div><b>DERIV TRADE JOURNAL</b><small>Latest {tradeHistory.length} Adaptive Trend executions</small></div><strong>{tradeHistory.length}/8</strong></div><div className="adaptiveJournalList">{tradeHistory.length===0?<div className="adaptiveJournalEmpty">No Deriv executions yet.</div>:tradeHistory.map(t=><div className="adaptiveJournalRow" key={t.id}><span className={t.result==="WON"?"journalWon":t.result==="LOST"?"journalLost":"journalOpen"}>{t.result}</span><span>{t.contractType}</span><span>{t.symbol}</span><span>{t.duration}t</span><span>C {t.id}</span><span>Model {(Number(t.probability||0)*100).toFixed(1)}%</span><span>{t.pnl===null?"-":`${t.pnl>=0?"+":""}${money(t.pnl,currency)}`}</span></div>)}</div></div>
  <div className="adaptiveFooter"><span>Price: {Number(currentPrice||0).toFixed(market?.decimals??3)}</span><span>Deriv Symbol: {symbol||"-"}</span><span>Open: {active?idOf(active):"0"}</span><span>Account: {auth?.selectedAccount?.id||selectedAccountId||"-"}</span><span>Balance: {Number.isFinite(balance)?money(balance,currency):"-"}</span><span>Key: {currentKey}</span></div>
 </section>;
}
