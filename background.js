(function(global){
 const API_LIMIT=8,API_WINDOW_MS=60000,API_TIMES_KEY="apiRequestTimes",RESERVE_MESSAGE_TYPE="bearfish:reserve-rest-slot";
 function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
 function pruneTimes(times,now,windowMs){return(Array.isArray(times)?times:[]).filter(t=>Number.isFinite(t)&&now-t<windowMs)}
 function createReservationService(storage,{limit=API_LIMIT,windowMs=API_WINDOW_MS,key=API_TIMES_KEY,nowFn=()=>Date.now(),sleepFn=sleep}={}){
  let queue=Promise.resolve();
  function reserve({onWait}={}){
   const task=queue.then(async()=>{
    while(true){
     const now=nowFn(),d=await storage.get([key]),times=pruneTimes(d[key],now,windowMs);
     if(times.length<limit){times.push(now);await storage.set({[key]:times});return}
     const waitMs=Math.max(250,windowMs-(now-times[0])+100);
     if(typeof onWait==="function")onWait({waitMs});
     await sleepFn(waitMs)
    }
   });
   queue=task.catch(()=>{});
   return task
  }
  return{reserve}
 }
 function attachRuntimeListener(runtime,storage,opts){
  const service=createReservationService(storage,opts);
  runtime.onMessage.addListener(msg=>{
   if(!msg||msg.type!==RESERVE_MESSAGE_TYPE)return;
   return service.reserve().then(()=>({ok:true}))
  });
  return service
 }
 if(typeof browser!=="undefined"&&browser?.runtime?.onMessage&&browser?.storage?.local){
  attachRuntimeListener(browser.runtime,browser.storage.local)
 }
 if(typeof module!=="undefined"&&module.exports)module.exports={createReservationService,attachRuntimeListener,RESERVE_MESSAGE_TYPE};
 global.BearFishBackgroundRateLimit={createReservationService,attachRuntimeListener,RESERVE_MESSAGE_TYPE};
 })(typeof globalThis!=="undefined"?globalThis:this);
