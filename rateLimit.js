(function(global){
 const API_LIMIT=8,API_WINDOW_MS=60000,API_TIMES_KEY="apiRequestTimes",RESERVE_MESSAGE_TYPE="bearfish:reserve-rest-slot";
 function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
 function pruneTimes(times,now,windowMs){return(Array.isArray(times)?times:[]).filter(t=>Number.isFinite(t)&&now-t<windowMs)}
 let localQueue=Promise.resolve();
 async function reserveRestSlot(storage,{limit=API_LIMIT,windowMs=API_WINDOW_MS,key=API_TIMES_KEY,onWait}={}){
  const task=localQueue.then(async()=>{
   while(true){
    const now=Date.now(),d=await storage.get([key]),times=pruneTimes(d[key],now,windowMs);
    if(times.length<limit){times.push(now);await storage.set({[key]:times});return}
    const waitMs=Math.max(250,windowMs-(now-times[0])+100);
    if(typeof onWait==="function")onWait({waitMs});
    await sleep(waitMs)
   }
  });
  localQueue=task.catch(()=>{});
  return task
 }
 async function estimateWait(storage,{limit=API_LIMIT,windowMs=API_WINDOW_MS,key=API_TIMES_KEY}={}){
  const now=Date.now(),d=await storage.get([key]),times=pruneTimes(d[key],now,windowMs);
  if(times.length<limit)return 0;
  return Math.max(250,windowMs-(now-times[0])+100)
 }
 async function reserveViaRuntime(runtime,{storage,onWait}={}){
  if(storage&&typeof onWait==="function"){
   const waitMs=await estimateWait(storage);
   if(waitMs>0)onWait({waitMs})
  }
  await runtime.sendMessage({type:RESERVE_MESSAGE_TYPE})
 }
 async function limitedJson(url,{runtime,storage,onWait,fetchImpl=fetch}={}){
  if(runtime?.sendMessage)await reserveViaRuntime(runtime,{storage,onWait});
  else if(storage)await reserveRestSlot(storage,{onWait});
  else throw new Error("Storage or runtime is required for BearFish rate limiting.");
  const r=await fetchImpl(url),d=await r.json();
  return{r,d}
 }
 const api={API_LIMIT,API_WINDOW_MS,API_TIMES_KEY,RESERVE_MESSAGE_TYPE,reserveRestSlot,limitedJson,pruneTimes};
 if(typeof module!=="undefined"&&module.exports)module.exports=api;
 global.BearFishRateLimit=api;
 })(typeof globalThis!=="undefined"?globalThis:this);
