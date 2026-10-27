import {tapCandidate,addTap,stepTap,trendOf} from '../src/utils/volatilityTapEngine.js';
import {finished} from '../src/utils/setupHistory.js';
export const FRAMES={'1m':60,'2m':120,'3m':180,'5m':300,'10m':600,'15m':900,'30m':1800,'1h':3600,'2h':7200,'4h':14400,'8h':28800,'24h':86400};
const HIGHER={'1m':'5m','2m':'10m','3m':'15m','5m':'15m','10m':'30m','15m':'1h','30m':'2h','1h':'4h','2h':'8h','4h':'24h','8h':'24h'};
export function updateCandle(rows,tick,seconds){
 const time=Math.floor(tick.epoch/seconds)*seconds, last=rows.at(-1);
 if(last && time<last.time)return rows;
 const c=last?.time===time?{...last,high:Math.max(last.high,tick.quote),low:Math.min(last.low,tick.quote),close:tick.quote}:{time,open:tick.quote,high:tick.quote,low:tick.quote,close:tick.quote};
 return [...(last?.time===time?rows.slice(0,-1):rows),c].slice(-320);
}
export class Scanner {
 constructor(signals=[]){this.signals=signals;this.history={};this.last={};this.detector={};}
 seed(symbol,tf,candles){
  const valid=candles.map(c=>({...c,time:Number(c.time??c.epoch)})).filter(c=>[c.time,c.open,c.high,c.low,c.close].every(Number.isFinite));
  this.history[symbol]??={};this.history[symbol][tf]=[...new Map(valid.map(c=>[c.time,c])).values()].sort((a,b)=>a.time-b.time).slice(-320);
 }
 tick(symbol,tick,now=Date.now()){
  if(!Number.isFinite(tick.quote)||!Number.isFinite(tick.epoch)||now/1000-tick.epoch>30||tick.epoch>now/1000+5||tick.epoch<=(this.last[symbol]||0))return false;
  this.last[symbol]=tick.epoch;
  const history=this.history[symbol]??={};
  for(const [tf,seconds] of Object.entries(FRAMES))history[tf]=updateCandle(history[tf]||[],tick,seconds);
  let transition=false;
  this.signals=this.signals.map(row=>{
   if(row.market!==symbol||finished(row))return row;
   const candles=history[row.tf]||[], closed=candles.at(-2);
   const next=stepTap(row,tick,closed);
   transition ||= next.status!==row.status;
   const saved=new Map((row.candles||[]).map(c=>[c.time,c]));
   for(const c of candles)if(c.time>=row.time-60*FRAMES[row.tf])saved.set(c.time,c);
   return {...next,candles:[...saved.values()].sort((a,b)=>a.time-b.time)};
  });
  for(const [tf,higher] of Object.entries(HIGHER)){
   const candles=history[tf], seconds=FRAMES[tf],closed=candles.at(-2),key=`${symbol}:${tf}`;
   if(candles.length<61||closed?.time!==Math.floor(tick.epoch/seconds)*seconds-seconds||this.detector[key]===closed.time)continue;
   // Wait until higher history is loaded; never mark a candle checked prematurely.
   const h=(history[higher]||[]).filter(c=>c.time+FRAMES[higher]<=candles.at(-1).time);
   if(h.length<55)continue;
   this.detector[key]=closed.time;
   const candidate=tapCandidate(candles.slice(0,-1),{market:symbol,tf,seconds,higherTrend:trendOf(h),now});
   if(candidate){candidate.id='server:'+candidate.id;candidate.source='server';candidate.candles=candles.slice(-120);const next=addTap(this.signals,candidate);transition ||= next!==this.signals;this.signals=next;}
  }
  return transition;
 }
}
