// Prospective tap-zone research engine. No broker execution or profit claims.
export const TAP_VERSION='tap-v4';
export const SHARP_POLICY='sharp-v6';
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
const ema=(xs,n)=>xs.reduce((e,x)=>e+(x-e)*2/(n+1),xs[0]);
export function trendOf(cs){if(cs.length<55)return 'UNKNOWN';const xs=cs.map(c=>c.close),fast=ema(xs,20),slow=ema(xs,50),prior=ema(xs.slice(0,-3),20);return fast>slow&&fast>prior?'BUY':fast<slow&&fast<prior?'SELL':'RANGE';}
export function tapCandidate(cs,{market,tf,seconds,higherTrend='UNKNOWN',now=Date.now()}){
 if(cs.length<60 || !/^R_\d+$|^\d+HZ\d+V$/i.test(market))return null;
 const last=cs.at(-1),side=trendOf(cs),buy=side==='BUY',sign=buy?1:-1;
 if(!['BUY','SELL'].includes(side)||higherTrend!==side)return null;
 const ranges=cs.slice(-20).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-cs[cs.length-21+i].close),Math.abs(c.low-cs[cs.length-21+i].close)));
 const atr=mean(ranges);if(!(atr>0))return null;
 let level=null,anchor=null;
 for(let i=cs.length-1;i>=cs.length-6;i--){
  const c=cs[i],prior=cs.slice(i-16,i),edge=buy?Math.max(...prior.map(x=>x.high)):Math.min(...prior.map(x=>x.low));
  const body=sign*(c.close-c.open);
  if(sign*(c.close-edge)>.15*atr && body>.8*atr && body/Math.max(c.high-c.low,1e-9)>.55){level=edge;anchor=c;break;}
 }
 let setup='BREAKOUT RETEST';
 if(level===null){
  level=ema(cs.map(c=>c.close),20);anchor=last;setup='TREND PULLBACK';
  if(sign*(last.close-last.open)<.7*atr)return null;
 }
 const zoneLow=level-.2*atr,zoneHigh=level+.2*atr;
 const distance=sign*(last.close-level)/atr;
 if(distance<.45||distance>2.5)return null;
 // A retest already seen in history cannot be presented as a new future tap.
 if(setup==='BREAKOUT RETEST' && cs.filter(c=>c.time>anchor.time).some(c=>buy?c.low<=zoneHigh:c.high>=zoneLow))return null;
 const recent=cs.slice(-8),stop=buy?Math.min(zoneLow,Math.min(...recent.map(c=>c.low)))-.25*atr:Math.max(zoneHigh,Math.max(...recent.map(c=>c.high)))+.25*atr;
 const risk=sign*(level-stop);if(risk<.5*atr||risk>3*atr)return null;
 const features=[buy?1:-1,Math.min(distance,3)/3,Math.min(risk/atr,3)/3,Math.min(Math.abs(last.close-last.open)/atr,3)/3,setup==='BREAKOUT RETEST'?1:0];
 return {id:`${TAP_VERSION}:${market}:${tf}:${anchor.time}:${side}:${setup}`,engine:TAP_VERSION,policy:SHARP_POLICY,market,tf,seconds,side,setup,time:last.time,detectedAt:now,lastEpoch:now/1000,zoneLow,zoneHigh,atr,entry:level,stop,tp1:level+sign*risk,tp2:level+sign*risk*2,tp3:level+sign*risk*3,status:'Awaiting tap',entered:false,expiresAt:now/1000+seconds*12,features,higherTrend,events:[{type:'Zone created',epoch:now/1000,price:last.close}]};
}
const terminal=r=>['SL touched','TP2 touched','Invalidated','Expired'].includes(r.status);
export function addTap(rows,candidate){
 if(!candidate||rows.some(r=>r.id===candidate.id))return rows;
 if(rows.some(r=>r.engine===TAP_VERSION && r.policy===SHARP_POLICY && r.market===candidate.market && r.tf===candidate.tf && !terminal(r)))return rows;
 if(rows.some(r=>r.engine===TAP_VERSION&&r.policy===SHARP_POLICY&&r.market===candidate.market&&r.tf===candidate.tf&&candidate.detectedAt-r.detectedAt<candidate.seconds*6000))return rows;
 return [candidate,...rows];
}
export function stepTap(row,tick,closed){
 if(terminal(row)||tick.epoch<=row.lastEpoch||!Number.isFinite(tick.quote))return row;
 const price=tick.quote,buy=row.side==='BUY',sign=buy?1:-1;
 let r={...row,lastEpoch:tick.epoch,gapUnverified:row.gapUnverified||tick.epoch-row.lastEpoch>30};
 const event=(type)=>{r.status=type;r.events=[...(r.events||[]),{type,epoch:tick.epoch,price,entry:r.entry,stop:r.stop,tp1:r.tp1,tp2:r.tp2,tp3:r.tp3}];};
 if(!r.entered){
  if(tick.epoch>=r.expiresAt){event('Expired');return r;}

  // Never confirm the new policy across an unobserved interval.
  if(r.policy===SHARP_POLICY && r.gapUnverified){event('Invalidated');r.reason='Data gap before confirmation';return r;}
  if(sign*(price-r.stop)<=0){event('Invalidated');return r;}
  if(!r.tapEpoch && price>=r.zoneLow && price<=r.zoneHigh){r.tapEpoch=tick.epoch;event('Tap observed');return r;}
  if(!r.tapEpoch || !closed || closed.time+row.seconds<=r.tapEpoch)return r;
  const body=sign*(closed.close-closed.open),range=closed.high-closed.low;
  const rejection=body>0 && body>=range*.3 && (buy?closed.close>row.zoneHigh:closed.close<row.zoneLow) && closed.low<=row.zoneHigh && closed.high>=row.zoneLow;
  // Only the immediately completed candle can confirm, at a current observed quote.
  if(rejection && tick.epoch>=closed.time+row.seconds && tick.epoch<closed.time+row.seconds*2 && Math.abs(price-closed.close)<=row.atr*(r.policy===SHARP_POLICY?.15:.25)){
   const sharp=r.policy===SHARP_POLICY;
   const stop=sharp?(buy?Math.min(closed.low,row.zoneLow)-row.atr*.15:Math.max(closed.high,row.zoneHigh)+row.atr*.15):row.stop;
   const risk=sign*(price-stop);
   if(sharp && (risk<row.atr*.35 || risk>row.atr*1.25)){
    r.reason='Rejected: confirmation stop distance outside 0.35–1.25 ATR';event('Invalidated');return r;
   }
   if(risk<=0 || risk>row.atr*3)return r;
   r={...r,plannedEntry:r.entry,plannedStop:r.stop,stop,riskPoints:risk,riskATR:risk/row.atr,entry:price,tp1:price+sign*risk,tp2:price+sign*risk*2,tp3:price+sign*risk*3,entered:true,confirmedAt:tick.epoch,confirmationTime:Math.floor(tick.epoch/row.seconds)*row.seconds,maxFavorableR:0,maxAdverseR:0};event('Entry confirmed');
  }
  return r;
 }
 const risk=Math.abs(r.entry-r.stop),move=sign*(price-r.entry)/risk;
 r.maxFavorableR=Math.max(r.maxFavorableR||0,move);r.maxAdverseR=Math.max(r.maxAdverseR||0,-move);
 if(move<=-1){r.resultR=-1;r.closedAt=tick.epoch;event('SL touched');}
 else if(move>=2){r.resultR=2;r.closedAt=tick.epoch;event('TP2 touched');}
 else if(move>=1 && !r.tp1At){r.tp1At=tick.epoch;event('TP1 touched');}
 return r;
}
export function tapStats(rows){
 const all=rows.filter(r=>r.engine===TAP_VERSION&&r.policy===SHARP_POLICY),eligible=all.filter(r=>Number.isFinite(r.resultR)&&!r.gapUnverified),wins=eligible.filter(r=>r.resultR>0).length;
 return {total:all.length,confirmed:all.filter(r=>r.entered).length,resolved:eligible.length,wins,losses:eligible.length-wins,gaps:all.filter(r=>r.gapUnverified).length,winRate:eligible.length?wins/eligible.length:null,expectancy:eligible.length?mean(eligible.map(r=>r.resultR)):null};
}
// Small, genuine local logistic model. Trains only on recorded prospective outcomes.
export function localModel(rows,features){
 const data=rows.filter(r=>r.engine===TAP_VERSION&&r.policy===SHARP_POLICY&&!r.gapUnverified&&Number.isFinite(r.resultR)&&r.features?.length===5&&r.features.every(Number.isFinite)).sort((a,b)=>a.detectedAt-b.detectedAt);
 const collecting={state:'Collecting data',samples:data.length,required:60};
 if(data.length<60)return collecting;
 const split=Math.floor(data.length*.7),test=data.slice(split),train=data.slice(0,split).filter(r=>r.closedAt*1000<test[0].detectedAt);
 if(train.length<40||test.length<18||new Set(train.map(r=>r.resultR>0)).size<2)return collecting;
 const sigmoid=z=>1/(1+Math.exp(-Math.max(-30,Math.min(30,z))));let weights=Array(6).fill(0);
 for(let epoch=0;epoch<250;epoch++){
  const grad=Array(6).fill(0);
  for(const r of train){const x=[1,...r.features],p=sigmoid(x.reduce((v,a,i)=>v+a*weights[i],0)),y=r.resultR>0?1:0;x.forEach((a,i)=>grad[i]+=(p-y)*a);}
  weights=weights.map((w,i)=>w-.1*(grad[i]/train.length+(i?.01*w:0)));
 }
 const predict=f=>sigmoid([1,...f].reduce((v,a,i)=>v+a*weights[i],0));
 const rate=mean(train.map(r=>r.resultR>0?1:0));
 const brier=mean(test.map(r=>(predict(r.features)-(r.resultR>0?1:0))**2));
 const baseline=mean(test.map(r=>(rate-(r.resultR>0?1:0))**2));
 const approved=brier<baseline*.95;
 return {state:approved?'Experimental model':'No measured improvement',samples:data.length,train:train.length,test:test.length,brier,baseline,estimate:approved&&features?predict(features):null};
}
