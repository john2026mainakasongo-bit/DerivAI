import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Scanner,FRAMES} from './scanner.js';
import {Store} from './store.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=process.env.SCANNER_DATA_DIR;
if(!directory)throw Error('Set SCANNER_DATA_DIR to a persistent disk directory before starting');
const store=new Store(directory),scanner=new Scanner(store.load());
let status='Starting',error='',storageError='',socket,retry,stopping=false,sequence=0,lastMessage=Date.now();
const ready=new Set(),failures={},pending=new Map();
let warming=false;
const save=()=>{try{store.save(scanner.signals);storageError='';}catch(e){storageError=e.message;console.error('Scanner storage failure:',e.message);}};
save();if(storageError)throw Error(storageError);
function request(body){
 return new Promise((resolve,reject)=>{
  const req_id=++sequence;
  const timer=setTimeout(()=>{pending.delete(req_id);reject(Error('Feed request timed out'));},20000);
  pending.set(req_id,{resolve,reject,timer});
  try{socket.send(JSON.stringify({...body,req_id}));}catch(e){clearTimeout(timer);pending.delete(req_id);reject(e);}
 });
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function warm(ws){
 if(warming)return;warming=true;
 try{
 const response=await request({active_symbols:'brief'});
 const raw=response.active_symbols || response.data?.active_symbols || [];
 const symbols=raw.map(r=>r.underlying_symbol||r.symbol||r.id).filter(s=>/^R_\d+$|^\d+HZ\d+V$/i.test(s));
 if(!symbols.length)throw Error('No supported volatility symbols returned');
 for(const symbol of symbols){
  if(ws!==socket||ws.readyState!==1)return;
  if(ready.has(symbol))continue;
  try{
   // Serial, paced history requests avoid startup fan-out against the public feed.
   for(const [tf,granularity] of Object.entries(FRAMES)){
    const result=await request({ticks_history:symbol,style:'candles',count:300,end:'latest',granularity});
    const rows=result.candles||result.data?.candles||result.history?.candles||result.history?.ohlc;
    if(!Array.isArray(rows)||rows.length<61)throw Error(`Insufficient ${tf} history`);
    scanner.seed(symbol,tf,rows.map(c=>({time:Number(c.epoch??c.open_time??c.time),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)})));
    await delay(200);
   }
   ready.add(symbol);
   await request({ticks:symbol,subscribe:1});delete failures[symbol];
  }catch(e){ready.delete(symbol);failures[symbol]=e.message;}
 }
 status='Running';error='';
 }finally{warming=false;}
}
function connect(){
 if(stopping)return;
 status='Connecting';ready.clear();
 const ws=socket=new WebSocket(process.env.DERIV_PUBLIC_WS || 'wss://api.derivws.com/trading/v1/options/ws/public');
 lastMessage=Date.now();
 ws.addEventListener('open',()=>{status='Loading market histories';warm(ws).catch(e=>{error=e.message;ws.close();});});
 ws.addEventListener('message',event=>{
  if(ws!==socket)return;lastMessage=Date.now();
  try{
   const msg=JSON.parse(event.data),p=pending.get(msg.req_id);
   if(p){clearTimeout(p.timer);pending.delete(msg.req_id);msg.error?p.reject(Error(msg.error.message)):p.resolve(msg);}
   const t=msg.tick||msg.data?.tick;
   if(t){const symbol=t.symbol||t.underlying_symbol;if(ready.has(symbol)&&!storageError){const changed=scanner.tick(symbol,{epoch:Number(t.epoch),quote:Number(t.quote)});if(changed)save();}}
  }catch(e){error=e.message;}
 });
 ws.addEventListener('error',()=>{error='Feed connection error';ws.close();});
 ws.addEventListener('close',()=>{
  if(ws!==socket)return;status='Reconnecting';ready.clear();
  for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Feed disconnected'));}pending.clear();
  if(!stopping)retry=setTimeout(connect,5000);
 });
}
const checkpoint=setInterval(save,5000);
const reloadFailed=setInterval(()=>{if(socket?.readyState===1&&!warming&&Object.keys(failures).length)warm(socket).catch(e=>{error=e.message;});},60000);
const heartbeat=setInterval(()=>{
 if(socket?.readyState===1){socket.send(JSON.stringify({ping:1}));if(Date.now()-lastMessage>60000)socket.close();}
 else if(Date.now()-lastMessage>60000)socket?.close();
},15000);
const apiStatus=()=>({version:8,mode:'server',status,error,storageError,updatedAt:Date.now(),markets:[...ready].map(symbol=>({symbol,lastTick:scanner.last[symbol]||null,fresh:Date.now()/1000-(scanner.last[symbol]||0)<30})),failures,timeframes:Object.keys(FRAMES).filter(tf=>tf!=='24h')});
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'};
const app=http.createServer((req,res)=>{
 if(req.method!=='GET'){res.writeHead(405);res.end();return;}
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/api/scanner/status'||url.pathname==='/api/scanner/signals'){
  // Public market research only: no account balances, API tokens or browser imports.
  res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
  res.end(JSON.stringify({...apiStatus(),...(url.pathname.endsWith('/signals')?{signals:scanner.signals}: {})}));return;
 }
 if(url.pathname==='/healthz'){res.writeHead(storageError?503:200);res.end(storageError?'Storage unavailable':'OK');return;}
 const dist=path.join(root,'dist');let requested;
 try{requested=path.resolve(dist,'.'+decodeURIComponent(url.pathname));}catch{res.writeHead(400);res.end();return;}
 if(!requested.startsWith(dist+path.sep)&&requested!==dist){res.writeHead(403);res.end();return;}
 if(!fs.existsSync(requested)||!fs.statSync(requested).isFile())requested=path.join(dist,'index.html');
 if(!fs.existsSync(requested)){res.writeHead(503);res.end('Build the frontend first');return;}
 res.writeHead(200,{'Content-Type':mime[path.extname(requested)]||'application/octet-stream','Cache-Control':'no-cache'});fs.createReadStream(requested).pipe(res);
});
app.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('DerivAI server scanner listening'));
if(process.env.SCANNER_TEST_MODE!=='1')connect();
function shutdown(){stopping=true;clearTimeout(retry);clearInterval(checkpoint);clearInterval(heartbeat);clearInterval(reloadFailed);save();socket?.close();app.close(()=>process.exit(storageError?1:0));setTimeout(()=>process.exit(0),3000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
