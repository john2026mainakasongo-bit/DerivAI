import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Scanner,updateCandle} from '../server/scanner.js';
import {Store} from '../server/store.js';
const record=(market,side)=>({id:`server:${market}`,source:'server',engine:'tap-v4',policy:'sharp-v6',market,tf:'1m',seconds:60,side,status:'Entry confirmed',entered:true,time:60,detectedAt:60000,lastEpoch:100,entry:100,stop:side==='BUY'?99:101,tp1:side==='BUY'?101:99,tp2:side==='BUY'?102:98,tp3:side==='BUY'?103:97,events:[]});
test('server monitors BUY and SELL on two markets without a selected chart or browser',()=>{
 const s=new Scanner([record('R_10','BUY'),record('R_25','SELL')]);
 assert.equal(s.tick('R_10',{epoch:101,quote:98},101000),true);
 assert.equal(s.signals[0].status,'SL touched');assert.equal(s.signals[1].status,'Entry confirmed');
 s.tick('R_25',{epoch:102,quote:97},102000);
 assert.equal(s.signals[1].status,'TP2 touched');assert.equal(s.signals[0].entry,100);
 assert.equal(s.signals[0].events.at(-1).epoch,101);
});
test('restart restores immutable outcomes; gaps stay flagged',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scanner-test-'));
 try{
  const store=new Store(dir),s=new Scanner([record('R_10','BUY')]);store.save(s.signals);
  const restored=new Scanner(store.load());restored.tick('R_10',{epoch:150,quote:98},150000);store.save(restored.signals);
  assert.equal(store.load()[0].status,'SL touched');assert.equal(store.load()[0].gapUnverified,true);
  restored.tick('R_10',{epoch:151,quote:103},151000);assert.equal(restored.signals[0].resultR,-1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('stale, invalid and duplicate ticks cannot invent outcomes',()=>{
 const s=new Scanner([record('R_10','BUY')]);
 s.tick('R_10',{epoch:101,quote:98},200000);assert.equal(s.signals[0].status,'Entry confirmed');
 s.tick('R_10',{epoch:102,quote:NaN},102000);assert.equal(s.signals[0].status,'Entry confirmed');
 s.tick('R_10',{epoch:102,quote:100},102000);s.tick('R_10',{epoch:102,quote:98},102000);assert.equal(s.signals[0].status,'Entry confirmed');
});
test('OHLC updates retain extrema and ignore backwards buckets',()=>{
 let rows=updateCandle([],{epoch:100,quote:10},60);rows=updateCandle(rows,{epoch:101,quote:12},60);rows=updateCandle(rows,{epoch:102,quote:9},60);
 assert.deepEqual(rows,[{time:60,open:10,high:12,low:9,close:9}]);assert.equal(updateCandle(rows,{epoch:10,quote:99},60),rows);
});
test('corrupt persistence stops startup instead of discarding history',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scanner-test-'));
 try{fs.writeFileSync(path.join(dir,'scanner.json'),'broken');assert.throws(()=>new Store(dir).load());}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
