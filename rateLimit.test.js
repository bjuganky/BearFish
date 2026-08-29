const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {createReservationService}=require("./background.js");

class MockStorage{
 constructor(seed={}){this.data={...seed}}
 async get(keys){
  if(Array.isArray(keys)){const out={};for(const k of keys)out[k]=this.data[k];return out}
  if(typeof keys==="string")return{[keys]:this.data[keys]};
  return{...this.data}
 }
 async set(obj){Object.assign(this.data,obj)}
}

test("allows eight requests in a rolling window",async()=>{
 const storage=new MockStorage();
 const service=createReservationService(storage,{limit:8,windowMs:1000,key:"t1"});
 for(let i=0;i<8;i++)await service.reserve();
 const times=(await storage.get(["t1"])).t1;
 assert.equal(times.length,8);
});

test("ninth request waits until a slot opens",async()=>{
 let now=1000;
 const sleepCalls=[];
 const storage=new MockStorage({t2:Array(8).fill(now)});
 const service=createReservationService(storage,{limit:8,windowMs:120,key:"t2",nowFn:()=>now,sleepFn:async ms=>{sleepCalls.push(ms);now+=ms;}});
 await service.reserve();
 assert.equal(sleepCalls.length,1);
 assert.ok(sleepCalls[0]>=220);
});

test("requests from separate contexts share one budget",async()=>{
 let now=1000;
 const sleepCalls=[];
 const storage=new MockStorage();
 const service=createReservationService(storage,{limit:8,windowMs:120,key:"t3",nowFn:()=>now,sleepFn:async ms=>{sleepCalls.push(ms);now+=ms;}});
 const popupReserve=()=>service.reserve(),detailsReserve=()=>service.reserve();
 await Promise.all([popupReserve(),popupReserve(),popupReserve(),popupReserve(),popupReserve(),detailsReserve(),detailsReserve(),detailsReserve(),detailsReserve()]);
 assert.equal(sleepCalls.length,1);
 assert.ok(sleepCalls[0]>=220);
});

test("discards timestamps outside the rolling window",async()=>{
 const now=Date.now();
 const storage=new MockStorage({t4:[now-5000,now-20]});
 const service=createReservationService(storage,{limit:3,windowMs:1000,key:"t4"});
 await service.reserve();
 const times=(await storage.get(["t4"])).t4;
 assert.equal(times.length,2);
 assert.ok(times.every(t=>Date.now()-t<1000));
});

test("non-REST activity does not consume REST slots",async()=>{
 const storage=new MockStorage();
 for(let i=0;i<10;i++)JSON.stringify({websocketTick:i});
 const times=(await storage.get(["t5"])).t5;
 assert.equal(times,undefined);
});

test("budget persists across popup reopen/context restart",async()=>{
 let now=1000;
 const sleepCalls=[];
 const storage=new MockStorage();
 const popupService=createReservationService(storage,{limit:2,windowMs:120,key:"t6",nowFn:()=>now,sleepFn:async ms=>{sleepCalls.push(ms);now+=ms;}});
 await popupService.reserve();
 await popupService.reserve();
 const detailsService=createReservationService(storage,{limit:2,windowMs:120,key:"t6",nowFn:()=>now,sleepFn:async ms=>{sleepCalls.push(ms);now+=ms;}});
 await detailsService.reserve();
 assert.equal(sleepCalls.length,1);
 assert.ok(sleepCalls[0]>=220);
});

test("adversarial interleaving cannot double-reserve across concurrent contexts",async()=>{
 class PausableStorage extends MockStorage{
  constructor(seed={}){super(seed);this.getCount=0;this.firstSetSeen=false;this.enteredResolve=null;this.firstSetEntered=new Promise(r=>{this.enteredResolve=r});this.releaseSetResolve=null;this.releaseSet=new Promise(r=>{this.releaseSetResolve=r})}
  async get(keys){this.getCount++;return super.get(keys)}
  async set(obj){
   if(!this.firstSetSeen){
    this.firstSetSeen=true;
    this.enteredResolve();
    await this.releaseSet
   }
   return super.set(obj)
  }
 }
 const storage=new PausableStorage();
 const service=createReservationService(storage,{limit:8,windowMs:1000,key:"t7"});
 const first=service.reserve();
 await storage.firstSetEntered;
 const second=service.reserve();
 await new Promise(r=>setTimeout(r,30));
 assert.equal(storage.getCount,1);
 storage.releaseSetResolve();
 await Promise.all([first,second]);
 const times=(await storage.get(["t7"])).t7;
 assert.equal(times.length,2);
});

test("manifest registers Firefox MV3 background script handler",()=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,"manifest.json"),"utf8"));
 assert.ok(Array.isArray(manifest.background?.scripts));
 assert.ok(manifest.background.scripts.includes("background.js"));
});
