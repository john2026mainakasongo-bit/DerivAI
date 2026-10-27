import {useEffect,useState} from 'react';
export default function useServerScanner(onSignals){
 const [state,setState]=useState({mode:'checking',status:'Checking background server',markets:[]});
 useEffect(()=>{
  let stopped=false,timer,controller,seen=false;
  const poll=async()=>{
   controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8000);
   try{
    const response=await fetch('/api/scanner/signals',{signal:controller.signal,cache:'no-store'});
    if(!response.ok)throw Error('Server unavailable');
    const data=await response.json();
    if(data.mode!=='server'||!Array.isArray(data.signals))throw Error('Scanner not installed');
    if(stopped)return;seen=true;setState({...data,signals:undefined,mode:'server',receivedAt:Date.now()});onSignals(data.signals);
   }catch{
    if(!stopped)setState(previous=>({...previous,mode:seen?'server':'local',status:seen?'Server unreachable · saved history':'Browser only · server not deployed',receivedAt:0}));
   }finally{clearTimeout(timeout);if(!stopped)timer=setTimeout(poll,5000);}
  };poll();return()=>{stopped=true;clearTimeout(timer);controller?.abort();};
 },[onSignals]);
 return state;
}
