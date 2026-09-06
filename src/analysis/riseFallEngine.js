const clamp=(v,min,max)=>Math.max(min,Math.min(max,Number(v)||0));
const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:0;
const std=a=>{if(a.length<2)return 0;const m=mean(a);return Math.sqrt(mean(a.map(v=>(v-m)**2)));};
const slope=a=>{const n=a.length;if(n<3)return 0;const xm=(n-1)/2,ym=mean(a);let p=0,d=0;for(let i=0;i<n;i++){const x=i-xm;p+=x*(a[i]-ym);d+=x*x;}return d?p/d:0;};
const ema=(a,p)=>{if(!a.length)return null;const k=2/(p+1);let e=a[0];for(let i=1;i<a.length;i++)e=k*a[i]+(1-k)*e;return e;};
const dir=a=>{if(a.length<2)return 0;let u=0,d=0;for(let i=1;i<a.length;i++){const x=a[i]-a[i-1];if(x>0)u++;if(x<0)d++;}return(u-d)/(u+d||1);};
const persistence=a=>{let same=0,moves=0,prev=0;for(let i=1;i<a.length;i++){const x=Math.sign(a[i]-a[i-1]);if(!x)continue;if(prev&&x===prev)same++;prev=x;moves++;}return moves>1?same/(moves-1):0;};
const reversals=a=>{let r=0,m=0,p=0;for(let i=1;i<a.length;i++){const x=Math.sign(a[i]-a[i-1]);if(!x)continue;if(p&&x!==p)r++;p=x;m++;}return m>1?r/(m-1):0;};
const move=(a,n)=>{if(a.length<=n)return 0;const recent=a.slice(-Math.min(a.length,n+1));const noise=std(recent.slice(1).map((v,i)=>v-recent[i]));return noise?clamp((a.at(-1)-a.at(-1-n))/(noise*Math.sqrt(n)),-3,3):0;};

export function analyzeRiseFall(prices=[],opts={}){
 const a=prices.map(Number).filter(Number.isFinite).slice(-240), minSamples=Number(opts.minimumSamples??60), minConfidence=Number(opts.minimumConfidence??68);
 if(a.length<minSamples)return{ready:false,signal:'WAIT',contractType:null,confidence:0,sampleSize:a.length,reason:`Collecting data ${a.length}/${minSamples}.`,features:{}};
 const s=a.slice(-12),m=a.slice(-30),l=a.slice(-80), base=std(l.slice(1).map((v,i)=>v-l[i]))||1;
 const m3=move(a,3),m8=move(a,8),m20=move(a,20),ds=dir(s),dm=dir(m),ps=persistence(m),rs=reversals(s),sl=slope(s)/base,ml=slope(m)/base;
 const e8=ema(a.slice(-40),8),e21=ema(a.slice(-80),21),emaGap=(e8-e21)/base,vr=std(s.slice(1).map((v,i)=>v-s[i]))/base;
 let score=m3*.22+m8*.20+m20*.13+ds*.12+dm*.10+clamp(sl,-2,2)*.08+clamp(ml,-2,2)*.05+clamp(emaGap,-2,2)*.06+clamp((a.at(-1)-e21)/base/2,-1,1)*.04;
 score+=Math.sign(score)*(ps-.5)*.35-Math.sign(score)*Math.max(0,rs-.55)*.70-Math.sign(score)*(vr>2.4?Math.min(.65,(vr-2.4)*.22):0);
 score=clamp(score,-1.8,1.8);const raw=score>=0?'RISE':'FALL',confidence=clamp(50+Math.abs(score)/1.8*45,50,95);
 const agreement=[Math.sign(m8),Math.sign(m20),Math.sign(dm),Math.sign(emaGap)].filter(x=>x===Math.sign(score)).length;
 const vol=vr>2.2?'HIGH':vr<.65?'LOW':'NORMAL',qualified=confidence>=minConfidence&&agreement>=3&&vol!=='HIGH'&&rs<.72,signal=qualified?raw:'WAIT';
 return{ready:true,signal,rawDirection:raw,contractType:signal==='RISE'?'CALL':signal==='FALL'?'PUT':null,confidence:Number(confidence.toFixed(1)),score:Number(score.toFixed(3)),sampleSize:a.length,trend:ml>0?'UP':ml<0?'DOWN':'FLAT',momentum:m8>.35?'BULLISH':m8<-.35?'BEARISH':'NEUTRAL',volatility:vol,agreement,reason:qualified?`${raw} confirmed by ${agreement}/4 directional checks.`:'Signal filtered: evidence is not strong enough.',features:{m3:Number(m3.toFixed(3)),m8:Number(m8.toFixed(3)),m20:Number(m20.toFixed(3)),persistence:Number(ps.toFixed(3)),reversal:Number(rs.toFixed(3)),volatilityRatio:Number(vr.toFixed(3))}};
}
export default analyzeRiseFall;
