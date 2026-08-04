import { analyzeQuantumRiseFall } from "./quantumRiseFallEngine";

const clamp=(v,a=0,b=100)=>Math.max(a,Math.min(b,Number(v)||0));
const nums=(x=[])=>x.map(v=>Number(typeof v==="number"?v:v?.quote??v?.price??v?.value??0)).filter(Number.isFinite);
const avg=x=>x.length?x.reduce((a,b)=>a+b,0)/x.length:0;
const ema=(x,p)=>{x=nums(x);if(!x.length)return 0;const a=2/(p+1);return x.slice(1).reduce((r,v)=>v*a+r*(1-a),x[0]);};
const slope=x=>{x=nums(x);return x.length<3?0:(x.at(-1)-x[0])/(x.length-1);};
const sd=x=>{const m=avg(x);return Math.sqrt(avg(x.map(v=>(v-m)**2)));};
const sig=v=>v>0?"RISE":v<0?"FALL":"WAIT";
const model=(name,signal,confidence,reason)=>({name,signal,confidence:clamp(confidence),reason});

function trendAI(x){
  const f=ema(x,6),m=ema(x,14),s=ema(x,30),fs=slope(x.slice(-10)),ms=slope(x.slice(-28));
  const signal=f>m&&m>s&&fs>0&&ms>0?"RISE":f<m&&m<s&&fs<0&&ms<0?"FALL":"WAIT";
  return model("Trend AI",signal,signal==="WAIT"?34:76,signal==="WAIT"?"EMA structure mixed.":`${signal} EMA stack aligned.`);
}
function momentumAI(x){
  const a=x.slice(-6),b=x.slice(-16),m1=a.at(-1)-a[0],m2=b.at(-1)-b[0],acc=m1-m2/2.5;
  const signal=Math.sign(m1)===Math.sign(m2)&&Math.sign(m1)===Math.sign(acc)?sig(m1):"WAIT";
  return model("Momentum AI",signal,signal==="WAIT"?36:74,signal==="WAIT"?"Impulse conflict.":`${signal} impulse aligned.`);
}
function regimeAI(base){
  const ok=Number(base.noiseScore||100)<=58&&Number(base.consistency||0)>=32&&Number(base.reversalRisk||100)<=48;
  return model("Regime AI",ok?(base.candidate||"WAIT"):"WAIT",ok?72:30,ok?"Tradable regime.":"Noise/risk gate blocked.");
}
function transitionAI(x){
  let uu=0,ud=0,dd=0,du=0;
  x=x.slice(-70);
  for(let i=2;i<x.length;i++){const p=Math.sign(x[i-1]-x[i-2]),c=Math.sign(x[i]-x[i-1]);if(p>0&&c>0)uu++;if(p>0&&c<0)ud++;if(p<0&&c<0)dd++;if(p<0&&c>0)du++;}
  const up=uu/Math.max(1,uu+ud),down=dd/Math.max(1,dd+du),best=Math.max(up,down);
  const signal=best>=.62?(up>down?"RISE":"FALL"):"WAIT";
  return model("Transition AI",signal,best*100,signal==="WAIT"?"No transition edge.":`${signal} continuation ${(best*100).toFixed(0)}%.`);
}
function structureAI(x,base){
  x=x.slice(-55);const lo=Math.min(...x),hi=Math.max(...x),r=Math.max(1e-9,hi-lo),pos=(x.at(-1)-lo)/r,c=base.candidate||"WAIT";
  const room=c==="RISE"?pos<=.82:c==="FALL"?pos>=.18:false;
  const ok=room&&Number(base.reversalRisk||100)<=44;
  return model("Structure AI",ok?c:"WAIT",ok?70:32,ok?`${c} has room.`:"Too close to an extreme.");
}

export function analyzeQuantumFiveAI(prices=[],options={}){
  const x=nums(prices).slice(-260),base=analyzeQuantumRiseFall(x,options);
  if(x.length<55)return {...base,fiveAI:{models:[],agreement:0,required:4,signal:"WAIT"}};
  const models=[trendAI(x),momentumAI(x),regimeAI(base),transitionAI(x),structureAI(x,base)];
  const rise=models.filter(m=>m.signal==="RISE"),fall=models.filter(m=>m.signal==="FALL");
  const win=rise.length>fall.length?rise:fall,candidate=win===rise?"RISE":"FALL",agreement=win.length,aiConfidence=avg(win.map(m=>m.confidence));
  const strictRisk =
    Number(base.noiseScore || 100) <= 58 &&
    Number(base.reversalRisk || 100) <= 48 &&
    Number(base.consistency || 0) >= 30;

  const responsiveRisk =
    Number(base.noiseScore || 100) <= 50 &&
    Number(base.reversalRisk || 100) <= 40 &&
    Number(base.consistency || 0) >= 34 &&
    Number(base.confidence || 0) >= 64;

  const strictReady =
    agreement >= 4 &&
    aiConfidence >= 68 &&
    strictRisk;

  const responsiveReady =
    agreement === 3 &&
    aiConfidence >= 72 &&
    responsiveRisk;

  const ready = strictReady || responsiveReady;

  const short =
    agreement === 5 &&
    aiConfidence >= 86 &&
    Number(base.noiseScore || 100) <= 42 &&
    Number(base.reversalRisk || 100) <= 30;

  const medium =
    agreement >= 4 &&
    aiConfidence >= 78 &&
    Number(base.noiseScore || 100) <= 50;

  const plan = short
    ? { duration: 3, durationUnit: "t", displayDuration: "3 TICKS" }
    : medium
    ? { duration: 5, durationUnit: "t", displayDuration: "5 TICKS" }
    : responsiveReady
    ? { duration: 15, durationUnit: "s", displayDuration: "15 SECONDS" }
    : { duration: 20, durationUnit: "s", displayDuration: "20 SECONDS" };
  return {
    ...base,
    ready,
    decision: ready ? candidate : "WAIT",
    candidate,
    confidence: ready
      ? clamp((aiConfidence + Number(base.confidence || 0)) / 2)
      : clamp(Math.min(aiConfidence, Number(base.confidence || 0))),
    ...plan,
    entryMode: ready
      ? agreement === 5
        ? "FIVE-AI"
        : responsiveReady
        ? "RESPONSIVE"
        : "ENSEMBLE"
      : "WAIT",
    reason: ready
      ? `${agreement}/5 AI models confirm ${candidate} through ${
          responsiveReady ? "responsive" : "strict"
        } lane.`
      : `WAIT: ${agreement}/5 AI models agree, but entry quality is still below the active lane.`,
    checks: [
      ...(base.checks || []),
      {
        label: "Five-AI agreement",
        passed: agreement >= 4 || responsiveReady,
        value: `${agreement}/5`,
      },
      {
        label: "Strict risk gate",
        passed: strictRisk,
        value: strictRisk ? "PASS" : "BLOCK",
      },
      {
        label: "Responsive gate",
        passed: responsiveReady,
        value: responsiveReady ? "PASS" : "WAIT",
      },
    ],
    fiveAI: {
      models,
      agreement,
      required: responsiveReady ? 3 : 4,
      signal: ready ? candidate : "WAIT",
      candidate,
      confidence: aiConfidence,
      hardRiskGate: strictRisk,
      responsiveReady,
    },
  };
}

