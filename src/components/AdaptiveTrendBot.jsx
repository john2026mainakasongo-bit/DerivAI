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
 const {symbol,market,prices,currentPrice,openContracts,selectedAccount,selectedAccountType="demo",selectedAccountId,connected,status,statusDetail,quoteTrade,placeQuotedTrade,tradeBusy,tradeError}=useDerivTicks();
 const [running,setRunning]=useState(false),[stake,setStake]=useState(.35),[duration,setDuration]=useState(5),[allowReal,setAllowReal]=useState(false);
 const [tp,setTp]=useState(2),[sl,setSl]=useState(1.5),[maxLosses,setMaxLosses]=useState(2),[cooldown,setCooldown]=useState(10),[minEdge,setMinEdge]=useState(0.05);
 const [pnl,setPnl]=useState(0),[losses,setLosses]=useState(0),[message,setMessage]=useState("Scanner ready - demo first."),[executionState,setExecutionState]=useState(""),[tradeHistory,setTradeHistory]=useState([]);
 const busy=useRef(false),lastEntry=useRef(0),done=useRef(new Set()),analysisRef=useRef(null);
 const analysis=useMemo(()=>analyzeAdaptiveTrend(prices,{duration}),[prices,duration]),currency=String(selectedAccount?.currency||"USD").toUpperCase();

