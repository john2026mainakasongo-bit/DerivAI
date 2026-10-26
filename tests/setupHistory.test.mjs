import test from 'node:test';
import assert from 'node:assert/strict';
import {currentSetup,setupLabel,historyMarkers,mergeHistory} from '../src/utils/setupHistory.js';
import {addTap,SHARP_POLICY} from '../src/utils/volatilityTapEngine.js';
const row={id:'a',market:'R_50',tf:'5m',side:'BUY',policy:SHARP_POLICY,engine:'tap-v4',entry:100,stop:99,tp1:101,tp2:102,tp3:103,time:300,detectedAt:300000,lastEpoch:600,status:'Entry confirmed',entered:true,seconds:300};
test('current setup ignores legacy but retains failed record until next setup',()=>{
 assert.equal(currentSetup([{...row,policy:'old'}]),null);
 const failed={...row,status:'SL touched'};
 assert.equal(setupLabel(currentSetup([failed])),'FAILED');
 assert.equal(currentSetup([{...row,id:'b',entered:false,status:'Awaiting tap'},failed]).id,'b');
 assert.equal(failed.entry,100);
});
test('event markers anchor confirmation and failure to distinct actual candles',()=>{
 const markers=historyMarkers([{...row,status:'SL touched',events:[{type:'Zone created',epoch:310},{type:'Entry confirmed',epoch:620},{type:'SL touched',epoch:930}]}],[{time:300},{time:600},{time:900}],300);
 assert.deepEqual(markers.map(m=>m.time),[300,600,900]);
 assert.match(markers[1].text,/BUY CONFIRMED/);assert.match(markers[2].text,/FAILED/);
});
test('restore preserves existing facts and rejects malformed files',()=>{
 const merged=mergeHistory([row],[{...row,entry:500},{...row,id:'b'}]);
 assert.equal(merged.find(r=>r.id==='a').entry,100);assert.equal(merged.length,2);
 assert.throws(()=>mergeHistory([row],[{id:'bad'}]));
});
test('history beyond 500 retained and legacy pending does not block current policy',()=>{
 const rows=Array.from({length:510},(_,i)=>({...row,id:String(i),status:'SL touched'}));
 const candidate={...row,id:'new',detectedAt:9000000,status:'Awaiting tap'};
 assert.equal(addTap(rows,candidate).length,511);
 assert.equal(addTap([{...row,policy:'old'}],candidate).length,2);
});
