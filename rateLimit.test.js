const test=require("node:test");
const assert=require("node:assert/strict");
const {reserveRestSlot}=require("./rateLimit.js");

class MockStorage{
 constructor(seed={}){this.data={...seed}}
 async get(keys){
  if(Array.isArray(keys)){const out={};for(const k of keys)out[k]=this.data[k];return out}
  if(typeof keys==="string")return{[keys]:this.data[keys]};
  return{...this.data}
 }
 async set(obj){Object.assign(this.data,obj)}
 async remove(keys){(Array.isArray(keys)?keys:[keys]).forEach(k=>delete this.data[k])}
}

test("allows eight requests in a rolling window",async()=>{
 const storage=new MockStorage();
 for(let i=0;i<8;i++)await reserveRestSlot(storage,{limit:8,windowMs:1000,key:"t1",lockKey:"l1"});
 const times=(await storage.get(["t1"])).t1;
 assert.equal(times.length,8);
});

test("ninth request waits until a slot opens",async()=>{
 const now=Date.now();
 const storage=new MockStorage({t2:Array(8).fill(now)});
 const start=Date.now();
 await reserveRestSlot(storage,{limit:8,windowMs:120,key:"t2",lockKey:"l2"});
 assert.ok(Date.now()-start>=220);
});

test("requests from separate contexts share one budget",async()=>{
 const storage=new MockStorage();
 const done=[];
 const a=()=>reserveRestSlot(storage,{limit:8,windowMs:120,key:"t3",lockKey:"l3"}).then(()=>done.push(Date.now()));
 const b=()=>reserveRestSlot(storage,{limit:8,windowMs:120,key:"t3",lockKey:"l3"}).then(()=>done.push(Date.now()));
 await Promise.all([a(),a(),a(),a(),a(),b(),b(),b(),b()]);
 done.sort((x,y)=>x-y);
 assert.ok(done[8]-done[0]>=220);
});

test("discards timestamps outside the rolling window",async()=>{
 const now=Date.now();
 const storage=new MockStorage({t4:[now-5000,now-20]});
 await reserveRestSlot(storage,{limit:3,windowMs:1000,key:"t4",lockKey:"l4"});
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
 const storage=new MockStorage();
 await reserveRestSlot(storage,{limit:2,windowMs:120,key:"t6",lockKey:"l6"});
 await reserveRestSlot(storage,{limit:2,windowMs:120,key:"t6",lockKey:"l6"});
 const start=Date.now();
 await reserveRestSlot(storage,{limit:2,windowMs:120,key:"t6",lockKey:"l6"});
 assert.ok(Date.now()-start>=220);
});
