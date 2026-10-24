export const SIGNAL_KEY = 'derivai:mt5:signals:v2';
export function readStored(key, fallback) {
  try { const value=JSON.parse(localStorage.getItem(key)); return value ?? fallback; } catch { return fallback; }
}
export function writeStored(key,value) {
  try { localStorage.setItem(key,JSON.stringify(value)); return true; } catch { return false; }
}
export function freshTick(connected,tick,now=Date.now()) {
  const age=now/1000-Number(tick?.epoch);
  return connected && Number.isFinite(Number(tick?.quote)) && age>=-5 && age<30;
}
export function captureSignal(rows,a,{market,tf,time,now}) {
  if(!['BUY','SELL'].includes(a.signal) || ![a.entry,a.stop,a.tp1,a.tp2,a.tp3].every(x=>x!=null && Number.isFinite(Number(x)))) return rows;
  const id=`${market}:${tf}:${time}:${a.signal}`;
  if(rows.some(r=>r.id===id)) return rows;
  const buy=a.signal==='BUY';
  if(!(buy?a.stop<a.entry && a.tp1>a.entry:a.stop>a.entry && a.tp1<a.entry)) return rows;
  return [{id,market,tf,time,detectedAt:now,side:a.signal,entry:a.entry,stop:a.stop,tp1:a.tp1,tp2:a.tp2,tp3:a.tp3,setup:a.setup,status:'Watching entry',lastEpoch:now/1000,entered:false},...rows].slice(0,120);
}
export function advanceSignals(rows,market,tick,live) {
  if(!live) return rows;
  let changed=false;
  const next=rows.map(row=>{
    if(row.market!==market || ['SL touched','TP3 touched','Expired'].includes(row.status) || tick.epoch<=row.lastEpoch) return row;
    const gap=tick.epoch-row.lastEpoch>30;
    const price=Number(tick.quote),buy=row.side==='BUY';
    const entered=row.entered || (buy?price>=row.entry:price<=row.entry);
    let status=row.status;
    if(entered){
      if(buy?price<=row.stop:price>=row.stop) status='SL touched';
      else if(buy?price>=row.tp3:price<=row.tp3) status='TP3 touched';
      else if(buy?price>=row.tp2:price<=row.tp2) status='TP2 touched';
      else if(buy?price>=row.tp1:price<=row.tp1) status='TP1 touched';
      else if(!row.entered) status='Entry touched';
    }
    if(!entered && tick.epoch-row.detectedAt/1000>86400) status='Expired';
    changed=true;
    return {...row,entered,status,lastEpoch:tick.epoch,gapUnverified:row.gapUnverified||gap};
  });
  return changed?next:rows;
}
