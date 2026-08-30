const $=id=>document.getElementById(id), p=new URLSearchParams(location.search), symbol=(p.get("symbol")||"AAPL").toUpperCase();
let range="1M",view="candle",series=[],apiKey="",viewportAnchor=null,olderDebounceTimer=null;
const olderFetch={loading:false,exhausted:false};
const cfg={"1D":["5min",78],"5D":["30min",80],"1M":["1day",30],"3M":["1day",90],"1Y":["1day",260]};
const rangeSpan={"1D":[1,"days"],"5D":[5,"days"],"1M":[1,"months"],"3M":[3,"months"],"1Y":[1,"years"]};
const VP=globalThis.BearFishViewport;
$("symbol").textContent=symbol;
function sma(a,n){let o=Array(a.length).fill(null),s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=n)s-=a[i-n];if(i>=n-1)o[i]=s/n}return o}
function ema(a,n){let o=Array(a.length).fill(null),k=2/(n+1),v=a[0];for(let i=0;i<a.length;i++){v=i? a[i]*k+v*(1-k):a[i];if(i>=n-1)o[i]=v}return o}
function rsi(a,n=14){let o=Array(a.length).fill(null);if(a.length<=n)return o;let g=0,l=0;for(let i=1;i<=n;i++){let d=a[i]-a[i-1];if(d>=0)g+=d;else l-=d}g/=n;l/=n;o[n]=l===0?100:100-(100/(1+g/l));for(let i=n+1;i<a.length;i++){let d=a[i]-a[i-1];g=(g*(n-1)+Math.max(d,0))/n;l=(l*(n-1)+Math.max(-d,0))/n;o[i]=l===0?100:100-(100/(1+g/l))}return o}
function macd(a){const e12=ema(a,12),e26=ema(a,26),m=a.map((_,i)=>Number.isFinite(e12[i])&&Number.isFinite(e26[i])?e12[i]-e26[i]:null),clean=m.map(v=>v??0),sig=ema(clean,9).map((v,i)=>m[i]===null?null:v),hist=m.map((v,i)=>v!==null&&sig[i]!==null?v-sig[i]:null);return{m,sig,hist}}
function money(v){const n=Number(v);return Number.isFinite(n)?n.toLocaleString(undefined,{style:"currency",currency:"USD",maximumFractionDigits:2}):"—"}
function spanMs(){const[value,unit]=rangeSpan[range]||[1,"months"];return VP.windowDurationMs(value,unit)}
function resetViewport(){viewportAnchor=null;olderFetch.loading=false;olderFetch.exhausted=false;clearTimeout(olderDebounceTimer)}
async function load(){
 const d=await browser.storage.local.get(["apiKey"]);apiKey=d.apiKey||"";if(!apiKey){$("chartStatus").textContent="Add your API key from the BearFish popup first.";return}
 $("loadBtn").disabled=true;$("chartStatus").textContent="Loading…";resetViewport();
 try{const [interval,size]=cfg[range],u=new URL("https://api.twelvedata.com/time_series");u.searchParams.set("symbol",symbol);u.searchParams.set("interval",interval);u.searchParams.set("outputsize",size);u.searchParams.set("apikey",apiKey);
  const {r,d:x}=await globalThis.BearFishRateLimit.limitedJson(u,{runtime:browser.runtime,storage:browser.storage.local,onWait:({waitMs})=>$("chartStatus").textContent=`API limit reached — waiting ${Math.ceil(waitMs/1000)}s…`});if(!r.ok||x.status==="error"||!Array.isArray(x.values))throw Error(x.message||"Unable to load data");
  series=[...x.values].reverse().map(v=>({t:v.datetime,o:+v.open,h:+v.high,l:+v.low,c:+v.close,v:+(v.volume||0)})).filter(x=>[x.o,x.h,x.l,x.c].every(Number.isFinite));
  $("meta").textContent=`${x.meta?.interval||interval} · ${series.length} bars`;$("last").textContent=money(series.at(-1)?.c);
  const ch=series.length>1?(series.at(-1).c-series[0].c)/series[0].c*100:NaN;$("change").textContent=Number.isFinite(ch)?`${ch>=0?"+":""}${ch.toFixed(2)}%`:"—";
  $("volume").textContent=series.at(-1)?.v?Math.round(series.at(-1).v).toLocaleString():"—";$("chartStatus").textContent="";drawAll();
 }catch(e){$("chartStatus").textContent=e.message}finally{$("loadBtn").disabled=false}
}
function maybeLoadOlder(){clearTimeout(olderDebounceTimer);olderDebounceTimer=setTimeout(loadOlderData,400)}
async function loadOlderData(){
 if(!series.length||olderFetch.loading||olderFetch.exhausted)return;
 const anchor=VP.clampAnchorMs(series,viewportAnchor);
 if(!VP.needsOlderData(series,anchor,spanMs()))return;
 const oldestMs=VP.barTimeMs(series[0]);if(!Number.isFinite(oldestMs))return;
 olderFetch.loading=true;
 try{
  const [interval,size]=cfg[range],endDate=new Date(oldestMs-1000).toISOString().replace("T"," ").slice(0,19);
  const u=new URL("https://api.twelvedata.com/time_series");u.searchParams.set("symbol",symbol);u.searchParams.set("interval",interval);u.searchParams.set("outputsize",size);u.searchParams.set("end_date",endDate);u.searchParams.set("apikey",apiKey);
  const {r,d:x}=await globalThis.BearFishRateLimit.limitedJson(u,{runtime:browser.runtime,storage:browser.storage.local});
  if(!r.ok||x.status==="error"||!Array.isArray(x.values))throw Error(x.message||"Unable to load data");
  const older=[...x.values].reverse().map(v=>({t:v.datetime,o:+v.open,h:+v.high,l:+v.low,c:+v.close,v:+(v.volume||0)})).filter(x=>[x.o,x.h,x.l,x.c].every(Number.isFinite));
  const seen=new Set(series.map(b=>b.t)),added=older.filter(b=>!seen.has(b.t));
  if(!added.length)olderFetch.exhausted=true;
  else series=added.concat(series).sort((a,b)=>VP.barTimeMs(a)-VP.barTimeMs(b));
  drawAll();
 }catch(e){olderFetch.exhausted=true}
 finally{olderFetch.loading=false}
}
function computeViewport(){
 if(!series.length)return null;
 const span=spanMs(),anchor=VP.clampAnchorMs(series,viewportAnchor),
       {startIdx,endIdx,windowStartMs,windowEndMs}=VP.sliceViewport(series,anchor,span);
 return{span,anchor,startIdx,endIdx,windowStartMs,windowEndMs,
  visible:series.slice(startIdx,endIdx+1),history:series.slice(0,endIdx+1),
  atLatest:VP.isAtLatest(series,viewportAnchor)};
}
function updateViewportControls(vp){
 const wrap=$("viewport"),slider=$("viewportSlider"),now=$("viewportNow"),badge=$("viewportStatus"),rangeLbl=$("viewportRange");
 if(!wrap)return;
 if(!vp){wrap.classList.add("hidden");return}
 const bounds=VP.seriesBounds(series),enough=!!bounds&&bounds.last>bounds.first;
 wrap.classList.toggle("hidden",!enough);
 if(enough&&slider){slider.min=String(bounds.first);slider.max=String(bounds.last);slider.value=String(vp.anchor)}
 const lastMs=VP.barTimeMs(series[series.length-1]),fresh=Number.isFinite(lastMs)&&(Date.now()-lastMs)<Math.max(vp.span,60000)*2;
 const label=VP.statusLabel({atLatest:vp.atLatest,liveConnected:false,fresh});
 if(badge){badge.textContent=label;badge.classList.toggle("historical",label==="HISTORY");badge.classList.toggle("live",label==="LIVE")}
 if(rangeLbl)rangeLbl.textContent=VP.formatRange(vp.windowStartMs,vp.windowEndMs);
 if(now)now.classList.toggle("hidden",vp.atLatest);
 if(!vp.atLatest)maybeLoadOlder();
}
function prep(canvas,h){const d=devicePixelRatio||1,w=canvas.clientWidth||900;canvas.width=w*d;canvas.height=h*d;const c=canvas.getContext("2d");c.setTransform(d,0,0,d,0,0);c.clearRect(0,0,w,h);return[c,w,h]}
function drawLine(c,arr,x,y,color,width=1.3){c.strokeStyle=color;c.lineWidth=width;c.beginPath();let started=false;arr.forEach((v,i)=>{if(!Number.isFinite(v))return;started?c.lineTo(x(i),y(v)):c.moveTo(x(i),y(v));started=true});c.stroke()}
function drawMain(vp){
 const canvas=$("chart"),[c,w,h]=prep(canvas,500),pad={l:52,r:14,t:14,b:24},volOn=$("volumeToggle").checked;
 if(!vp||vp.visible.length<2)return;
 const shown=vp.visible,closesHistory=vp.history.map(x=>x.c),overlaysFull=[];
 if($("sma20").checked)overlaysFull.push(["SMA20",sma(closesHistory,20),"#9ba7b5"]);
 if($("sma50").checked)overlaysFull.push(["SMA50",sma(closesHistory,50),"#d1b777"]);
 if($("ema20").checked)overlaysFull.push(["EMA20",ema(closesHistory,20),"#8ca3d7"]);
 const overlays=overlaysFull.map(([name,arr,color])=>[name,arr.slice(vp.startIdx,vp.endIdx+1),color]);
 const closes=shown.map(x=>x.c);
 const vals=shown.flatMap(x=>[x.h,x.l]).concat(overlays.flatMap(o=>o[1].filter(Number.isFinite)));let min=Math.min(...vals),max=Math.max(...vals),priceSpan=max-min||1;min-=priceSpan*.04;max+=priceSpan*.04;
 const priceBottom=volOn?h*.79:h-pad.b,x=i=>pad.l+i/(shown.length-1)*(w-pad.l-pad.r),y=v=>pad.t+(max-v)/(max-min)*(priceBottom-pad.t);
 c.strokeStyle="#24282d";c.lineWidth=1;c.fillStyle="#7f858d";c.font="10px Arial";for(let i=0;i<5;i++){let yy=pad.t+i*(priceBottom-pad.t)/4;c.beginPath();c.moveTo(pad.l,yy);c.lineTo(w-pad.r,yy);c.stroke();let val=max-i*(max-min)/4;c.fillText(val.toFixed(2),4,yy+3)}
 if(view==="line")drawLine(c,closes,x,y,"#d7d9dc",1.6);else{const spacing=(w-pad.l-pad.r)/Math.max(1,shown.length-1);const bw=Math.max(4,Math.min(18,spacing*.9));shown.forEach((q,i)=>{const xx=x(i),up=q.c>=q.o,col=up?"#57bd7c":"#dc6b72";c.strokeStyle=col;c.fillStyle=col;c.lineWidth=1;c.beginPath();c.moveTo(xx,y(q.h));c.lineTo(xx,y(q.l));c.stroke();const top=Math.min(y(q.o),y(q.c)),bh=Math.max(1,Math.abs(y(q.o)-y(q.c)));c.fillRect(xx-bw/2,top,bw,bh)})}
 overlays.forEach(o=>drawLine(c,o[1],x,y,o[2],1.2));
 if(volOn){const vmax=Math.max(...shown.map(q=>q.v),1),base=h-pad.b,top=h*.82;c.strokeStyle="#24282d";c.beginPath();c.moveTo(pad.l,top);c.lineTo(w-pad.r,top);c.stroke();shown.forEach((q,i)=>{const bh=(q.v/vmax)*(base-top),bw=Math.max(1,(w-pad.l-pad.r)/shown.length*.55);c.fillStyle=q.c>=q.o?"#355f47":"#643b40";c.fillRect(x(i)-bw/2,base-bh,bw,bh)})}
}
function drawRSI(vp){
 const panel=$("rsiPanel");panel.classList.toggle("hidden",!$("rsiToggle").checked);if(!$("rsiToggle").checked||!vp||vp.visible.length<2)return;
 const valsFull=rsi(vp.history.map(x=>x.c)),vals=valsFull.slice(vp.startIdx,vp.endIdx+1),len=Math.max(1,vp.endIdx-vp.startIdx);
 const [c,w,h]=prep($("rsiChart"),150),pad={l:52,r:14,t:10,b:18},x=i=>pad.l+i/len*(w-pad.l-pad.r),y=v=>pad.t+(100-v)/100*(h-pad.t-pad.b);
 c.strokeStyle="#292d32";[30,50,70].forEach(v=>{c.beginPath();c.moveTo(pad.l,y(v));c.lineTo(w-pad.r,y(v));c.stroke();c.fillStyle="#777d85";c.font="9px Arial";c.fillText(String(v),18,y(v)+3)});drawLine(c,vals,x,y,"#b7a2d8",1.2);const last=[...vals].reverse().find(Number.isFinite);$("rsiValue").textContent=Number.isFinite(last)?last.toFixed(1):"—";
}
function drawMACD(vp){
 const panel=$("macdPanel");panel.classList.toggle("hidden",!$("macdToggle").checked);if(!$("macdToggle").checked||!vp||vp.visible.length<2)return;
 const zFull=macd(vp.history.map(x=>x.c)),z={m:zFull.m.slice(vp.startIdx,vp.endIdx+1),sig:zFull.sig.slice(vp.startIdx,vp.endIdx+1),hist:zFull.hist.slice(vp.startIdx,vp.endIdx+1)},
       valid=z.m.concat(z.sig,z.hist).filter(Number.isFinite),[c,w,h]=prep($("macdChart"),150),pad={l:52,r:14,t:10,b:18};if(!valid.length)return;
 let min=Math.min(...valid,0),max=Math.max(...valid,0),macdSpan=max-min||1;min-=macdSpan*.1;max+=macdSpan*.1;
 const len=Math.max(1,vp.endIdx-vp.startIdx),x=i=>pad.l+i/len*(w-pad.l-pad.r),y=v=>pad.t+(max-v)/(max-min)*(h-pad.t-pad.b);
 c.strokeStyle="#30343a";c.beginPath();c.moveTo(pad.l,y(0));c.lineTo(w-pad.r,y(0));c.stroke();const spacing=(w-pad.l-pad.r)/len;const bw=Math.max(3,Math.min(16,spacing*.82));z.hist.forEach((v,i)=>{if(!Number.isFinite(v))return;c.fillStyle=v>=0?"#355f47":"#643b40";const yy=y(v),zero=y(0);c.fillRect(x(i)-bw/2,Math.min(yy,zero),bw,Math.max(1,Math.abs(zero-yy)))});drawLine(c,z.m,x,y,"#aab3c0",1.2);drawLine(c,z.sig,x,y,"#c9a76a",1.1);const last=[...z.m].reverse().find(Number.isFinite);$("macdValue").textContent=Number.isFinite(last)?last.toFixed(3):"—";
}
function drawAll(){const vp=computeViewport();updateViewportControls(vp);drawMain(vp);drawRSI(vp);drawMACD(vp)}
$("loadBtn").onclick=load;
document.querySelectorAll("[data-range]").forEach(b=>b.onclick=()=>{range=b.dataset.range;document.querySelectorAll("[data-range]").forEach(x=>x.classList.toggle("active",x===b));series=[];resetViewport();$("chartStatus").textContent="Range changed — load data.";drawAll()});
document.querySelectorAll("[data-view]").forEach(b=>b.onclick=()=>{view=b.dataset.view;document.querySelectorAll("[data-view]").forEach(x=>x.classList.toggle("active",x===b));drawAll()});
["sma20","sma50","ema20","volumeToggle","rsiToggle","macdToggle"].forEach(id=>$(id).onchange=drawAll);
window.onresize=()=>series.length&&drawAll();
$("viewportSlider").oninput=e=>{
 const slider=$("viewportSlider"),ms=Number(e.target.value),atMax=Number(slider.max)===ms;
 viewportAnchor=atMax?null:VP.clampAnchorMs(series,ms);
 drawAll();
};
$("viewportSlider").onkeydown=e=>{
 const slider=$("viewportSlider");
 if(e.key==="Home"){e.preventDefault();slider.value=slider.min;viewportAnchor=VP.clampAnchorMs(series,Number(slider.min));drawAll()}
 else if(e.key==="End"){e.preventDefault();slider.value=slider.max;viewportAnchor=null;drawAll()}
};
$("viewportNow").onclick=()=>{viewportAnchor=null;drawAll()};

browser.storage.local.get(["theme"]).then(d=>{document.body.dataset.theme=["slate","forest","cream","terminal","midnight"].includes(d.theme)?d.theme:"slate";});
