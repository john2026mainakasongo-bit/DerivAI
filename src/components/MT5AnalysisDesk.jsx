import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, LineSeries, createChart, createSeriesMarkers } from "lightweight-charts";
import useDerivTicks from "../hooks/useDerivTicks";

const TF = {
  "1m": 60, "2m": 120, "3m": 180, "5m": 300, "10m": 600,
  "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200,
  "4h": 14400, "8h": 28800, "24h": 86400,
};
const WANTED = [100, 75, 25, 10];

const n = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
const keyOf = (m) => String(m?.id || m?.symbol || "");
const labelOf = (m) => String(m?.label || m?.short || m?.id || "Volatility");
const avg = (a) => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;
const clamp = (v,a,b) => Math.min(b,Math.max(a,v));

function matches(m, v) {
  const id = String(m?.id || "").toUpperCase();
  const s = String(m?.symbol || "").toUpperCase();
  const label = labelOf(m);
  return id === `R_${v}` || id === `1HZ${v}V` || s === `R_${v}` || s === `1HZ${v}V` ||
    new RegExp(`Volatility\\s*${v}(?:\\s*\\([^)]*\\))?\\s*Index`, "i").test(label);
}

function candlesFromTicks(rows, seconds) {
  const map = new Map();
  for (const r of rows || []) {
    const t = Math.floor(n(r?.epoch) / seconds) * seconds;
    const p = n(r?.quote, NaN);
    if (!t || !Number.isFinite(p)) continue;
    const c = map.get(t);
    if (!c) map.set(t,{time:t,open:p,high:p,low:p,close:p});
    else { c.high=Math.max(c.high,p); c.low=Math.min(c.low,p); c.close=p; }
  }
  return [...map.values()].sort((a,b)=>a.time-b.time);
}

function ema(values, period) {
  if (!values.length) return [];
  const k=2/(period+1); let e=values[0];
  return values.map((v,i)=>{ if(i) e=v*k+e*(1-k); return e; });
}

