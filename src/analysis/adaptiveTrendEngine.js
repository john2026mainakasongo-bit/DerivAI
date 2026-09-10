const avg=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:0;
const sd=a=>{if(a.length<2)return 0;const m=avg(a);return Math.sqrt(avg(a.map(v=>(v-m)**2)))};
const ema=(a,p)=>{if(!a.length)return 0;const k=2/(p+1);let x=a[0];for(let i=1;i<a.length;i++)x=a[i]*k+x*(1-k);return x};
const rsi=(a,p=14)=>{if(a.length<=p)return 50;let g=0,l=0;for(let i=a.length-p;i<a.length;i++){const d=a[i]-a[i-1];if(d>=0)g+=d;else l-=d}return l?100-100/(1+g/l):100};
const slope=a=>{const n=a.length;if(n<3)return 0;const xm=(n-1)/2,ym=avg(a);let no=0,de=0;for(let i=0;i<n;i++){no+=(i-xm)*(a[i]-ym);de+=(i-xm)**2}return de?no/de:0};

export function analyzeAdaptiveTrend(prices=[]){
 const v=prices.map(x=>Number(x?.quote??x)).filter(Number.isFinite).slice(-240);
 if(v.length<80)return{ready:false,signal:"WAIT",grade:"BUILDING",score:0,confidence:0,trend:"WAITING",momentum:"WAITING",pullback:"WAITING",volatility:"WAITING",reason:`Collecting market data ${v.length}/80`,rsi:50};
 const cur=v.at(-1),fast=ema(v.slice(-80),9),slow=ema(v.slice(-120),21);
 const mom=avg(v.slice(-12))-avg(v.slice(-24,-12)),dev=Math.max(sd(v.slice(-40)),Math.abs(cur)*1e-7,1e-9);
 const sl=slope(v.slice(-30)), ms=Math.abs(mom)/dev, ss=Math.abs(sl)/dev, rv=rsi(v);
 const pb=Math.abs(cur-fast)/Math.max(Math.abs(cur),1e-9)<.0015;
 const bull=fast>slow&&sl>0,bear=fast<slow&&sl<0,up=mom>0,down=mom<0;
 const br=rv>=52&&rv<=72,fr=rv<=48&&rv>=28;
 let rise=0,fall=0;
 if(bull)rise+=32;if(bear)fall+=32;if(up)rise+=22;if(down)fall+=22;
 if(br)rise+=18;if(fr)fall+=18;if(pb&&cur>=fast)rise+=14;if(pb&&cur<=fast)fall+=14;
 if(ss>=.7){if(sl>0)rise+=8;if(sl<0)fall+=8} if(ms>=.7){if(mom>0)rise+=6;if(mom<0)fall+=6}
 const gap=Math.abs(rise-fall),best=rise>=fall?"RISE":"FALL",score=Math.max(rise,fall);
 const grade=score>=86&&gap>=18?"A+":score>=78&&gap>=12?"A":score>=68&&gap>=9?"B":"WAIT";
 const valid=grade==="A+"&&ss>=.45&&ms>=.35&&pb;
 return{ready:true,signal:valid?best:"WAIT",grade,score,confidence:Math.min(99,Math.round(score+Math.min(gap,18)*.7)),gap,
 trend:bull?"BULLISH":bear?"BEARISH":"MIXED",momentum:up?"UP":down?"DOWN":"FLAT",pullback:pb?"READY":"WAITING",
 volatility:ms>1.8?"HIGH":ms<.45?"LOW":"NORMAL",reason:valid?`${best} A+ trend + momentum + pullback alignment`:`Waiting: ${grade} setup / gap ${gap.toFixed(0)}pp`,emaFast:fast,emaSlow:slow,rsi:rv};
}
export default analyzeAdaptiveTrend;
