const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const sd = (a) => { if (a.length < 2) return 0; const m = avg(a); return Math.sqrt(avg(a.map((v) => (v - m) ** 2))); };
const ema = (a, p) => { if (!a.length) return 0; const k = 2 / (p + 1); let x = a[0]; for (let i = 1; i < a.length; i += 1) x = a[i] * k + x * (1 - k); return x; };
const rsi = (a, p = 14) => { if (a.length <= p) return 50; let g = 0, l = 0; for (let i = a.length - p; i < a.length; i += 1) { const d = a[i] - a[i - 1]; if (d > 0) g += d; else l -= d; } return l ? 100 - 100 / (1 + g / l) : 100; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

function featuresAt(a, i) {
  const end = i + 1;
  const short = a.slice(Math.max(0, end - 12), end);
  const med = a.slice(Math.max(0, end - 30), end);
  const long = a.slice(Math.max(0, end - 80), end);
  if (short.length < 12 || med.length < 20 || long.length < 40) return null;
  const tick = avg(long.slice(1).map((v, j) => Math.abs(v - long[j]))) || 1e-9;
  const e9 = ema(long.slice(-40), 9), e21 = ema(long.slice(-60), 21);
  const m8 = (short.at(-1) - short[0]) / (tick * Math.sqrt(8));
  const m20 = (med.at(-1) - med[0]) / (tick * Math.sqrt(20));
  const eGap = (e9 - e21) / tick;
  const vol = sd(short.slice(1).map((v, j) => v - short[j])) / tick;
  const extension = Math.abs(short.at(-1) - e9) / tick;
  let same = 0, moves = 0, prev = 0;
  for (let j = 1; j < med.length; j += 1) { const d = sign(med[j] - med[j - 1]); if (!d) continue; if (prev && d === prev) same += 1; prev = d; moves += 1; }
  return { direction: sign(eGap + m8 * .35 + m20 * .25), eGap, m8, m20, vol, extension, rsi: rsi(long), persistence: moves > 1 ? same / (moves - 1) : 0 };
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  const parts = [[a.direction,b.direction,1.4],[a.eGap,b.eGap,.45],[a.m8,b.m8,.55],[a.m20,b.m20,.4],[a.vol,b.vol,.35],[a.extension,b.extension,.25],[(a.rsi-50)/20,(b.rsi-50)/20,.35],[a.persistence,b.persistence,.35]];
  return Math.sqrt(parts.reduce((s,[x,y,w]) => s + ((x-y)*w) ** 2, 0));
}

function historicalProbability(values, current, horizon, direction) {
  if (!current || values.length < 220) return { probability: .5, samples: 0 };
  const candidates = [];
  for (let i = 80; i < values.length - horizon; i += 2) {
    const f = featuresAt(values, i);
    if (!f || sign(f.direction) !== direction) continue;
    const d = distance(current, f);
    if (d < 2) candidates.push({ d, win: sign(values[i + horizon] - values[i]) === direction ? 1 : 0 });
  }
  if (candidates.length < 12) return { probability: .5, samples: candidates.length };
  candidates.sort((a,b) => a.d - b.d);
  const nearest = candidates.slice(0, 50);
  let w = 0, wins = 0;
  for (const c of nearest) { const weight = 1 / (.2 + c.d ** 2); w += weight; wins += c.win * weight; }
  const raw = wins / Math.max(w, 1e-9);
  const shrink = .30 + clamp((nearest.length - 12) / 38, 0, 1) * .70;
  return { probability: clamp(.5 + (raw - .5) * shrink, .35, .65), samples: nearest.length };
}

export function analyzeAdaptiveTrend(prices = [], options = {}) {
  const v = prices.map((x) => Number(x?.quote ?? x)).filter(Number.isFinite).slice(-800);
  const horizon = Math.max(2, Math.min(20, Math.round(Number(options.duration) || 5)));
  if (v.length < 160) return { ready:false, signal:"WAIT", rawDirection:"WAIT", grade:"BUILDING", score:0, confidence:0, probability:.5, samples:0, trend:"WAITING", momentum:"WAITING", pullback:"WAITING", volatility:"WAITING", reason:`Collecting market data ${v.length}/160`, rsi:50, horizon };

  const cur = v.at(-1), long = v.slice(-160), short = v.slice(-12), medium = v.slice(-30);
  const tick = avg(long.slice(1).map((x,i)=>Math.abs(x-long[i]))) || Math.max(Math.abs(cur)*1e-7,1e-9);
  const e9 = ema(long.slice(-70),9), e21 = ema(long,21);
  const gap=(e9-e21)/tick, m8=(cur-v.at(-9))/(tick*Math.sqrt(8)), m20=(cur-v.at(-21))/(tick*Math.sqrt(20));
  const rv=rsi(long), vol=sd(short.slice(1).map((x,i)=>x-short[i]))/tick, extension=Math.abs(cur-e9)/tick;
  let same=0,moves=0,prev=0; for(let i=1;i<medium.length;i+=1){const d=sign(medium[i]-medium[i-1]);if(!d)continue;if(prev&&d===prev)same+=1;prev=d;moves+=1;}
  const persistence=moves>1?same/(moves-1):0;
  const bull=gap>.25&&m20>.25, bear=gap<-.25&&m20<-.25;
  const rawDirection=bull&&!bear?"RISE":bear&&!bull?"FALL":"WAIT", direction=rawDirection==="RISE"?1:-1;
  const momentum=rawDirection!=="WAIT"&&sign(m8)===direction&&Math.abs(m8)>=.25;
  const pullback=extension<=1.35&&extension>=.03;
  const rsiAligned=rawDirection==="RISE"?rv>=51&&rv<=68:rawDirection==="FALL"?rv<=49&&rv>=32:false;
  const calm=vol>=.35&&vol<=1.85, stable=persistence>=.48;
  const hist=rawDirection==="WAIT"?{probability:.5,samples:0}:historicalProbability(v,featuresAt(v,v.length-1),horizon,direction);
  const confirmations=[bull||bear,momentum,pullback,rsiAligned,calm,stable].filter(Boolean).length;
  const probability=rawDirection==="WAIT"?.5:clamp(.5+(hist.probability-.5)*1.05+(confirmations-3)*.012,.35,.65);
  let score=45+Math.min(18,Math.abs(gap)*3)+Math.min(12,Math.abs(m20)*4)+(momentum?9:-8)+(pullback?9:-7)+(rsiAligned?6:-4)+(calm?5:-7)+(stable?5:-5);
  score=Math.round(clamp(score,0,100));
  const grade=rawDirection!=="WAIT"&&score>=82&&confirmations>=5&&probability>=.56?"A+":rawDirection!=="WAIT"&&score>=74&&confirmations>=4?"A":"WAIT";
  const signal=grade==="A+"?rawDirection:"WAIT";
  const confidence=Math.round(clamp(50+(score-50)*.9+(probability-.5)*100,50,95));
  return {ready:true,signal,rawDirection,grade,score,confidence,probability:Number(probability.toFixed(4)),samples:hist.samples,trend:bull?"BULLISH":bear?"BEARISH":"MIXED",momentum:m8>.2?"UP":m8<-.2?"DOWN":"FLAT",pullback:pullback?"READY":"WAITING",volatility:vol>1.85?"HIGH":vol<.35?"LOW":"NORMAL",rsi:rv,emaFast:e9,emaSlow:e21,persistence,confirmations,horizon,reason:grade==="A+"?`${rawDirection} A+ · ${confirmations}/6 confirmations · ${(probability*100).toFixed(1)}% model · ${hist.samples} historical matches.`:`Waiting · ${confirmations}/6 confirmations · ${(probability*100).toFixed(1)}% model.`};
}
export default analyzeAdaptiveTrend;
