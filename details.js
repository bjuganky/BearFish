const $=id=>document.getElementById(id), p=new URLSearchParams(location.search), symbol=(p.get("symbol")||"AAPL").toUpperCase();
let range="1M",view="candle",series=[],apiKey="";
const cfg={"1D":["5min",78],"5D":["30min",80],"1M":["1day",30],"3M":["1day",90],"1Y":["1day",260]};
$("symbol").textContent=symbol;
function sma(a,n){let o=Array(a.length).fill(null),s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=n)s-=a[i-n];if(i>=n-1)o[i]=s/n}return o}
function ema(a,n){let o=Array(a.length).fill(null),k=2/(n+1),v=a[0];for(let i=0;i<a.length;i++){v=i? a[i]*k+v*(1-k):a[i];if(i>=n-1)o[i]=v}return o}
function rsi(a,n=14){let o=Array(a.length).fill(null);if(a.length<=n)return o;let g=0,l=0;for(let i=1;i<=n;i++){let d=a[i]-a[i-1];if(d>=0)g+=d;else l-=d}g/=n;l/=n;o[n]=l===0?100:100-(100/(1+g/l));for(let i=n+1;i<a.length;i++){let d=a[i]-a[i-1];g=(g*(n-1)+Math.max(d,0))/n;l=(l*(n-1)+Math.max(-d,0))/n;o[i]=l===0?100:100-(100/(1+g/l))}return o}
function macd(a){const e12=ema(a,12),e26=ema(a,26),m=a.map((_,i)=>Number.isFinite(e12[i])&&Number.isFinite(e26[i])?e12[i]-e26[i]:null),clean=m.map(v=>v??0),sig=ema(clean,9).map((v,i)=>m[i]===null?null:v),hist=m.map((v,i)=>v!==null&&sig[i]!==null?v-sig[i]:null);return{m,sig,hist}}
function money(v){const n=Number(v);return Number.isFinite(n)?n.toLocaleString(undefined,{style:"currency",currency:"USD",maximumFractionDigits:2}):"—"}
async function load(){
 const d=await browser.storage.local.get(["apiKey"]);apiKey=d.apiKey||"";if(!apiKey){$("chartStatus").textContent="Add your API key from the BearFish popup first.";return}
 $("loadBtn").disabled=true;$("chartStatus").textContent="Loading…";
 try{const [interval,size]=cfg[range],u=new URL("https://api.twelvedata.com/time_series");u.searchParams.set("symbol",symbol);u.searchParams.set("interval",interval);u.searchParams.set("outputsize",size);u.searchParams.set("apikey",apiKey);
  const r=await fetch(u),x=await r.json();if(!r.ok||x.status==="error"||!Array.isArray(x.values))throw Error(x.message||"Unable to load data");
  series=[...x.values].reverse().map(v=>({t:v.datetime,o:+v.open,h:+v.high,l:+v.low,c:+v.close,v:+(v.volume||0)})).filter(x=>[x.o,x.h,x.l,x.c].every(Number.isFinite));
  $("meta").textContent=`${x.meta?.interval||interval} · ${series.length} bars`;$("last").textContent=money(series.at(-1)?.c);
  const ch=series.length>1?(series.at(-1).c-series[0].c)/series[0].c*100:NaN;$("change").textContent=Number.isFinite(ch)?`${ch>=0?"+":""}${ch.toFixed(2)}%`:"—";
  $("volume").textContent=series.at(-1)?.v?Math.round(series.at(-1).v).toLocaleString():"—";$("chartStatus").textContent="";drawAll();
 }catch(e){$("chartStatus").textContent=e.message}finally{$("loadBtn").disabled=false}
}
function prep(canvas,h){const d=devicePixelRatio||1,w=canvas.clientWidth||900;canvas.width=w*d;canvas.height=h*d;const c=canvas.getContext("2d");c.setTransform(d,0,0,d,0,0);c.clearRect(0,0,w,h);return[c,w,h]}
function drawLine(c,arr,x,y,color,width=1.3){c.strokeStyle=color;c.lineWidth=width;c.beginPath();let started=false;arr.forEach((v,i)=>{if(!Number.isFinite(v))return;started?c.lineTo(x(i),y(v)):c.moveTo(x(i),y(v));started=true});c.stroke()}
function drawMain(){
 const canvas=$("chart"),[c,w,h]=prep(canvas,500),pad={l:52,r:14,t:14,b:24},volOn=$("volumeToggle").checked;if(series.length<2)return;
 const closes=series.map(x=>x.c), overlays=[];if($("sma20").checked)overlays.push(["SMA20",sma(closes,20),"#9ba7b5"]);if($("sma50").checked)overlays.push(["SMA50",sma(closes,50),"#d1b777"]);if($("ema20").checked)overlays.push(["EMA20",ema(closes,20),"#8ca3d7"]);
 const vals=series.flatMap(x=>[x.h,x.l]).concat(overlays.flatMap(o=>o[1].filter(Number.isFinite)));let min=Math.min(...vals),max=Math.max(...vals),span=max-min||1;min-=span*.04;max+=span*.04;
 const priceBottom=volOn?h*.79:h-pad.b,x=i=>pad.l+i/(series.length-1)*(w-pad.l-pad.r),y=v=>pad.t+(max-v)/(max-min)*(priceBottom-pad.t);
 c.strokeStyle="#24282d";c.lineWidth=1;c.fillStyle="#7f858d";c.font="10px Arial";for(let i=0;i<5;i++){let yy=pad.t+i*(priceBottom-pad.t)/4;c.beginPath();c.moveTo(pad.l,yy);c.lineTo(w-pad.r,yy);c.stroke();let val=max-i*(max-min)/4;c.fillText(val.toFixed(2),4,yy+3)}
 if(view==="line")drawLine(c,closes,x,y,"#d7d9dc",1.6);else{const spacing=(w-pad.l-pad.r)/Math.max(1,series.length-1);const bw=Math.max(4,Math.min(18,spacing*.9));series.forEach((q,i)=>{const xx=x(i),up=q.c>=q.o,col=up?"#57bd7c":"#dc6b72";c.strokeStyle=col;c.fillStyle=col;c.lineWidth=1;c.beginPath();c.moveTo(xx,y(q.h));c.lineTo(xx,y(q.l));c.stroke();const top=Math.min(y(q.o),y(q.c)),bh=Math.max(1,Math.abs(y(q.o)-y(q.c)));c.fillRect(xx-bw/2,top,bw,bh)})}
 overlays.forEach(o=>drawLine(c,o[1],x,y,o[2],1.2));
 if(volOn){const vmax=Math.max(...series.map(q=>q.v),1),base=h-pad.b,top=h*.82;c.strokeStyle="#24282d";c.beginPath();c.moveTo(pad.l,top);c.lineTo(w-pad.r,top);c.stroke();series.forEach((q,i)=>{const bh=(q.v/vmax)*(base-top),bw=Math.max(1,(w-pad.l-pad.r)/series.length*.55);c.fillStyle=q.c>=q.o?"#355f47":"#643b40";c.fillRect(x(i)-bw/2,base-bh,bw,bh)})}
}
function drawRSI(){
 const panel=$("rsiPanel");panel.classList.toggle("hidden",!$("rsiToggle").checked);if(!$("rsiToggle").checked||series.length<2)return;
 const vals=rsi(series.map(x=>x.c)),[c,w,h]=prep($("rsiChart"),150),pad={l:52,r:14,t:10,b:18},x=i=>pad.l+i/(series.length-1)*(w-pad.l-pad.r),y=v=>pad.t+(100-v)/100*(h-pad.t-pad.b);
 c.strokeStyle="#292d32";[30,50,70].forEach(v=>{c.beginPath();c.moveTo(pad.l,y(v));c.lineTo(w-pad.r,y(v));c.stroke();c.fillStyle="#777d85";c.font="9px Arial";c.fillText(String(v),18,y(v)+3)});drawLine(c,vals,x,y,"#b7a2d8",1.2);const last=[...vals].reverse().find(Number.isFinite);$("rsiValue").textContent=Number.isFinite(last)?last.toFixed(1):"—";
}
function drawMACD(){
 const panel=$("macdPanel");panel.classList.toggle("hidden",!$("macdToggle").checked);if(!$("macdToggle").checked||series.length<2)return;
 const z=macd(series.map(x=>x.c)),valid=z.m.concat(z.sig,z.hist).filter(Number.isFinite),[c,w,h]=prep($("macdChart"),150),pad={l:52,r:14,t:10,b:18};if(!valid.length)return;let min=Math.min(...valid,0),max=Math.max(...valid,0),span=max-min||1;min-=span*.1;max+=span*.1;const x=i=>pad.l+i/(series.length-1)*(w-pad.l-pad.r),y=v=>pad.t+(max-v)/(max-min)*(h-pad.t-pad.b);
 c.strokeStyle="#30343a";c.beginPath();c.moveTo(pad.l,y(0));c.lineTo(w-pad.r,y(0));c.stroke();const spacing=(w-pad.l-pad.r)/Math.max(1,series.length-1);const bw=Math.max(3,Math.min(16,spacing*.82));z.hist.forEach((v,i)=>{if(!Number.isFinite(v))return;c.fillStyle=v>=0?"#355f47":"#643b40";const yy=y(v),zero=y(0);c.fillRect(x(i)-bw/2,Math.min(yy,zero),bw,Math.max(1,Math.abs(zero-yy)))});drawLine(c,z.m,x,y,"#aab3c0",1.2);drawLine(c,z.sig,x,y,"#c9a76a",1.1);const last=[...z.m].reverse().find(Number.isFinite);$("macdValue").textContent=Number.isFinite(last)?last.toFixed(3):"—";
}
function drawAll(){drawMain();drawRSI();drawMACD()}
$("loadBtn").onclick=load;
document.querySelectorAll("[data-range]").forEach(b=>b.onclick=()=>{range=b.dataset.range;document.querySelectorAll("[data-range]").forEach(x=>x.classList.toggle("active",x===b));series=[];$("chartStatus").textContent="Range changed — load data.";drawAll()});
document.querySelectorAll("[data-view]").forEach(b=>b.onclick=()=>{view=b.dataset.view;document.querySelectorAll("[data-view]").forEach(x=>x.classList.toggle("active",x===b));drawMain()});
["sma20","sma50","ema20","volumeToggle","rsiToggle","macdToggle"].forEach(id=>$(id).onchange=drawAll);
window.onresize=()=>series.length&&drawAll();

browser.storage.local.get(["theme"]).then(d=>{document.body.dataset.theme=["slate","forest","cream","terminal","midnight"].includes(d.theme)?d.theme:"slate";});
