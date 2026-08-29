(function(global){
 const API_LIMIT=8,API_WINDOW_MS=60000,API_TIMES_KEY="apiRequestTimes",API_LOCK_KEY="apiRequestTimesLock",LOCK_TTL_MS=2000;
 function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
 function pruneTimes(times,now,windowMs){return(Array.isArray(times)?times:[]).filter(t=>Number.isFinite(t)&&now-t<windowMs)}
 function lockToken(){return`${Date.now()}_${Math.random().toString(36).slice(2,9)}`}
 async function acquireLock(storage,{lockKey=API_LOCK_KEY,lockTtlMs=LOCK_TTL_MS}={}){
  const owner=lockToken();
  while(true){
   const now=Date.now(),d=await storage.get([lockKey]),cur=d[lockKey];
   if(!cur||!Number.isFinite(cur.expiresAt)||cur.expiresAt<=now){
    await storage.set({[lockKey]:{owner,expiresAt:now+lockTtlMs}});
    const chk=(await storage.get([lockKey]))[lockKey];
    if(chk&&chk.owner===owner)break
   }
   await sleep(60)
  }
  return async()=>{const d=await storage.get([lockKey]);if(d[lockKey]?.owner===owner)await storage.remove(lockKey)}
 }
 async function reserveRestSlot(storage,{limit=API_LIMIT,windowMs=API_WINDOW_MS,key=API_TIMES_KEY,onWait}={}){
  while(true){
   const release=await acquireLock(storage);
   let waitMs=0;
   try{
    const now=Date.now(),d=await storage.get([key]),times=pruneTimes(d[key],now,windowMs);
    if(times.length<limit){times.push(now);await storage.set({[key]:times});return}
    waitMs=Math.max(250,windowMs-(now-times[0])+100)
   }finally{await release()}
   if(typeof onWait==="function")onWait({waitMs});
   await sleep(waitMs)
  }
 }
 async function limitedJson(url,{storage,onWait,fetchImpl=fetch}={}){
  if(!storage)throw new Error("Storage is required for BearFish rate limiting.");
  await reserveRestSlot(storage,{onWait});
  const r=await fetchImpl(url),d=await r.json();
  return{r,d}
 }
 const api={API_LIMIT,API_WINDOW_MS,API_TIMES_KEY,reserveRestSlot,limitedJson,pruneTimes};
 if(typeof module!=="undefined"&&module.exports)module.exports=api;
 global.BearFishRateLimit=api;
 })(typeof globalThis!=="undefined"?globalThis:this);
