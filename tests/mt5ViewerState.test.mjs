import test from 'node:test';
import assert from 'node:assert/strict';
import {captureSignal,advanceSignals,freshTick,readStored,writeStored} from '../src/utils/mt5ViewerState.js';
const now=1700000000000;
const ctx={market:'R_10',tf:'5m',time:1699999800,now};
const buy={signal:'BUY',entry:100,stop:95,tp1:105,tp2:110,tp3:115,setup:'RETEST'};
const sell={signal:'SELL',entry:100,stop:105,tp1:95,tp2:90,tp3:85,setup:'RETEST'};
test('BUY and SELL preserve exact levels and deduplicate per candle',()=>{
 for(const a of [buy,sell]){const rows=captureSignal([],a,ctx);assert.equal(rows.length,1);assert.equal(captureSignal(rows,a,ctx),rows);assert.equal(rows[0].stop,a.stop);}
 assert.equal(captureSignal([],{...buy,stop:110},ctx).length,0);
 assert.equal(captureSignal([],{...buy,signal:'WAIT'},ctx).length,0);
});
test('observed entry, TP and SL update without moving original prices',()=>{
 for(const a of [buy,sell]){
 let rows=captureSignal([],a,ctx);
 rows=advanceSignals(rows,'R_10',{quote:100,epoch:now/1000+1},true);
 assert.equal(rows[0].status,'Entry touched');
 rows=advanceSignals(rows,'R_10',{quote:a.tp1,epoch:now/1000+2},true);
 assert.equal(rows[0].status,'TP1 touched');assert.equal(rows[0].entry,100);
 rows=advanceSignals(rows,'R_10',{quote:a.stop,epoch:now/1000+3},true);
 assert.equal(rows[0].status,'SL touched');
 }
});
test('cached, disconnected, cross-market and old ticks never advance plans',()=>{
 const rows=captureSignal([],buy,ctx);
 assert.equal(advanceSignals(rows,'R_10',{quote:115,epoch:now/1000+1},false),rows);
 assert.equal(advanceSignals(rows,'R_25',{quote:115,epoch:now/1000+1},true),rows);
 assert.equal(advanceSignals(rows,'R_10',{quote:115,epoch:now/1000-1},true),rows);
 assert.equal(freshTick(true,{quote:100,epoch:now/1000-40},now),false);
 assert.equal(freshTick(false,{quote:100,epoch:now/1000},now),false);
 assert.equal(freshTick(true,{quote:100,epoch:now/1000-1},now),true);
});
test('offline gap is flagged; recorded signal survives JSON reload',()=>{
 const rows=JSON.parse(JSON.stringify(captureSignal([],sell,ctx)));
 const next=advanceSignals(rows,'R_10',{quote:100,epoch:now/1000+90},true);
 assert.equal(next[0].gapUnverified,true);assert.equal(next[0].stop,105);
});
test('storage denied and malformed JSON fall back without crashing',()=>{
 globalThis.localStorage={getItem(){return '{bad';},setItem(){throw Error('blocked');}};
 assert.deepEqual(readStored('x',[]),[]);assert.equal(writeStored('x',[]),false);
});

test('fit trade includes all BUY/SELL levels beyond the candle range',async()=>{
 const {fitPlanRange}=await import('../src/utils/mt5ViewerState.js');
 for(const plan of [buy,sell]){
 const range=fitPlanRange({priceRange:{minValue:99,maxValue:101}},plan).priceRange;
 for(const value of [plan.entry,plan.stop,plan.tp1,plan.tp2,plan.tp3]) assert.ok(value>range.minValue && value<range.maxValue);
 }
 assert.equal(fitPlanRange(null,buy),null);
 const base={priceRange:{minValue:99,maxValue:101}};
 assert.equal(fitPlanRange(base,null),base);
});
