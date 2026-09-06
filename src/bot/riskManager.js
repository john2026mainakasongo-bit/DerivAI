const DEFAULTS={stake:.35,maxSessionLoss:3,maxTrades:10,maxConsecutiveLosses:2,cooldownMs:8000,lossPauseMs:60000,maxOpenTrades:1};
export function createRiskManager(overrides={}){const c={...DEFAULTS,...overrides},s={sessionPnl:0,trades:0,wins:0,losses:0,consecutiveLosses:0,lastEntryAt:0,blockedUntil:0,openIds:new Set()};
 const canTrade=(now=Date.now())=>{if(s.trades>=c.maxTrades)return{ok:false,reason:'MAX TRADES REACHED'};if(s.sessionPnl<=-Math.abs(c.maxSessionLoss))return{ok:false,reason:'SESSION LOSS LIMIT'};if(s.consecutiveLosses>=c.maxConsecutiveLosses&&now<s.blockedUntil)return{ok:false,reason:'LOSS COOLDOWN'};if(now-s.lastEntryAt<c.cooldownMs)return{ok:false,reason:'ENTRY COOLDOWN'};if(s.openIds.size>=c.maxOpenTrades)return{ok:false,reason:'OPEN TRADE LIMIT'};if(s.consecutiveLosses>=c.maxConsecutiveLosses)s.consecutiveLosses=0;return{ok:true,reason:'RISK OK'}};
 const onEntry=id=>{s.trades++;s.lastEntryAt=Date.now();if(id)s.openIds.add(String(id));};
 const onResult=(id,p)=>{const v=Number(p)||0;if(id)s.openIds.delete(String(id));s.sessionPnl+=v;if(v>0){s.wins++;s.consecutiveLosses=0}else if(v<0){s.losses++;s.consecutiveLosses++;if(s.consecutiveLosses>=c.maxConsecutiveLosses)s.blockedUntil=Date.now()+c.lossPauseMs;}};
 const reset=()=>{s.sessionPnl=0;s.trades=0;s.wins=0;s.losses=0;s.consecutiveLosses=0;s.lastEntryAt=0;s.blockedUntil=0;s.openIds.clear()};
 const snapshot=()=>({...s,openIds:[...s.openIds],config:c});return{canTrade,onEntry,onResult,reset,snapshot};}
export default createRiskManager;