useEffect(()=>{
  analysisRef.current=analysis;
},[analysis]);
 const active=openContracts?.find(x=>!settled(x)),real=String(selectedAccountType).toLowerCase()==="real";
 const tradingAccountId=selectedAccountId||auth?.selectedAccount?.id||"";

 useEffect(()=>{for(const c of openContracts||[]){const id=idOf(c);if(!id||!settled(c)||done.current.has(id))continue;done.current.add(id);const p=profit(c);setPnl(x=>x+p);if(p<0)setLosses(x=>x+1);setExecutionState(p>=0?"WON":"LOST");setMessage(`${p>=0?"WON":"LOST"} ${id} - ${p>=0?"+":""}${money(p,currency)}`);setTradeHistory(prev=>prev.map(t=>t.id===id?{...t,result:p>=0?"WON":"LOST",pnl:p}:t))}},[openContracts,currency]);

 useEffect(()=>{if(!running)return;const t=setInterval(async()=>{if(busy.current||tradeBusy||active||!tradingAccountId||!symbol)return;
   if(!connected)return;

   const latestAnalysis=analysisRef.current;
   if(!latestAnalysis)return;
   if(pnl>=Number(tp)){setRunning(false);setMessage(`TAKE PROFIT reached - ${money(pnl,currency)}`);return}
   if(pnl<=-Number(sl)){setRunning(false);setMessage(`STOP LOSS reached - ${money(pnl,currency)}`);return}
   if(losses>=Number(maxLosses)){setRunning(false);setMessage(`MAX LOSSES reached - ${losses}`);return}
   if(real&&!allowReal)return;

   const aPlusReady=Boolean(
     latestAnalysis.grade==="A+" &&
     latestAnalysis.signal!=="WAIT"
   );

   if(!aPlusReady)return;
   if(Date.now()-lastEntry.current<Number(cooldown)*1000)return;

   busy.current=true;

   const contractType=latestAnalysis.signal==="RISE"?"CALL":"PUT";
   const amount=Math.max(.35,Number(stake)||.35);
   const tradeArgs={
     contractType,
     amount,
     basis:"stake",
     duration:Math.max(2,Number(duration)||5),
     durationUnit:"t",
     symbol
   };

   setMessage(`A+ CONFIRMED - ${latestAnalysis.signal} - pricing proposal before any buy...`);

   try{
     let result=null;
     let quote=null;
     let lastError=null;

     for(let attempt=1;attempt<=2;attempt++){
       try{
         quote=await quoteTrade(tradeArgs);
         if(!quote?.proposalId) throw new Error("Deriv returned no valid proposal ID.");

         const ask=Number(quote.askPrice);
         const payout=Number(quote.payout);
         const implied=ask/payout;
         const model=Number(latestAnalysis.probability||0.5);
         const edge=model-implied;
         const expectedValue=(model*payout)-ask;

         if(!Number.isFinite(ask)||!Number.isFinite(payout)||payout<=ask){
           throw new Error("Invalid Deriv proposal pricing.");
         }

         // PROFITABILITY GATE:
         // Never buy merely because the chart says A+. The quoted contract
         // price determines the break-even probability. We only trade when
         // the model has a real edge over that break-even level.
         if(model < 0.56 || edge < Number(minEdge) || expectedValue <= 0){
           setMessage(
             `A+ ${latestAnalysis.signal} FILTERED · model ${(model*100).toFixed(1)}% · break-even ${(implied*100).toFixed(1)}% · edge ${(edge*100).toFixed(1)}% · EV ${expectedValue.toFixed(3)}`
           );
           busy.current=false;
           return;
         }

         setMessage(
           `A+ ${latestAnalysis.signal} VALUE CONFIRMED · model ${(model*100).toFixed(1)}% · break-even ${(implied*100).toFixed(1)}% · edge ${(edge*100).toFixed(1)}% · buying...`
         );

         result=await placeQuotedTrade({quote});
         if(result!==false)break;
       }catch(e){
         lastError=e;
         if(attempt<2){
           setMessage(`Proposal retry ${attempt+1}/2...`);
           await new Promise(r=>setTimeout(r,400));
         }
       }
     }

     if(lastError && !result)throw lastError;

     // Cooldown starts only after an accepted purchase, not after a rejected
     // proposal or a value filter.
     lastEntry.current=Date.now();

     const returnedId=idOf(result);
     if(returnedId){
       const entryPrice=Number(quote?.spot||currentPrice||0);
       const journalEntry={
         id:returnedId,
         side:latestAnalysis.signal,
         score:Number(latestAnalysis.score||0),
         confidence:Number(latestAnalysis.confidence||0),
         rsi:Number(latestAnalysis.rsi||50),
         entryPrice,
         result:"OPEN",
         pnl:null,
         time:new Date().toLocaleTimeString(),
       };
       setTradeHistory(prev=>[journalEntry,...prev.filter(t=>t.id!==returnedId)].slice(0,8));
     }
     setMessage(
       returnedId
         ? (setExecutionState("OPENED"),`A+ ${latestAnalysis.signal} OPENED - Contract ${returnedId} - monitoring...`)
         : `A+ ${latestAnalysis.signal} EXECUTION ACCEPTED - monitoring contract...`
     );
   }catch(e){
     const detail=e instanceof Error?e.message:String(e||tradeError||"Entry rejected.");
     setMessage(`A+ EXECUTION FAILED - ${detail}`);
   }finally{
     busy.current=false;
   }
 },1200);
 return()=>clearInterval(t)
 },[active,allowReal,cooldown,currency,duration,losses,maxLosses,pnl,quoteTrade,placeQuotedTrade,real,running,tradingAccountId,sl,stake,symbol,tp,connected,tradeBusy,tradeError,minEdge]);

 const reset=()=>{setRunning(false);setPnl(0);setLosses(0);setExecutionState("");setTradeHistory([]);done.current.clear();lastEntry.current=0;setMessage("Session reset - scanner ready.")};
 return <section className="adaptiveBot">
  <div className="adaptiveHeader"><div><span className="adaptiveEyebrow">ZENTORA - ADAPTIVE TREND V2</span><h2>Trend ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Pullback ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Proposal</h2><p>A+ setups only. Confirmed A+ signals execute through the live proposal pipeline.</p></div><div className={`adaptiveRunState ${running?"on":""}`}>{running?"SCANNING":"STOPPED"}</div></div>
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
  <div className="adaptiveActionBar"><div><b>{active?`TRADE OPEN: ${idOf(active)}`:executionState==="OPENED"?"TRADE OPENED":executionState==="WON"?"LAST TRADE: WON":executionState==="LOST"?"LAST TRADE: LOST":analysis.signal==="WAIT"?"WAITING FOR A+":`READY: ${analysis.signal}`}</b><small>{message}</small></div><div className="adaptiveActions">
   <label className="realArm"><input type="checkbox" checked={allowReal} onChange={e=>setAllowReal(e.target.checked)} disabled={!real}/>Arm REAL trading</label>
   <label className="realArm">Min edge <input type="number" min=".02" max=".15" step=".01" value={minEdge} onChange={e=>setMinEdge(e.target.value)}/></label>
   <button className="secondary" onClick={reset}>RESET</button><button className={running?"danger":"primary"} onClick={()=>{if(running){setRunning(false);setMessage("Bot stopped. Protection remains active.")}else{setRunning(true);setMessage(real?(allowReal?"REAL scanner armed. A+ execution enabled.":"REAL selected but not armed."):"DEMO scanner armed. A+ execution enabled.")}}}>{running?"STOP BOT":"START BOT"}</button>
  </div></div>
  <div className="adaptiveJournal">
   <div className="adaptiveJournalHead"><div><b>TRADE JOURNAL</b><small>Latest {tradeHistory.length} Adaptive Trend executions</small></div><strong>{tradeHistory.length}/8</strong></div>
   <div className="adaptiveJournalList">{tradeHistory.length===0?<div className="adaptiveJournalEmpty">No executions yet.</div>:tradeHistory.map(t=><div className="adaptiveJournalRow" key={t.id}>
    <span className={t.result==="WON"?"journalWon":t.result==="LOST"?"journalLost":"journalOpen"}>{t.result}</span><span>{t.side}</span><span>C {t.id}</span><span>Score {Number(t.score).toFixed(0)}</span><span>Conf {Number(t.confidence).toFixed(1)}%</span><span>RSI {Number(t.rsi).toFixed(1)}</span><span>Entry {Number(t.entryPrice||0).toFixed(market?.decimals??3)}</span><span>{t.pnl===null?"-":`${t.pnl>=0?"+":""}${money(t.pnl,currency)}`}</span>
   </div>)}</div>
  </div>
  <div className="adaptiveFooter"><span>Price: {Number(currentPrice||0).toFixed(market?.decimals??3)}</span><span>Symbol: {symbol||"-"}</span><span>Open: {active?idOf(active):"0"}</span><span>Account: {auth?.selectedAccount?.id||selectedAccountId||"-"}</span></div>
 </section>;
}
