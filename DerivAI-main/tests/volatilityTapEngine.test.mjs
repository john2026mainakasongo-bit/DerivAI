import test from 'node:test';import assert from 'node:assert/strict';
import {TAP_VERSION,SHARP_POLICY,tapCandidate,addTap,stepTap,tapStats,localModel} from '../src/utils/volatilityTapEngine.js';
const now=1700000000000;
const plan=(side='BUY')=>({id:'x'+side,engine:TAP_VERSION,policy:SHARP_POLICY,market:'R_10',tf:'5m',seconds:300,side,setup:'RETEST',time:1699999800,detectedAt:now,lastEpoch:now/1000,zoneLow:99,zoneHigh:101,atr:5,entry:100,stop:side==='BUY'?95:105,tp1:side==='BUY'?105:95,tp2:side==='BUY'?110:90,tp3:side==='BUY'?115:85,status:'Awaiting tap',entered:false,expiresAt:now/1000+3600,features:[1,.5,.5,.5,1],events:[]});
test('both sides require a future observed tap then rejection before confirming',()=>{
 for(const side of ['BUY','SELL']){let r=plan(side);r=stepTap(r,{quote:side==='BUY'?102:98,epoch:now/1000+1},null);assert.equal(r.entered,false);
 r=stepTap(r,{quote:100,epoch:now/1000+2},null);assert.equal(r.status,'Tap observed');
 const candle={time:now/1000-290,open:100,high:103,low:97,close:side==='BUY'?102:98};
 r=stepTap(r,{quote:candle.close,epoch:now/1000+10},candle);assert.equal(r.entered,true);assert.equal(r.status,'Entry confirmed');assert.equal(r.entry,candle.close);
 const entry=r.entry;r=stepTap(r,{quote:r.tp2,epoch:now/1000+11},null);assert.equal(r.resultR,2);assert.equal(r.entry,entry);assert.equal(stepTap(r,{quote:r.stop,epoch:now/1000+12},null),r);
 }
});
test('no chasing an extended price after rejection; invalidation and expiry remain non-trades',()=>{
 let r=stepTap(plan(),{quote:100,epoch:now/1000+1},null);
 r=stepTap(r,{quote:108,epoch:now/1000+10},{time:now/1000-290,open:100,high:103,low:99,close:102});assert.equal(r.entered,false);
 const invalid=stepTap(plan(),{quote:94,epoch:now/1000+1},null);assert.equal(invalid.status,'Invalidated');assert.equal(invalid.resultR,undefined);
 const expired=stepTap(plan(),{quote:102,epoch:now/1000+3601},null);assert.equal(expired.status,'Expired');
});
test('gaps excluded, losses retained, and legacy outcomes excluded from research stats',()=>{
 const p=plan();const rows=[{...p,entered:true,resultR:2},{...p,id:'loss',entered:true,resultR:-1},{...p,id:'gap',resultR:2,gapUnverified:true},{...p,id:'old',engine:undefined,resultR:2}];
 const stats=tapStats(rows);assert.equal(stats.resolved,2);assert.equal(stats.wins,1);assert.equal(stats.losses,1);assert.equal(stats.expectancy,.5);assert.equal(stats.gaps,1);
});
test('one active plan per market/timeframe and no duplicate anchors',()=>{
 const p=plan();assert.equal(addTap([p],{...p,id:'new'}).length,1);assert.equal(addTap([p],p).length,1);assert.equal(addTap([],p).length,1);
});
test('candidate requires supported volatility market, higher trend and ATR bounded zone',()=>{
 const cs=Array.from({length:80},(_,i)=>({time:i*300,open:100+i*.2,close:100.1+i*.2,low:99.7+i*.2,high:100.5+i*.2}));
 cs[79]={time:79*300,open:115.8,low:115.7,high:117.1,close:117.0};
 const args={market:'R_10',tf:'5m',seconds:300,higherTrend:'BUY',now};
 const p=tapCandidate(cs,args);assert.ok(p);assert.equal(p.side,'BUY');assert.ok(p.zoneLow<p.zoneHigh);assert.ok(p.stop<p.entry);
 assert.equal(tapCandidate(cs,{...args,higherTrend:'SELL'}),null);assert.equal(tapCandidate(cs,{...args,market:'BTCUSD'}),null);
 const mirror=cs.map(c=>({time:c.time,open:300-c.open,close:300-c.close,high:300-c.low,low:300-c.high}));assert.equal(tapCandidate(mirror,{...args,higherTrend:'SELL'}).side,'SELL');
});
test('local ML refuses small datasets and uses chronological purged holdout',()=>{
 assert.equal(localModel([]).state,'Collecting data');
 const rows=Array.from({length:80},(_,i)=>({...plan(),id:String(i),detectedAt:i*100000,closedAt:(i*100000+50000)/1000,resultR:i%2?2:-1,features:[i%2,0,0,0,0]}));
 const model=localModel(rows,[1,0,0,0,0]);assert.equal(model.train,56);assert.equal(model.test,24);assert.ok(model.brier<model.baseline);assert.ok(model.estimate>.5);
 const gaps=rows.map(r=>({...r,gapUnverified:true}));assert.equal(localModel(gaps).samples,0);
});
test('sharp rejects wide rejection stops on both sides and keeps no false entry',()=>{
 for(const side of ['BUY','SELL']){
  let r=stepTap(plan(side),{quote:100,epoch:now/1000+1},null);
  const close=side==='BUY'?104:96;
  r=stepTap(r,{quote:close,epoch:now/1000+10},{time:now/1000-290,open:100,high:106,low:94,close});
  assert.equal(r.entered,false);assert.equal(r.status,'Invalidated');assert.match(r.reason,/stop distance/);
 }
});
test('sharp fixes rejection stop once and preserves original planned levels for audit',()=>{
 let r=stepTap(plan(),{quote:100,epoch:now/1000+1},null);
 r=stepTap(r,{quote:102,epoch:now/1000+10},{time:now/1000-290,open:100,high:103,low:99,close:102});
 assert.equal(r.entered,true);assert.equal(r.stop,98.25);assert.equal(r.plannedStop,95);assert.equal(r.plannedEntry,100);
 const fixed=[r.entry,r.stop,r.tp1,r.tp2,r.tp3];
 r=stepTap(r,{quote:103,epoch:now/1000+11},null);
 assert.deepEqual([r.entry,r.stop,r.tp1,r.tp2,r.tp3],fixed);
 assert.equal(r.events.at(-1).stop,98.25);
});
test('sharp never confirms after an offline gap',()=>{
 let r=stepTap(plan(),{quote:100,epoch:now/1000+1},null);
 r=stepTap(r,{quote:102,epoch:now/1000+40},{time:now/1000-260,open:100,high:103,low:99,close:102});
 assert.equal(r.entered,false);assert.equal(r.status,'Invalidated');assert.equal(r.gapUnverified,true);
});