function normalizeCandles(rows) {
  return (rows || [])
    .map((c) => ({
      time: Number(c?.time ?? c?.epoch),
      open: Number(c?.open),
      high: Number(c?.high),
      low: Number(c?.low),
      close: Number(c?.close),
    }))
    .filter(c =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .sort((a,b)=>a.time-b.time);
}

function chartEvents(cs) {
  const events = [];
  if (cs.length < 12) return events;

  for (let i = 6; i < cs.length; i++) {
    const c = cs[i];
    const prior = cs.slice(Math.max(0, i - 10), i);
    const hi = Math.max(...prior.map(x => x.high));
    const lo = Math.min(...prior.map(x => x.low));
    const range = Math.max(c.high - c.low, 1e-9);
    const upper = (c.high - Math.max(c.open,c.close)) / range;
    const lower = (Math.min(c.open,c.close) - c.low) / range;

    if (c.close > hi && c.open <= hi) {
      events.push({ time:c.time, position:"aboveBar", color:"#24dfb0", shape:"arrowUp", text:"BREAKOUT" });
    }
    if (c.close < lo && c.open >= lo) {
      events.push({ time:c.time, position:"belowBar", color:"#ff6685", shape:"arrowDown", text:"BREAKOUT" });
    }

    if (upper > .42 && c.close < c.open && c.high > hi) {
      events.push({ time:c.time, position:"aboveBar", color:"#ff9a66", shape:"circle", text:"LIQUIDITY" });
    }
    if (lower > .42 && c.close > c.open && c.low < lo) {
      events.push({ time:c.time, position:"belowBar", color:"#27dabb", shape:"circle", text:"LIQUIDITY" });
    }

    const breakoutUp = cs.slice(Math.max(0,i-6),i).some(x=>x.close>hi);
    const breakoutDn = cs.slice(Math.max(0,i-6),i).some(x=>x.close<lo);
    if (breakoutUp && c.low <= hi && c.close > hi) {
      events.push({ time:c.time, position:"belowBar", color:"#55e6bf", shape:"circle", text:"RETEST" });
    }
    if (breakoutDn && c.high >= lo && c.close < lo) {
      events.push({ time:c.time, position:"aboveBar", color:"#ff8aa0", shape:"circle", text:"RETEST" });
    }

    if (lower > .48 && c.close > c.open) {
      events.push({ time:c.time, position:"belowBar", color:"#62efc6", shape:"circle", text:"REJECTION" });
    }
    if (upper > .48 && c.close < c.open) {
      events.push({ time:c.time, position:"aboveBar", color:"#ff7f98", shape:"circle", text:"REJECTION" });
    }
  }

  const dedup = new Map();
  for (const e of events) dedup.set(`${e.time}-${e.text}`, e);
  return [...dedup.values()].slice(-24);
}

function analyze(cs) {
  if (cs.length < 24) return {
    signal:"WAIT", bias:"BUILDING", score:0, confidence:0, setup:"BUILDING",
    structure:"BUILDING", liquidity:"WAITING", momentum:"WAITING",
    reason:`Need more candles (${cs.length}/24).`, confirmations:[], entry:null, stop:null, target:null,
    support:null,resistance:null,ema20:null,ema50:null,atr:null
  };

  const closes=cs.map(c=>c.close), last=cs.at(-1), prev=cs.at(-2);
  const e20=ema(closes,20).at(-1), e50=ema(closes,Math.min(50,closes.length)).at(-1);
  const ranges=cs.slice(-14).map((c,i)=>i?Math.max(c.high-c.low,Math.abs(c.high-cs.at(-15+i).close),Math.abs(c.low-cs.at(-15+i).close)):c.high-c.low);
  const atr=avg(ranges);
  const recent=cs.slice(-12,-1), hi=Math.max(...recent.map(c=>c.high)), lo=Math.min(...recent.map(c=>c.low));
  const old=cs.slice(-24,-12), oldHi=Math.max(...old.map(c=>c.high)), oldLo=Math.min(...old.map(c=>c.low));
  const bullish=last.close>e20 && e20>=e50, bearish=last.close<e20 && e20<=e50;
  const breakUp=last.close>hi+atr*.05, breakDn=last.close<lo-atr*.05;
  const sweepUp=last.high>hi+atr*.08 && last.close<hi;
  const sweepDn=last.low<lo-atr*.08 && last.close>lo;
  const upper=(last.high-Math.max(last.open,last.close))/Math.max(last.high-last.low,1e-9);
  const lower=(Math.min(last.open,last.close)-last.low)/Math.max(last.high-last.low,1e-9);
  const rejectBuy=lower>.42 && last.close>last.open;
  const rejectSell=upper>.42 && last.close<last.open;
  const near=Math.abs(last.close-e20)<=atr*.35;
  const contBuy=near && last.close>last.open && prev.close<=prev.open && last.close>prev.high;
  const contSell=near && last.close<last.open && prev.close>=prev.open && last.close<prev.low;
  const recentBreakUp=cs.slice(-8,-1).some(c=>c.close>hi);
  const recentBreakDn=cs.slice(-8,-1).some(c=>c.close<lo);
  const retestBuy=recentBreakUp && last.low<=hi+atr*.35 && last.close>hi;
  const retestSell=recentBreakDn && last.high>=lo-atr*.35 && last.close<lo;
  const fakeBuy=recentBreakUp && last.high>=hi && last.close<hi;
  const fakeSell=recentBreakDn && last.low<=lo && last.close>lo;
  const mom=avg(cs.slice(-5).map(c=>c.close-c.open))/Math.max(atr,1e-9);

  const buy=[
    ["Trend alignment",bullish],["Breakout",breakUp],["Retest",retestBuy],
    ["Liquidity sweep",sweepDn],["Rejection",rejectBuy],["Pullback",near&&last.close>last.open],
    ["Continuation",contBuy],["Momentum",mom>.15],
    ["Structure",last.high>Math.max(...cs.slice(-8,-3).map(c=>c.high))]
  ];
  const sell=[
    ["Trend alignment",bearish],["Breakout",breakDn],["Retest",retestSell],
    ["Liquidity sweep",sweepUp],["Rejection",rejectSell],["Pullback",near&&last.close<last.open],
    ["Continuation",contSell],["Momentum",mom<-.15],
    ["Structure",last.low<Math.min(...cs.slice(-8,-3).map(c=>c.low))]
  ];

  const bc=buy.filter(x=>x[1]).length, sc=sell.filter(x=>x[1]).length;
  const raw=bc===sc?"WAIT":bc>sc?"BUY":"SELL";
  const score=clamp(Math.round(Math.max(bc,sc)*10 + (raw==="BUY"&&breakUp?8:0) + (raw==="SELL"&&breakDn?8:0) + (raw==="BUY"&&sweepDn?7:0) + (raw==="SELL"&&sweepUp?7:0)),0,100);
  const fake=fakeBuy||fakeSell;
  const actionable=raw!=="WAIT" && score>=65 && !fake;
  const signal=actionable?raw:"WAIT";
  const atrSafe=Math.max(atr,1e-9);
  const swingLow=Math.min(...cs.slice(-8).map(c=>c.low)), swingHigh=Math.max(...cs.slice(-8).map(c=>c.high));
  let stop=null,target=null;
  if(actionable&&raw==="BUY"){const risk=Math.max(last.close-Math.min(swingLow,last.close-atrSafe*1.25),atrSafe*.7);stop=last.close-risk;target=last.close+risk*2;}
  if(actionable&&raw==="SELL"){const risk=Math.max(Math.max(swingHigh,last.close+atrSafe*1.25)-last.close,atrSafe*.7);stop=last.close+risk;target=last.close-risk*2;}
  const setup=retestBuy||retestSell?"RETEST":sweepDn||sweepUp?"LIQUIDITY SWEEP":breakUp||breakDn?"BREAKOUT":contBuy||contSell?"CONTINUATION":rejectBuy||rejectSell?"REJECTION":near?"PULLBACK":fake?"FAKE RETEST":"STRUCTURE WATCH";
  const confidence=clamp(Math.round(50+Math.abs(bc-sc)*6+Math.min(score,35)*.45),50,92);

  return {
    signal,bias:bullish?"BULLISH":bearish?"BEARISH":"NEUTRAL",score,confidence,setup,
    structure:bullish?"BULLISH STRUCTURE":bearish?"BEARISH STRUCTURE":"RANGE / TRANSITION",
    liquidity:sweepDn?"SELL-SIDE SWEPT":sweepUp?"BUY-SIDE SWEPT":"NO CLEAR SWEEP",
    momentum:mom>.35?"STRONG BULLISH":mom<-.35?"STRONG BEARISH":mom>.1?"BULLISH":mom<-.1?"BEARISH":"NEUTRAL",
    reason:actionable?`${setup} confirmed with ${Math.max(bc,sc)}/9 aligned conditions.`:fake?"Failed retest detected. Wait for fresh structure.":`Waiting for stronger confirmation (${score}/100).`,
    confirmations:(raw==="BUY"?buy:sell).map(([name,ok])=>({name,ok})),
    entry:actionable?Number(last.close.toFixed(5)):null,
    stop:actionable?Number(stop.toFixed(5)):null,
    target:actionable?Number(target.toFixed(5)):null,
    support:Number(Math.min(oldLo,lo).toFixed(5)),
    resistance:Number(Math.max(oldHi,hi).toFixed(5)),
    ema20:Number(e20.toFixed(5)),ema50:Number(e50.toFixed(5)),atr:Number(atr.toFixed(5)),rr:actionable?2:null
  };
}

function Chart({candles,analysis}) {
  const el=useRef(null);
  useEffect(()=>{
    if(!el.current||!candles.length) return;
    const chart=createChart(el.current,{
      autoSize:true,
      layout:{background:{color:"#03111d"},textColor:"#8faab8"},
      grid:{vertLines:{color:"rgba(26,67,86,.28)"},horzLines:{color:"rgba(26,67,86,.28)"}},
      rightPriceScale:{borderColor:"#18445a"},
      timeScale:{borderColor:"#18445a",timeVisible:true},
      crosshair:{mode:1},
    });
    const series=chart.addSeries(CandlestickSeries,{
      upColor:"#18d6a1",downColor:"#ef607d",
      borderUpColor:"#18d6a1",borderDownColor:"#ef607d",
      wickUpColor:"#18d6a1",wickDownColor:"#ef607d"
    });
    series.setData(candles.map(c=>({time:c.time,open:c.open,high:c.high,low:c.low,close:c.close})));

    const levels=[
      ["Support",analysis.support,"#27b9e7"],
      ["Resistance",analysis.resistance,"#f39b62"],
      ["EMA20",analysis.ema20,"#8d7cf7"],
      ["EMA50",analysis.ema50,"#c5d2db"],
      ["Entry",analysis.entry,"#20dfb1"],
      ["SL",analysis.stop,"#ff6685"],
      ["TP",analysis.target,"#2bd6a3"]
    ];
    for(const [title,price,color] of levels){
      if(!Number.isFinite(price)) continue;
      const line=chart.addSeries(LineSeries,{
        color,lineWidth:title==="Entry"||title==="SL"||title==="TP"?2:1,
        lineStyle:2,title,lastValueVisible:true,priceLineVisible:true
      });
      line.setData([
        {time:candles[0].time,value:price},
        {time:candles.at(-1).time,value:price}
      ]);
    }

    const markers=chartEvents(candles);
    const markerPrimitive = markers.length ? createSeriesMarkers(series, markers) : null;

    chart.timeScale().fitContent();
    return ()=>{ markerPrimitive?.detach?.(); chart.remove(); };
  },[candles,analysis]);
  return <div ref={el} className="mt5Chart"/>;
}

export default function MT5AnalysisDesk(){
  const {
    markets=[],
    marketTicks={},
    candleHistory={},
    status,
    connected,
    symbol,
    changeSymbol,
    loadingMarket,
  }=useDerivTicks({multiMarket:true});

  const supported=useMemo(
    ()=>WANTED.map(v=>markets.find(m=>matches(m,v))).filter(Boolean),
    [markets]
  );
  const [selected,setSelected]=useState("");
  const [tf,setTf]=useState("5m");

  useEffect(()=>{
    if(!selected&&supported[0]) setSelected(keyOf(supported[0]));
  },[selected,supported]);

  useEffect(()=>{
    if(!selected||!connected||selected===symbol) return;
    void changeSymbol(selected).catch(()=>{});
  },[selected,connected,symbol,changeSymbol]);

  const selectedMarket=supported.find(m=>keyOf(m)===selected)||supported[0];
  const selectedKey=keyOf(selectedMarket);
  const tickRows=selectedMarket?(marketTicks[selectedKey]||[]):[];

  const candlesByTf=useMemo(()=>{
    const out={};
    for(const [label,seconds] of Object.entries(TF)){
      const historical=normalizeCandles(candleHistory[seconds]);
      out[label]=historical.length>=24
        ? historical
        : candlesFromTicks(tickRows,seconds);
    }
    return out;
  },[candleHistory,tickRows]);

  const cs=candlesByTf[tf]||[];
  const analyses=useMemo(()=>{
    const out={};
    for(const m of supported){
      const k=keyOf(m);
      out[k]=analyze(
        k===selectedKey
          ? (candlesByTf[tf]||[])
          : candlesFromTicks(marketTicks[k]||[],TF[tf])
      );
    }
    return out;
  },[supported,selectedKey,candlesByTf,marketTicks,tf]);

  const a=selectedMarket
    ? analyses[selectedKey]||analyze(cs)
    : analyze(cs);
  const cls=a.signal==="BUY"?"buy":a.signal==="SELL"?"sell":"wait";

  const mtf=Object.entries(TF).map(([label,seconds])=>{
    const data=selectedMarket && label
      ? (label===tf
        ? cs
        : normalizeCandles(candleHistory[seconds]).length>=24
          ? normalizeCandles(candleHistory[seconds])
          : candlesFromTicks(tickRows,seconds))
      : [];
    return {label,data,analysis:analyze(data)};
  });

  return <div className="mt5Desk">
    <div className="mt5Topbar">
      <div>
        <i className="mt5LiveDot"/>
        {connected?"LIVE DERIV FEED":"CONNECTING"}
        <small>{loadingMarket?"LOADING CANDLES":status||"DISCONNECTED"}</small>
      </div>
      <div className="mt5Timeframes">
        {Object.keys(TF).map(x=>
          <button key={x} type="button" className={tf===x?"active":""} onClick={()=>setTf(x)}>
            {x}
          </button>
        )}
      </div>
    </div>

    <div className="mt5Grid">
      <aside className="mt5Side">
        <div className="mt5Watchlist">
          <div className="mt5PanelTitle">MARKET SCANNER</div>
          {WANTED.map(v=>{
            const m=supported.find(x=>matches(x,v));
            const k=m&&keyOf(m);
            const x=k&&analyses[k];
            return <button key={v} type="button"
              className={`mt5WatchRow ${k===selectedKey?"active":""}`}
              onClick={()=>m&&setSelected(k)}>
              <b>V{v}</b>
              <span>{x?.bias||"WAITING"}</span>
              <strong className={x?.signal?.toLowerCase()}>{x?.signal||"WAIT"}</strong>
            </button>;
          })}
        </div>

        <div className="mt5Panel mt5MtfPanel">
          <div className="mt5PanelTitle">ALL TIMEFRAME ANALYSIS</div>
          {mtf.map(({label,analysis:z})=>
            <button key={label} type="button"
              className={`mt5MiniRow ${tf===label?"active":""}`}
              onClick={()=>setTf(label)}>
              <b>{label}</b>
              <span>{z.setup}</span>
              <strong className={z.signal.toLowerCase()}>{z.signal}</strong>
            </button>
          )}
        </div>

        <div className="mt5Panel mt5Checklist">
          <div className="mt5PanelTitle">STRUCTURE CHECK</div>
          {(a.confirmations||[]).map(x=>
            <div key={x.name}><i className={x.ok?"on":""}>{x.ok?"✓":"·"}</i><span>{x.name}</span><b>{x.ok?"OK":"WAIT"}</b></div>
          )}
        </div>
      </aside>

      <main className="mt5Center">
        <div className="mt5ChartHead">
          <div><span>LIVE PRICE ACTION · {tf}</span><h2>{labelOf(selectedMarket)}</h2></div>
          <div className="mt5ChartMeta"><b>{cs.at(-1)?.close??"—"}</b><small>{cs.length} candles</small></div>
        </div>
        <Chart candles={cs} analysis={a}/>
        <div className="mt5SetupStrip">
          <span>SETUP</span><b>{a.setup}</b>
          <span>STRUCTURE</span><b>{a.structure}</b>
          <span>LIQUIDITY</span><b>{a.liquidity}</b>
          <span>MOMENTUM</span><b>{a.momentum}</b>
          <span>TRADE PLAN</span><b>{a.signal==="WAIT"?"WAIT":"READY"}</b>
        </div>
      </main>

      <aside className="mt5Right">
        <section className={`mt5SignalCard ${cls}`}>
          <div className="mt5SignalTop"><span>MARKET DECISION</span><b>{a.confidence?a.confidence+"%":"—"}</b></div>
          <div className="mt5SignalWord">{a.signal}</div>
          <p>{a.reason}</p>
          <div className="mt5Levels">
            <div><span>Entry</span><b>{a.entry??"—"}</b></div>
            <div><span>Stop loss</span><b>{a.stop??"—"}</b></div>
            <div><span>Take profit</span><b>{a.target??"—"}</b></div>
            <div><span>Risk / reward</span><b>{a.rr?"1:"+a.rr:"—"}</b></div>
          </div>
          <div className="mt5ConfirmationList">
            {(a.confirmations||[]).map(x=>
              <div key={x.name}><i className={x.ok?"on":""}>{x.ok?"✓":"·"}</i><span>{x.name}</span><b>{x.ok?"CONFIRMED":"WAIT"}</b></div>
            )}
          </div>
          <button type="button" className="mt5CopyPlan"
            onClick={()=>navigator.clipboard?.writeText(`${a.signal} ${labelOf(selectedMarket)} ${tf} Entry ${a.entry} SL ${a.stop} TP ${a.target}`)}>
            COPY MT5 TRADE PLAN
          </button>
        </section>

        <section className="mt5Panel">
          <div className="mt5PanelTitle">KEY LEVELS</div>
          {["support","resistance","ema20","ema50","atr"].map(k=>
            <div className="mt5LevelRow" key={k}>
              <span>{k==="ema20"?"EMA 20":k==="ema50"?"EMA 50":k.toUpperCase()}</span>
              <b>{a[k]??"—"}</b>
            </div>
          )}
        </section>

        <section className="mt5Panel mt5TradeMap">
          <div className="mt5PanelTitle">SETUP MAP</div>
          <div><span>BREAKOUT</span><b>{a.setup==="BREAKOUT"?"CONFIRMED":"WAIT"}</b></div>
          <div><span>RETEST</span><b>{a.setup==="RETEST"?"CONFIRMED":"WAIT"}</b></div>
          <div><span>LIQUIDITY</span><b>{a.liquidity}</b></div>
          <div><span>REJECTION</span><b>{a.setup==="REJECTION"?"CONFIRMED":"WAIT"}</b></div>
          <div><span>CONTINUATION</span><b>{a.setup==="CONTINUATION"?"CONFIRMED":"WAIT"}</b></div>
          <div><span>FAKE / FAILED RETEST</span><b>{a.setup==="FAKE RETEST"?"DETECTED":"CLEAR"}</b></div>
        </section>

        <section className="mt5Panel mt5Safety">
          <div className="mt5PanelTitle">MANUAL EXECUTION</div>
          <p>This desk does not place trades. Use the analysis plan as a manual reference, then execute yourself in MT5.</p>
        </section>
      </aside>
    </div>
  </div>;
}

