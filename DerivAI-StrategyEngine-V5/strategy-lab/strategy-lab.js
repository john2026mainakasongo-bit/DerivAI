const $ = id => document.getElementById(id);

function rng(seed=123456){
  let s=seed>>>0;
  return ()=>{s=(1664525*s+1013904223)>>>0;return s/4294967296}
}

function makeSeries(n){
  const r=rng(42), a=[]; let p=1000, drift=0;
  for(let i=0;i<n;i++){
    if(i%250===0) drift=(r()-.5)*1.6;
    const noise=(r()-.5)*2.2;
    p += drift + noise;
    a.push(p);
  }
  return a;
}

// Simple research strategy:
// - EMA trend alignment
// - momentum confirmation
// - volatility filter
// - confidence threshold
function ema(arr, period){
  const k=2/(period+1), out=[arr[0]];
  for(let i=1;i<arr.length;i++) out.push(arr[i]*k+out[i-1]*(1-k));
  return out;
}
function stdev(arr, from, to){
  const x=arr.slice(from,to); if(!x.length)return 0;
  const m=x.reduce((a,b)=>a+b,0)/x.length;
  return Math.sqrt(x.reduce((a,b)=>a+(b-m)**2,0)/x.length);
}
function signalAt(a,i){
  if(i<30) return {side:"WAIT",conf:0,setup:"INSUFFICIENT DATA",regime:"—"};
  const e9=ema(a.slice(0,i+1),9).at(-1), e21=ema(a.slice(0,i+1),21).at(-1);
  const momentum=a[i]-a[i-8];
  const vol=stdev(a,i-20,i);
  const avgMove=a.slice(i-20,i).reduce((s,_,j)=>s+Math.abs(a[i-20+j+1]-a[i-20+j]),0)/19;
  let score=50;
  if(e9>e21) score+=14; else score-=14;
  if(momentum>0) score+=18; else score-=18;
  if(Math.abs(momentum)>avgMove*2) score+=10;
  const noisy=vol>avgMove*5;
  if(noisy) score-=8;
  const side=score>=68?"RISE":score<=32?"FALL":"WAIT";
  return {side,conf:Math.min(95,Math.max(5,Math.abs(score-50)*2)),setup:side==="WAIT"?"NO VALID SETUP":"MOMENTUM + EMA",regime:noisy?"NOISY":(e9>e21?"UP":"DOWN")};
}

function backtest(a, rr){
  let equity=0, peak=0, dd=0, wins=0, losses=0, grossWin=0, grossLoss=0, streak=0, maxStreak=0;
  const curve=[0], trades=[];
  for(let i=35;i<a.length-3;i++){
    const s=signalAt(a,i);
    if(s.side==="WAIT" || s.conf<68) continue;
    const entry=a[i], future=a[i+1];
    const move=a[i+3]-entry;
    const direction=s.side==="RISE"?1:-1;
    // Normalized R outcome for research only; not a real contract payout.
    const r=move*direction>0 ? rr : -1;
    equity+=r; curve.push(equity);
    if(r>0){wins++;grossWin+=r;streak=0}else{losses++;grossLoss+=1;streak++;maxStreak=Math.max(maxStreak,streak)}
    peak=Math.max(peak,equity); dd=Math.max(dd,peak-equity);
    trades.push({i,s,r});
  }
  const total=wins+losses, pf=grossLoss?grossWin/grossLoss:0;
  return {equity,curve,total,wins,losses,winrate:total?wins/total*100:0,pf,dd,maxStreak};
}

function draw(curve){
  const c=$("chart"),x=c.getContext("2d"),w=c.width,h=c.height;
  x.clearRect(0,0,w,h);
  if(curve.length<2)return;
  const min=Math.min(...curve),max=Math.max(...curve),span=max-min||1;
  x.strokeStyle="#1b4257"; x.lineWidth=1;
  for(let j=1;j<5;j++){const y=j*h/5;x.beginPath();x.moveTo(0,y);x.lineTo(w,y);x.stroke()}
  x.strokeStyle="#2aa9f4";x.lineWidth=2;x.beginPath();
  curve.forEach((v,i)=>{const px=i*(w-20)/(curve.length-1)+10, py=h-10-(v-min)/span*(h-25);i?x.lineTo(px,py):x.moveTo(px,py)});
  x.stroke();
}

function run(){
  const n=Math.max(100,Math.min(50000,+$("sampleSize").value||5000));
  const rr=+$("rr").value;
  const a=makeSeries(n), s=signalAt(a,a.length-1), b=backtest(a,rr);
  $("signal").textContent=s.side;
  $("signalMeta").textContent=`${$("market").value} • confidence ${s.conf.toFixed(0)}% • research signal only`;
  $("setup").textContent=s.setup;
  $("confidence").textContent=s.conf.toFixed(0)+"%";
  $("regime").textContent=s.regime;
  $("meterFill").style.width=Math.min(100,s.conf)+"%";
  $("trades").textContent=b.total;
  $("winrate").textContent=b.winrate.toFixed(1)+"%";
  $("pf").textContent=b.pf.toFixed(2);
  $("dd").textContent=b.dd.toFixed(1)+"R";
  $("netr").textContent=(b.equity>=0?"+":"")+b.equity.toFixed(1)+"R";
  $("streak").textContent=b.maxStreak;
  draw(b.curve);
}
$("run").addEventListener("click",run);
run();
