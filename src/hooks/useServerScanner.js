import {useEffect,useState} from 'react';

// The MT5 desk and background scanner may be hosted on separate Render services.
// VITE_SCANNER_API_URL can override the default scanner origin at build time.
const scannerOrigin=(import.meta.env.VITE_SCANNER_API_URL || 'https://derivai-scanner.onrender.com').replace(/\/+$/,'');
const sources=[`${scannerOrigin}/api/scanner/signals`, '/api/scanner/signals'];

export default function useServerScanner(onSignals){
 const [state,setState]=useState({mode:'checking',status:'Checking background server',markets:[]});
 useEffect(()=>{
  let stopped=false,timer,controller,seen=false;
  const poll=async()=>{
   controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),10000);
   let lastError='Server unavailable';
   try{
    for(const endpoint of [...new Set(sources)]){
     try{
      const response=await fetch(endpoint,{signal:controller.signal,cache:'no-store'});
      if(!response.ok)throw Error(`HTTP ${response.status}`);
      const data=await response.json();
      if(data.mode!=='server'||!Array.isArray(data.signals))throw Error('Scanner response invalid');
      if(stopped)return;
      seen=true;
      setState({...data,signals:undefined,mode:'server',receivedAt:Date.now()});
      onSignals(data.signals);
      return;
     }catch(error){lastError=error.message;if(controller.signal.aborted)break;}
    }
    if(!stopped)setState(previous=>({...previous,mode:seen?'server':'local',status:seen?'Scanner connection lost · saved history':`Browser only · scanner unreachable (${lastError})`,receivedAt:0}));
   }finally{clearTimeout(timeout);if(!stopped)timer=setTimeout(poll,5000);}
  };
  poll();return()=>{stopped=true;clearTimeout(timer);controller?.abort();};
 },[onSignals]);
 return state;
}
