import { SHARP_POLICY } from './volatilityTapEngine.js';
export const finished = r => ['SL touched','TP2 touched','TP3 touched','Invalidated','Expired'].includes(r?.status);
export const currentSetup = rows => rows.find(r=>r.policy===SHARP_POLICY && !finished(r)) || rows.find(r=>r.policy===SHARP_POLICY) || null;
export function setupLabel(r) {
 if(!r)return 'WAIT';
 if(r.status==='SL touched')return 'FAILED';
 if(['TP2 touched','TP3 touched'].includes(r.status))return 'TARGET HIT';
 if(r.status==='Invalidated')return 'CANCELLED';
 if(r.status==='Expired')return 'EXPIRED';
 return r.entered?`${r.side} CONFIRMED`:'WAIT ENTRY';
}
export function historyMarkers(rows, candles, seconds) {
 const times=new Set(candles.map(c=>c.time));
 const markers=[];
 for(const r of rows){
  const events=r.events?.length?r.events:[{type:r.entered?'Recorded entry':'Zone created',epoch:r.confirmedAt || r.time}];
  for(const e of events){
   const time=Math.floor(e.epoch/seconds)*seconds;
   if(!times.has(time))continue;
   const failure=e.type==='SL touched';
   const confirmed=['Entry confirmed','Recorded entry'].includes(e.type);
   const label=failure?'FAILED · SL touched':confirmed?`${r.side} CONFIRMED`:e.type==='Zone created'?`${r.side} SETUP`:e.type;
   markers.push({time,position:r.side==='BUY'?'belowBar':'aboveBar',color:failure?'#ff6685':confirmed?'#18d6a1':'#b5a0dc',shape:confirmed?(r.side==='BUY'?'arrowUp':'arrowDown'):'circle',text:`${r.policy!==SHARP_POLICY?'OLD · ':''}${label} · ${new Date(e.epoch*1000).toLocaleString()}`});
  }
 }
 return markers.sort((a,b)=>a.time-b.time);
}
export function mergeHistory(existing, incoming) {
 if(!Array.isArray(incoming) || incoming.some(r=>!r || typeof r.id!=='string' || typeof r.market!=='string' || !['BUY','SELL'].includes(r.side) || ![r.entry,r.stop,r.tp1,r.tp2,r.tp3,r.time,r.detectedAt,r.lastEpoch].every(Number.isFinite)))throw Error('Invalid history file');
 if(incoming.some(r=>(r.events!=null && (!Array.isArray(r.events)||r.events.some(e=>!e||typeof e.type!=='string'||!Number.isFinite(e.epoch)))) || (r.candles!=null && (!Array.isArray(r.candles)||r.candles.some(c=>!c||![c.time,c.open,c.high,c.low,c.close].every(Number.isFinite))))))throw Error('Invalid event or candle history');
 const map=new Map(incoming.map(r=>[r.id,r]));
 for(const r of existing)map.set(r.id,r); // Never overwrite locally observed records with imports.
 return [...map.values()].sort((a,b)=>b.detectedAt-a.detectedAt);
}
