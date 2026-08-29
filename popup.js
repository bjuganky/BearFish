const MAX_LISTS=5,$=id=>document.getElementById(id);
let lists=[],activeId="",quotes={},apiKey="",theme="slate";
let searchTimer=null,searchSeq=0,searchItems=[],selectedSearchIndex=-1,expandedSymbol=null;
let inlineData={},prefs={},indicatorPresets={};

function makeId(){return"wl_"+Date.now()+"_"+Math.random().toString(36).slice(2,7)}
function defaultState(){const id=makeId();return[{id,name:"Watchlist 1",stocks:[]}]}
function activeList(){return lists.find(x=>x.id===activeId)||lists[0]}
function money(v){const n=Number(v);return Number.isFinite(n)?n.toLocaleString(undefined,{style:"currency",currency:"USD",maximumFractionDigits:2}):"—"}
async function persist(){await browser.storage.local.set({watchlists:lists,activeWatchlistId:activeId,stockPrefs:prefs,theme})}

const API_LIMIT=8,API_WINDOW_MS=60000;
let apiQueue=Promise.resolve();
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
async function reserveApiSlot(){
 while(true){
  const d=await browser.storage.local.get(["apiRequestTimes"]);
  const now=Date.now(),times=(Array.isArray(d.apiRequestTimes)?d.apiRequestTimes:[]).filter(t=>now-t<API_WINDOW_MS);
  if(times.length<API_LIMIT){
   times.push(now);await browser.storage.local.set({apiRequestTimes:times});return
  }
  const wait=Math.max(250,API_WINDOW_MS-(now-times[0])+100);
  const secs=Math.ceil(wait/1000),st=$("status");if(st)st.textContent=`API limit reached — waiting ${secs}s…`;
  await sleep(wait)
 }
}
function limitedJson(url){
 const task=apiQueue.then(async()=>{
  await reserveApiSlot();
  const r=await fetch(url),d=await r.json();
  return{r,d}
 });
 apiQueue=task.catch(()=>{});
 return task
}
function stockPref(sym){
 if(!prefs[sym])prefs[sym]={
  windowValue:1,windowUnit:"months",barInterval:"auto",view:"candle",
  sma:{enabled:false,period:20},ema:{enabled:false,period:20},
  volume:true,rsi:{enabled:false,period:14},
  macd:{enabled:false,fast:12,slow:26,signal:9}
 };
 const p=prefs[sym];
 if(typeof p.sma20==="boolean"||typeof p.sma50==="boolean"){
  p.sma=p.sma||{enabled:!!(p.sma20||p.sma50),period:p.sma50?50:20};
  delete p.sma20;delete p.sma50
 }
 if(typeof p.ema20==="boolean"){p.ema=p.ema||{enabled:p.ema20,period:20};delete p.ema20}
 if(typeof p.rsi==="boolean")p.rsi={enabled:p.rsi,period:14};
 if(typeof p.macd==="boolean")p.macd={enabled:p.macd,fast:12,slow:26,signal:9};
 if(!p.sma)p.sma={enabled:false,period:20};
 if(!p.ema)p.ema={enabled:false,period:20};
 if(!p.rsi||typeof p.rsi!=="object")p.rsi={enabled:false,period:14};
 if(!p.macd||typeof p.macd!=="object")p.macd={enabled:false,fast:12,slow:26,signal:9};
 if(typeof p.volume!=="boolean")p.volume=true;
 return p
}
function migrate(d){
 if(Array.isArray(d.watchlists)&&d.watchlists.length)lists=d.watchlists.slice(0,MAX_LISTS).map((x,i)=>{
  let stocks=Array.isArray(x.stocks)?x.stocks.map(s=>({symbol:String(s.symbol||"").toUpperCase(),name:s.name||s.symbol,exchange:s.exchange||""})).filter(s=>s.symbol):
    Array.isArray(x.symbols)?x.symbols.map(s=>({symbol:String(s).toUpperCase(),name:String(s).toUpperCase(),exchange:""})):[];
  return{id:x.id||makeId(),name:(x.name||`Watchlist ${i+1}`).slice(0,24),stocks}
 }); else lists=defaultState();
 activeId=lists.some(x=>x.id===d.activeWatchlistId)?d.activeWatchlistId:lists[0].id;
 prefs=d.stockPrefs&&typeof d.stockPrefs==="object"?d.stockPrefs:{};
 theme=["slate","forest","cream","terminal","midnight"].includes(d.theme)?d.theme:"slate"
}
function applyTheme(){document.body.dataset.theme=theme;document.querySelectorAll("[data-theme-choice]").forEach(b=>b.classList.toggle("active",b.dataset.themeChoice===theme))}
function renderSelector(){
 const s=$("watchlistSelect");s.textContent="";
 for(const wl of lists){const o=document.createElement("option");o.value=wl.id;o.textContent=wl.name;if(wl.id===activeId)o.selected=true;s.append(o)}
 $("newListBtn").disabled=lists.length>=MAX_LISTS;$("deleteListBtn").disabled=lists.length<=1;$("listLabel").textContent=(activeList()?.name||"WATCHLIST").toUpperCase()
}
function render(){
 renderSelector();const ul=$("watchlist");ul.textContent="";const stocks=activeList()?.stocks||[];$("empty").classList.toggle("hidden",stocks.length>0);
 for(const stock of stocks){
  const sym=stock.symbol,q=quotes[`${activeId}:${sym}`],li=document.createElement("li");li.className="stock-block"+(expandedSymbol===sym?" expanded":"");
  const row=document.createElement("div");row.className="stock-row";
  const main=document.createElement("div");main.className="stock-main";main.tabIndex=0;
  const chev=document.createElement("div");chev.className="chevron";chev.textContent="›";
  const sy=document.createElement("div");sy.className="symbol";sy.textContent=sym;
  const co=document.createElement("div");co.className="company";co.textContent=stock.name||sym;
  const qt=document.createElement("div");qt.className="quote";
  const pr=document.createElement("div");pr.className="price";pr.textContent=q?money(q.close):"—";
  const ch=document.createElement("div");ch.className="change "+(!q?"muted":Number(q.percent_change)>=0?"up":"down");ch.textContent=q?`${Number(q.percent_change)>=0?"+":""}${Number(q.percent_change).toFixed(2)}%`:"not loaded";
  qt.append(pr,ch);main.append(chev,sy,co,qt);
  const toggle=()=>{if(expandedSymbol===sym){stopLive(sym);expandedSymbol=null}else{if(expandedSymbol)stopLive(expandedSymbol);expandedSymbol=sym}render();if(expandedSymbol===sym)requestAnimationFrame(()=>loadInlineData(sym,false))};
  main.onclick=toggle;main.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();toggle()}};
  const rm=document.createElement("button");rm.className="remove";rm.textContent="×";rm.title="Remove "+sym;rm.onclick=async e=>{e.stopPropagation();activeList().stocks=activeList().stocks.filter(x=>x.symbol!==sym);if(expandedSymbol===sym){stopLive(sym);expandedSymbol=null}delete inlineData[sym];await persist();render()};
  row.append(main,rm);li.append(row);if(expandedSymbol===sym)li.append(buildInlinePanel(stock));ul.append(li)
 }
}
function preset(sym,value,unit){
 const p=stockPref(sym);p.windowValue=value;p.windowUnit=unit;p.barInterval="auto";delete inlineData[sym];persist().then(()=>{render();requestAnimationFrame(()=>loadInlineData(sym,true))})
}
function buildInlinePanel(stock){
 const sym=stock.symbol,p=stockPref(sym),panel=document.createElement("section");panel.className="inline-panel";

 const toolbar=document.createElement("div");toolbar.className="inline-toolbar";
 const quick=document.createElement("div");quick.className="quick-range";
 [["1D",1,"days"],["5D",5,"days"],["1M",1,"months"],["3M",3,"months"],["1Y",1,"years"]].forEach(([label,v,u])=>{
  const b=document.createElement("button");b.type="button";b.textContent=label;
  if(p.windowValue===v&&p.windowUnit===u)b.classList.add("active");
  b.onclick=()=>preset(sym,v,u);quick.append(b)
 });
 const custom=document.createElement("button");custom.type="button";custom.className="custom-toggle";custom.textContent="CUSTOM";
 custom.onclick=()=>{const el=document.getElementById("custom-"+sym);if(el)el.classList.toggle("hidden")};quick.append(custom);

 const modes=document.createElement("div");modes.className="chart-modes";
 [["candle","CANDLES"],["line","LINE"]].forEach(([v,label])=>{
  const b=document.createElement("button");b.type="button";b.textContent=label;if(p.view===v)b.classList.add("active");
  b.onclick=async()=>{p.view=v;await persist();render();requestAnimationFrame(()=>drawInline(sym))};modes.append(b)
 });
 toolbar.append(quick,modes);

 const time=document.createElement("div");time.className="time-custom hidden";time.id="custom-"+sym;
 const lab=document.createElement("span");lab.className="section-label";lab.textContent="SHOW LAST";
 const num=document.createElement("input");num.type="number";num.min="1";num.max="5000";num.value=p.windowValue;
 const unit=document.createElement("select");["minutes","hours","days","weeks","months","years"].forEach(u=>{
  const o=document.createElement("option");o.value=u;o.textContent=u;if(u===p.windowUnit)o.selected=true;unit.append(o)
 });
 const apply=document.createElement("button");apply.type="button";apply.textContent="APPLY";
 apply.onclick=async()=>{p.windowValue=Math.max(1,Math.min(5000,Number(num.value)||1));p.windowUnit=unit.value;delete inlineData[sym];stopLive(sym);await persist();render();requestAnimationFrame(()=>loadInlineData(sym,true))};

 const bar=document.createElement("div");bar.className="bar-interval";
 const bl=document.createElement("span");bl.className="section-label";bl.textContent="BAR";
 const bs=document.createElement("select");
 ["auto","5s","15s","30s","1min","5min","15min","30min","1h","4h","1day","1week","1month"].forEach(v=>{
  const o=document.createElement("option");o.value=v;o.textContent=v==="auto"?"Auto":v;if(v===p.barInterval)o.selected=true;bs.append(o)
 });
 bs.onchange=async()=>{p.barInterval=bs.value;delete inlineData[sym];stopLive(sym);await persist();requestAnimationFrame(()=>loadInlineData(sym,true))};
 bar.append(bl,bs);time.append(lab,num,unit,apply,bar);

 const wrap=document.createElement("div");wrap.className="inline-chart-wrap";
 const canvas=document.createElement("canvas");canvas.className="inline-chart";canvas.id="inline-chart-"+sym;
 const status=document.createElement("div");status.className="inline-chart-status";status.id="inline-status-"+sym;
 const d=inlineData[sym];status.textContent=d?.loading?"Loading…":d?.error?d.error:d?.series?.length?"":"Loading when opened…";wrap.append(canvas,status);

 const presetRow=document.createElement("div");presetRow.className="preset-row";
 const presetLabel=document.createElement("label");presetLabel.textContent="INDICATORS";
 const presetSelect=document.createElement("select");presetSelect.id="inline-preset-"+sym;
 const options=[
  ["Clean",{sma:{enabled:false,period:20},ema:{enabled:false,period:20},volume:true,rsi:{enabled:false,period:14},macd:{enabled:false,fast:12,slow:26,signal:9}}],
  ["Trend",{sma:{enabled:true,period:50},ema:{enabled:true,period:20},volume:true,rsi:{enabled:false,period:14},macd:{enabled:false,fast:12,slow:26,signal:9}}],
  ["Momentum",{sma:{enabled:false,period:20},ema:{enabled:true,period:12},volume:true,rsi:{enabled:true,period:14},macd:{enabled:true,fast:12,slow:26,signal:9}}],
  ["Full",{sma:{enabled:true,period:20},ema:{enabled:true,period:20},volume:true,rsi:{enabled:true,period:14},macd:{enabled:true,fast:12,slow:26,signal:9}}]
 ];
 const current=document.createElement("option");current.value="";current.textContent="Current setup";presetSelect.append(current);
 options.forEach(([name])=>{const o=document.createElement("option");o.value="builtin:"+name;o.textContent=name;presetSelect.append(o)});
 Object.keys(indicatorPresets).forEach(name=>{const o=document.createElement("option");o.value="custom:"+name;o.textContent=name;presetSelect.append(o)});
 presetSelect.onchange=async()=>{
  if(!presetSelect.value)return;
  const [kind,name]=presetSelect.value.split(":");
  const built=Object.fromEntries(options);
  const src=kind==="builtin"?built[name]:indicatorPresets[name];
  if(!src)return;
  Object.assign(p,JSON.parse(JSON.stringify(src)));
  await persist();render();requestAnimationFrame(()=>drawInline(sym))
 };
 const edit=document.createElement("button");edit.type="button";edit.textContent="EDIT…";
 edit.onclick=()=>browser.windows.create({url:browser.runtime.getURL("indicator.html?symbol="+encodeURIComponent(sym)),type:"popup",width:520,height:650});
 presetRow.append(presetLabel,presetSelect,edit);
 panel.append(toolbar,time,wrap,presetRow);

 if(p.rsi.enabled){
  const sec=document.createElement("div");sec.className="inline-subpanel";
  const head=document.createElement("div");head.className="inline-subhead";head.innerHTML=`<span>RSI ${p.rsi.period}</span><span id="rsi-value-${sym}">—</span>`;
  const c=document.createElement("canvas");c.id="rsi-"+sym;sec.append(head,c);panel.append(sec)
 }
 if(p.macd.enabled){
  const sec=document.createElement("div");sec.className="inline-subpanel";
  const head=document.createElement("div");head.className="inline-subhead";head.innerHTML=`<span>MACD ${p.macd.fast}/${p.macd.slow}/${p.macd.signal}</span><span id="macd-value-${sym}">—</span>`;
  const c=document.createElement("canvas");c.id="macd-"+sym;sec.append(head,c);panel.append(sec)
 }

 const actions=document.createElement("div");actions.className="inline-actions";
 const meta=document.createElement("span");meta.className="inline-meta";meta.id="inline-meta-"+sym;meta.textContent=stock.exchange||stock.name||sym;
 const live=document.createElement("span");live.className="live-badge hidden";live.id="live-badge-"+sym;live.innerHTML='<span class="live-dot"></span><span>LIVE SESSION</span>';
 const reload=document.createElement("button");reload.type="button";reload.textContent="UPDATE";reload.onclick=()=>loadInlineData(sym,true);
 const full=document.createElement("button");full.type="button";full.className="full-page";full.textContent="FULL PAGE";full.onclick=()=>browser.tabs.create({url:browser.runtime.getURL("details.html?symbol="+encodeURIComponent(sym))});
 actions.append(meta,live,reload,full);panel.append(actions);return panel
}
function windowMinutes(p){
 const n=Math.max(1,Number(p.windowValue)||1),mult={minutes:1,hours:60,days:390,weeks:1950,months:8190,years:98280};return n*(mult[p.windowUnit]||390)
}
function autoInterval(p){
 const m=windowMinutes(p);
 if(m<=2)return"5s";
 if(m<=5)return"15s";
 if(m<=12)return"30s";
 if(m<=180)return"1min";
 if(m<=2*390)return"5min";
 if(m<=5*390)return"15min";
 if(m<=15*390)return"30min";
 if(m<=45*390)return"1h";
 if(m<=180*390)return"4h";
 if(m<=3*98280)return"1day";
 if(m<=8*98280)return"1week";
 return"1month"
}
function intervalMinutes(i){return{"5s":5/60,"15s":15/60,"30s":30/60,"1min":1,"5min":5,"15min":15,"30min":30,"1h":60,"4h":240,"1day":390,"1week":1950,"1month":8190}[i]||390}
function requestedBars(p,interval){return Math.max(2,Math.min(5000,Math.ceil(windowMinutes(p)/intervalMinutes(interval))+3))}
const liveSockets={},liveBars={};
function isSecondInterval(i){return["5s","15s","30s"].includes(i)}
function secondsFor(i){return{"5s":5,"15s":15,"30s":30}[i]||15}
function stopLive(sym){
 const ws=liveSockets[sym];
 if(ws){
  try{ws.send(JSON.stringify({action:"unsubscribe",params:{symbols:sym}}))}catch(e){}
  try{ws.close()}catch(e){}
 }
 delete liveSockets[sym];delete liveBars[sym]
}
function startLive(sym,interval){
 stopLive(sym);
 const badge=$("live-badge-"+sym);if(badge){badge.classList.remove("hidden");badge.classList.remove("connected")}
 if(!apiKey){inlineData[sym]={error:"Add your API key in settings."};return}
 const sec=secondsFor(interval);
 const ws=new WebSocket(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${encodeURIComponent(apiKey)}`);
 liveSockets[sym]=ws;liveBars[sym]=[];
 let gotTick=false,finished=false;

 const failToRest=async(message)=>{
  if(finished||gotTick||expandedSymbol!==sym)return;
  finished=true;
  try{ws.close()}catch(e){}
  delete liveSockets[sym];delete liveBars[sym];
  const st=$("inline-status-"+sym);if(st)st.textContent=message+" Loading 1-minute fallback…";
  try{
   const p=stockPref(sym),count=Math.max(3,Math.min(60,Math.ceil(windowMinutes(p))+2));
   const d=await fetchSeries(sym,"1min",count);
   if(expandedSymbol!==sym)return;
   const series=[...d.values].reverse().map(v=>({t:v.datetime,o:+v.open,h:+v.high,l:+v.low,c:+v.close,v:+(v.volume||0)})).filter(x=>[x.o,x.h,x.l,x.c].every(Number.isFinite));
   inlineData[sym]={series,interval:"1min",fallback:true,meta:d.meta||{}};
   drawInline(sym)
  }catch(e){
   inlineData[sym]={error:"Live ticks unavailable. Choose 1m+ or press UPDATE to retry."};
   const s=$("inline-status-"+sym);if(s)s.textContent=inlineData[sym].error
  }
 };

 const timer=setTimeout(()=>failToRest("No live ticks received."),8000);

 ws.onopen=()=>{
  if(liveSockets[sym]!==ws)return;
  ws.send(JSON.stringify({action:"subscribe",params:{symbols:sym}}));
  const b=$("live-badge-"+sym);if(b)b.classList.add("connected");
  const st=$("inline-status-"+sym);if(st)st.textContent="Waiting for first live tick…"
 };
 ws.onmessage=e=>{
  if(liveSockets[sym]!==ws)return;
  let msg;try{msg=JSON.parse(e.data)}catch(_){return}
  const price=Number(msg.price),ts=Number(msg.timestamp||Date.now()/1000);
  if(!Number.isFinite(price)||!Number.isFinite(ts))return;
  gotTick=true;clearTimeout(timer);
  const bucket=Math.floor(ts/sec)*sec,bars=liveBars[sym];
  let bar=bars[bars.length-1];
  if(!bar||bar.bucket!==bucket){bar={bucket,t:new Date(bucket*1000).toISOString(),o:price,h:price,l:price,c:price,v:0};bars.push(bar)}
  else{bar.h=Math.max(bar.h,price);bar.l=Math.min(bar.l,price);bar.c=price}
  const p=stockPref(sym),maxBars=Math.max(8,Math.ceil((windowMinutes(p)*60)/sec));
  while(bars.length>maxBars)bars.shift();
  inlineData[sym]={series:bars.slice(),interval,fallback:false,live:true};
  drawInline(sym)
 };
 ws.onerror=()=>failToRest("Live stream unavailable.");
 ws.onclose=()=>{const b=$("live-badge-"+sym);if(b)b.classList.remove("connected")};
}
async function fetchSeries(sym,interval,count){
 const u=new URL("https://api.twelvedata.com/time_series");u.searchParams.set("symbol",sym);u.searchParams.set("interval",interval);u.searchParams.set("outputsize",String(count));u.searchParams.set("apikey",apiKey);
 const {r,d}=await limitedJson(u);if(!r.ok||d.status==="error"||!Array.isArray(d.values)){const e=new Error(d.message||`Unable to load ${interval} data`);e.code=d.code||r.status;e.raw=d;throw e}return d
}
async function loadInlineData(sym,force){
 if(expandedSymbol!==sym)return;
 const p=stockPref(sym),interval=p.barInterval==="auto"?autoInterval(p):p.barInterval;

 if(isSecondInterval(interval)){
  if(inlineData[sym]?.live&&!force){drawInline(sym);return}
  inlineData[sym]={series:[],interval,live:true};
  startLive(sym,interval);drawInline(sym);return
 }

 stopLive(sym);
 const existing=inlineData[sym];
 if(existing?.series?.length&&!force){drawInline(sym);return}
 if(existing?.loading)return;
 if(!apiKey){inlineData[sym]={error:"Add your API key in settings."};render();return}

 inlineData[sym]={loading:true};
 const st=$("inline-status-"+sym);if(st)st.textContent="Loading…";
 let actual=interval,count=requestedBars(p,actual),fallback=false;
 try{
  let d;
  try{d=await fetchSeries(sym,actual,count)}
  catch(e){
   const msg=String(e.message||"").toLowerCase();
   if(actual!=="1day"&&(msg.includes("pro")||msg.includes("upgrade")||msg.includes("access")||msg.includes("trial"))){
    actual="1day";count=requestedBars(p,actual);d=await fetchSeries(sym,actual,count);fallback=true
   }else throw e
  }
  const series=[...d.values].reverse().map(v=>({
   t:v.datetime,o:+v.open,h:+v.high,l:+v.low,c:+v.close,v:+(v.volume||0)
  })).filter(x=>[x.o,x.h,x.l,x.c].every(Number.isFinite));
  inlineData[sym]={series,interval:actual,fallback,meta:d.meta||{}};
  drawInline(sym)
 }catch(e){
  inlineData[sym]={error:e.message||"Unable to load chart"};
  const s=$("inline-status-"+sym);if(s)s.textContent=inlineData[sym].error
 }
}
function sma(a,n){const o=Array(a.length).fill(null);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=n)s-=a[i-n];if(i>=n-1)o[i]=s/n}return o}
function ema(a,n){const o=Array(a.length).fill(null),k=2/(n+1);let v=a[0];for(let i=0;i<a.length;i++){v=i?a[i]*k+v*(1-k):a[i];if(i>=n-1)o[i]=v}return o}
function rsi(a,n=14){const o=Array(a.length).fill(null);if(a.length<=n)return o;let g=0,l=0;for(let i=1;i<=n;i++){const d=a[i]-a[i-1];d>=0?g+=d:l-=d}g/=n;l/=n;o[n]=l===0?100:100-100/(1+g/l);for(let i=n+1;i<a.length;i++){const d=a[i]-a[i-1];g=(g*(n-1)+Math.max(d,0))/n;l=(l*(n-1)+Math.max(-d,0))/n;o[i]=l===0?100:100-100/(1+g/l)}return o}
function macd(a,fast=12,slow=26,signal=9){
 const ef=ema(a,fast),es=ema(a,slow),
 m=a.map((_,i)=>Number.isFinite(ef[i])&&Number.isFinite(es[i])?ef[i]-es[i]:null),
 sig=ema(m.map(v=>v??0),signal).map((v,i)=>m[i]===null?null:v),
 hist=m.map((v,i)=>v!==null&&sig[i]!==null?v-sig[i]:null);
 return{m,sig,hist}
}
function prep(canvas,h){const d=devicePixelRatio||1,w=Math.max(300,canvas.clientWidth||360);canvas.width=w*d;canvas.height=h*d;const c=canvas.getContext("2d");c.setTransform(d,0,0,d,0,0);c.clearRect(0,0,w,h);return[c,w,h]}
function path(c,arr,x,y,color,w=1.1){c.strokeStyle=color;c.lineWidth=w;c.beginPath();let s=false;arr.forEach((v,i)=>{if(!Number.isFinite(v))return;s?c.lineTo(x(i),y(v)):c.moveTo(x(i),y(v));s=true});c.stroke()}
function css(name){return getComputedStyle(document.body).getPropertyValue(name).trim()}
function drawInline(sym){
 if(expandedSymbol!==sym)return;const d=inlineData[sym],canvas=$("inline-chart-"+sym),status=$("inline-status-"+sym);if(!canvas)return;if(!d?.series?.length){if(status&&!d?.loading)status.textContent=d?.error||"Loading when opened…";return}if(status)status.textContent="";
 const p=stockPref(sym),series=d.series,[c,w,h]=prep(canvas,canvas.clientHeight||220),pad={l:42,r:7,t:7,b:17},priceBottom=p.volume?h*.76:h-pad.b,closes=series.map(x=>x.c),over=[];
 if(p.sma.enabled)over.push([sma(closes,p.sma.period),"#aeb5bd"]);if(p.ema.enabled)over.push([ema(closes,p.ema.period),"#648bc0"]);
 const vals=series.flatMap(q=>[q.h,q.l]).concat(over.flatMap(o=>o[0].filter(Number.isFinite)));let min=Math.min(...vals),max=Math.max(...vals),span=max-min||1;min-=span*.03;max+=span*.03;
 const plotW=w-pad.l-pad.r;
 const naturalSlot=series.length?plotW/series.length:plotW;
 const slot=Math.min(28,naturalSlot);
 const used=Math.min(plotW,slot*series.length);
 const startX=pad.l+(plotW-used)/2+slot/2;
 const x=i=>startX+i*slot;
 const y=v=>pad.t+(max-v)/(max-min)*(priceBottom-pad.t);
 c.strokeStyle=css("--line2");c.fillStyle=css("--muted");c.font="8px Arial";for(let i=0;i<4;i++){const yy=pad.t+i*(priceBottom-pad.t)/3;c.beginPath();c.moveTo(pad.l,yy);c.lineTo(w-pad.r,yy);c.stroke();c.fillText((max-i*(max-min)/3).toFixed(2),2,yy+3)}
 if(p.view==="line")path(c,closes,x,y,css("--text"),1.4);else{
  const spacing=slot,bodyW=Math.max(4,Math.min(22,spacing*.82));
  series.forEach((q,i)=>{const xx=x(i),col=q.c>=q.o?css("--up"):css("--down");c.strokeStyle=col;c.fillStyle=col;c.lineWidth=1;c.beginPath();c.moveTo(xx,y(q.h));c.lineTo(xx,y(q.l));c.stroke();const top=Math.min(y(q.o),y(q.c)),bh=Math.max(2,Math.abs(y(q.o)-y(q.c)));c.fillRect(xx-bodyW/2,top,bodyW,bh)})
 }
 over.forEach(o=>path(c,o[0],x,y,o[1],1.05));
 if(p.volume){const vmax=Math.max(...series.map(q=>q.v),1),base=h-pad.b,top=h*.80,spacing=slot,bw=Math.max(3,Math.min(18,spacing*.74));series.forEach((q,i)=>{const bh=q.v/vmax*(base-top);c.globalAlpha=.42;c.fillStyle=q.c>=q.o?css("--up"):css("--down");c.fillRect(x(i)-bw/2,base-bh,bw,bh)});c.globalAlpha=1}
 const meta=$("inline-meta-"+sym);if(meta)meta.textContent=`${d.interval}${d.fallback?" · intraday unavailable, daily fallback":""} · ${series.length} bars`;
 if(p.rsi.enabled)drawRSI(sym,series);if(p.macd.enabled)drawMACD(sym,series)
}
function drawRSI(sym,series){const can=$("rsi-"+sym);if(!can)return;const vals=rsi(series.map(x=>x.c),stockPref(sym).rsi.period),[c,w,h]=prep(can,74),pad={l:42,r:7,t:5,b:9},x=i=>pad.l+i/Math.max(1,series.length-1)*(w-pad.l-pad.r),y=v=>pad.t+(100-v)/100*(h-pad.t-pad.b);c.strokeStyle=css("--line2");[30,70].forEach(v=>{c.beginPath();c.moveTo(pad.l,y(v));c.lineTo(w-pad.r,y(v));c.stroke()});path(c,vals,x,y,css("--accent"),1);const last=[...vals].reverse().find(Number.isFinite),el=$("rsi-value-"+sym);if(el)el.textContent=Number.isFinite(last)?last.toFixed(1):"—"}
function drawMACD(sym,series){const can=$("macd-"+sym);if(!can)return;const mp=stockPref(sym).macd,z=macd(series.map(x=>x.c),mp.fast,mp.slow,mp.signal),valid=[...z.m,...z.sig,...z.hist].filter(Number.isFinite);if(!valid.length)return;const[c,w,h]=prep(can,74),pad={l:42,r:7,t:5,b:9};let min=Math.min(...valid,0),max=Math.max(...valid,0),span=max-min||1;min-=span*.1;max+=span*.1;const x=i=>pad.l+i/Math.max(1,series.length-1)*(w-pad.l-pad.r),y=v=>pad.t+(max-v)/(max-min)*(h-pad.t-pad.b),spacing=(w-pad.l-pad.r)/Math.max(1,series.length-1),bw=Math.max(2,Math.min(9,spacing*.7));z.hist.forEach((v,i)=>{if(!Number.isFinite(v))return;c.globalAlpha=.45;c.fillStyle=v>=0?css("--up"):css("--down");const yy=y(v),zero=y(0);c.fillRect(x(i)-bw/2,Math.min(yy,zero),bw,Math.max(1,Math.abs(zero-yy)))});c.globalAlpha=1;path(c,z.m,x,y,css("--text"),1);path(c,z.sig,x,y,css("--accent"),1);const last=[...z.m].reverse().find(Number.isFinite),el=$("macd-value-"+sym);if(el)el.textContent=Number.isFinite(last)?last.toFixed(3):"—"}

function clearSearchResults(){searchItems=[];selectedSearchIndex=-1;$("searchResults").textContent="";$("searchResults").classList.add("hidden")}
function setSearchHint(t,e=false){$("searchHint").textContent=t;$("searchHint").classList.toggle("error",e)}
function norm(x){return{symbol:String(x.symbol||"").toUpperCase(),name:String(x.instrument_name||x.name||x.symbol||"").trim(),exchange:String(x.exchange||x.mic_code||"").trim(),country:String(x.country||"").trim(),type:String(x.instrument_type||x.type||"").trim()}}
function okay(i){if(!i.symbol||!i.name)return false;const t=i.type.toLowerCase();return!t||t.includes("stock")||t.includes("equity")||t.includes("common")}
function renderSearchResults(){const ul=$("searchResults");ul.textContent="";if(!searchItems.length){const li=document.createElement("li");li.className="search-message";li.textContent="No matching stocks found.";ul.append(li);ul.classList.remove("hidden");return}searchItems.forEach((item,i)=>{const li=document.createElement("li");li.className="search-result"+(i===selectedSearchIndex?" selected":"");const sy=document.createElement("div");sy.className="result-symbol";sy.textContent=item.symbol;const info=document.createElement("div");info.className="result-info";const n=document.createElement("div");n.className="result-name";n.textContent=item.name;const m=document.createElement("div");m.className="result-meta";m.textContent=[item.exchange,item.country].filter(Boolean).join(" · ");info.append(n,m);const a=document.createElement("div");a.className="result-add";a.textContent="+";li.append(sy,info,a);li.onmousedown=e=>e.preventDefault();li.onclick=()=>addStock(item);ul.append(li)});ul.classList.remove("hidden")}
async function searchStocks(q){const seq=++searchSeq;q=q.trim();if(!apiKey){setSearchHint("Add your API key in settings first.",true);clearSearchResults();return}if(!q){setSearchHint("Search by company name or symbol.");clearSearchResults();return}setSearchHint("Searching…");try{const u=new URL("https://api.twelvedata.com/symbol_search");u.searchParams.set("symbol",q);u.searchParams.set("outputsize","10");u.searchParams.set("apikey",apiKey);const {r,d}=await limitedJson(u);if(seq!==searchSeq)return;if(!r.ok||d.status==="error")throw Error(d.message||"Search failed");const seen=new Set(),items=(Array.isArray(d.data)?d.data:[]).map(norm).filter(okay).filter(x=>{const k=x.symbol+"|"+x.exchange;if(seen.has(k))return false;seen.add(k);return true});items.sort((a,b)=>(b.country==="United States")-(a.country==="United States"));searchItems=items.slice(0,6);selectedSearchIndex=searchItems.length?0:-1;setSearchHint(searchItems.length?"Choose a verified result.":"No matching stocks found.");renderSearchResults()}catch(e){if(seq!==searchSeq)return;searchItems=[];setSearchHint(e.message||"Search unavailable.",true);renderSearchResults()}}
async function addStock(item){const wl=activeList();if(wl.stocks.some(x=>x.symbol===item.symbol)){setSearchHint(`${item.symbol} is already here.`,true);return}wl.stocks.push({symbol:item.symbol,name:item.name,exchange:item.exchange});await persist();$("stockSearch").value="";$("clearSearchBtn").classList.add("hidden");clearSearchResults();setSearchHint(`${item.name} (${item.symbol}) added.`);render()}
async function fetchQuote(sym){const u=new URL("https://api.twelvedata.com/quote");u.searchParams.set("symbol",sym);u.searchParams.set("apikey",apiKey);const {r,d}=await limitedJson(u);if(!r.ok||d.status==="error"||d.code)throw Error(d.message||"Request failed");return d}
async function loadQuotes(){const wl=activeList();if(!apiKey){$("settingsPanel").classList.remove("hidden");$("status").textContent="Add an API key first.";return}if(!wl.stocks.length){$("status").textContent="Add a stock first.";return}$("refreshBtn").disabled=true;$("status").textContent="Loading…";let n=0;for(const s of wl.stocks){try{quotes[`${activeId}:${s.symbol}`]=await fetchQuote(s.symbol);n++;render();if(expandedSymbol===s.symbol)requestAnimationFrame(()=>drawInline(s.symbol))}catch(e){console.error(e)}}$("refreshBtn").disabled=false;$("status").textContent=`Updated ${n} of ${wl.stocks.length}.`}

(async()=>{
 const d=await browser.storage.local.get(["watchlists","activeWatchlistId","apiKey","stockPrefs","theme","indicatorPresets"]);migrate(d);apiKey=d.apiKey||"";indicatorPresets=d.indicatorPresets&&typeof d.indicatorPresets==="object"?d.indicatorPresets:{};
 if(theme==="graphite"||theme==="ocean")theme="slate";
 if(theme==="paper"||theme==="sepia")theme="cream";
 $("apiKey").value=apiKey;applyTheme();await persist();render();
 $("themeBtn").onclick=()=>{$("themePanel").classList.toggle("hidden");$("settingsPanel").classList.add("hidden")};
 document.querySelectorAll("[data-theme-choice]").forEach(b=>b.onclick=async()=>{theme=b.dataset.themeChoice;applyTheme();await persist();if(expandedSymbol)requestAnimationFrame(()=>drawInline(expandedSymbol))});
 $("settingsBtn").onclick=()=>{$("settingsPanel").classList.toggle("hidden");$("themePanel").classList.add("hidden")};
 $("saveKeyBtn").onclick=async()=>{apiKey=$("apiKey").value.trim();await browser.storage.local.set({apiKey});$("status").textContent=apiKey?"API key saved.":"API key cleared."};
 $("watchlistSelect").onchange=async e=>{if(expandedSymbol)stopLive(expandedSymbol);activeId=e.target.value;quotes={};expandedSymbol=null;inlineData={};await persist();render()};
 $("newListBtn").onclick=async()=>{if(lists.length>=MAX_LISTS)return;const id=makeId();lists.push({id,name:`Watchlist ${lists.length+1}`,stocks:[]});activeId=id;expandedSymbol=null;await persist();render()};
 $("deleteListBtn").onclick=async()=>{if(lists.length<=1)return;const i=lists.findIndex(x=>x.id===activeId);lists=lists.filter(x=>x.id!==activeId);activeId=lists[Math.max(0,i-1)]?.id||lists[0].id;expandedSymbol=null;inlineData={};await persist();render()};
 $("renameBtn").onclick=()=>{$("renameInput").value=activeList().name;$("renameForm").classList.remove("hidden");$("renameInput").focus();$("renameInput").select()};
 $("cancelRenameBtn").onclick=()=>$("renameForm").classList.add("hidden");
 $("renameForm").onsubmit=async e=>{e.preventDefault();const n=$("renameInput").value.trim().slice(0,24);if(!n)return;activeList().name=n;await persist();$("renameForm").classList.add("hidden");render()};
 $("refreshBtn").onclick=loadQuotes;
 $("stockSearch").oninput=e=>{const q=e.target.value;$("clearSearchBtn").classList.toggle("hidden",!q);clearTimeout(searchTimer);if(!q.trim()){clearSearchResults();setSearchHint("Search by company name or symbol.");return}searchTimer=setTimeout(()=>searchStocks(q),260)};
 $("stockSearch").onkeydown=e=>{if($("searchResults").classList.contains("hidden")||!searchItems.length)return;if(e.key==="ArrowDown"){e.preventDefault();selectedSearchIndex=(selectedSearchIndex+1)%searchItems.length;renderSearchResults()}else if(e.key==="ArrowUp"){e.preventDefault();selectedSearchIndex=(selectedSearchIndex-1+searchItems.length)%searchItems.length;renderSearchResults()}else if(e.key==="Enter"){e.preventDefault();if(selectedSearchIndex>=0)addStock(searchItems[selectedSearchIndex])}else if(e.key==="Escape")clearSearchResults()};
 $("clearSearchBtn").onclick=()=>{$("stockSearch").value="";$("clearSearchBtn").classList.add("hidden");clearSearchResults();setSearchHint("Search by company name or symbol.")};
 $("popoutBtn").onclick=async()=>{await browser.windows.create({url:browser.runtime.getURL("popup.html"),type:"popup",width:610,height:800});window.close()};
})();

window.addEventListener("beforeunload",()=>{Object.keys(liveSockets).forEach(stopLive)});

browser.storage.onChanged.addListener((changes,area)=>{
 if(area!=="local")return;
 if(changes.stockPrefs){prefs=changes.stockPrefs.newValue||{};if(expandedSymbol){render();requestAnimationFrame(()=>drawInline(expandedSymbol))}}
 if(changes.indicatorPresets){indicatorPresets=changes.indicatorPresets.newValue||{};if(expandedSymbol)render()}
});
