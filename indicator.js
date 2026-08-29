const $=id=>document.getElementById(id);
const params=new URLSearchParams(location.search),symbol=(params.get("symbol")||"AAPL").toUpperCase();
const BUILTINS={
 "Clean":{sma:{enabled:false,period:20},ema:{enabled:false,period:20},volume:true,rsi:{enabled:false,period:14},macd:{enabled:false,fast:12,slow:26,signal:9}},
 "Trend":{sma:{enabled:true,period:50},ema:{enabled:true,period:20},volume:true,rsi:{enabled:false,period:14},macd:{enabled:false,fast:12,slow:26,signal:9}},
 "Momentum":{sma:{enabled:false,period:20},ema:{enabled:true,period:12},volume:true,rsi:{enabled:true,period:14},macd:{enabled:true,fast:12,slow:26,signal:9}},
 "Full":{sma:{enabled:true,period:20},ema:{enabled:true,period:20},volume:true,rsi:{enabled:true,period:14},macd:{enabled:true,fast:12,slow:26,signal:9}}
};
let prefs={},customPresets={},theme="slate",alertsStore={};
$("symbol").textContent=symbol;

function alertsForSymbol(){return alertsStore[symbol]||[]}
function renderAlerts(){
 const list=alertsForSymbol();
 const ul=$("alertList");ul.textContent="";
 $("alertEmpty").classList.toggle("hidden",list.length>0);
 list.forEach(a=>{
  const li=document.createElement("li");li.className="alert-row";
  const desc=document.createElement("span");desc.className="alert-desc";desc.textContent=BearFishAlerts.describeAlert(a);
  const toggle=document.createElement("label");toggle.className="switch";
  const cb=document.createElement("input");cb.type="checkbox";cb.checked=a.enabled;
  cb.onchange=async()=>{a.enabled=cb.checked;await saveAlerts();$("status").textContent=`${a.enabled?"Enabled":"Disabled"} alert for ${symbol}.`};
  toggle.append(cb);
  const del=document.createElement("button");del.textContent="delete";
  del.onclick=async()=>{alertsStore[symbol]=alertsForSymbol().filter(x=>x.id!==a.id);await saveAlerts();renderAlerts();$("status").textContent=`Deleted alert for ${symbol}.`};
  li.append(desc,toggle,del);ul.append(li)
 });
}
async function saveAlerts(){await browser.storage.local.set({stockAlerts:alertsStore})}
$("addAlertBtn").onclick=async()=>{
 const input={
  type:$("alertType").value,
  value:$("alertValue").value,
  rsiPeriod:$("alertRsiPeriod").value
 };
 const check=BearFishAlerts.validateAlertInput(input);
 if(!check.ok){$("alertStatus").textContent=check.error;return}
 const list=alertsForSymbol();
 if(list.length>=10){$("alertStatus").textContent="Delete an alert before adding another.";return}
 list.push(check.alert);alertsStore[symbol]=list;
 await saveAlerts();renderAlerts();
 $("alertValue").value="";$("alertStatus").textContent="";$("status").textContent=`Added alert for ${symbol}.`
};
$("alertType").addEventListener("change",()=>{
 const isRsi=BearFishAlerts.isRsiType($("alertType").value);
 $("alertRsiPeriod").classList.toggle("hidden",!isRsi)
});

function defaults(){return{sma:{enabled:false,period:20},ema:{enabled:false,period:20},volume:true,rsi:{enabled:false,period:14},macd:{enabled:false,fast:12,slow:26,signal:9}}}
function ensure(){
 if(!prefs[symbol])prefs[symbol]={windowValue:1,windowUnit:"months",barInterval:"auto",view:"candle",...defaults()};
 const p=prefs[symbol];
 if(typeof p.sma==="undefined")p.sma={enabled:false,period:20};
 if(typeof p.ema==="undefined")p.ema={enabled:false,period:20};
 if(typeof p.rsi!=="object")p.rsi={enabled:!!p.rsi,period:14};
 if(typeof p.macd!=="object")p.macd={enabled:!!p.macd,fast:12,slow:26,signal:9};
}
function renderForm(){
 ensure();const p=prefs[symbol];
 $("smaEnabled").checked=p.sma.enabled;$("smaPeriod").value=p.sma.period;
 $("emaEnabled").checked=p.ema.enabled;$("emaPeriod").value=p.ema.period;
 $("volumeEnabled").checked=p.volume;
 $("rsiEnabled").checked=p.rsi.enabled;$("rsiPeriod").value=p.rsi.period;
 $("macdEnabled").checked=p.macd.enabled;$("macdFast").value=p.macd.fast;$("macdSlow").value=p.macd.slow;$("macdSignal").value=p.macd.signal;
}
function renderPresets(){
 const s=$("presetSelect"),keep=s.value;s.textContent="";
 const group1=document.createElement("optgroup");group1.label="Built-in";
 Object.keys(BUILTINS).forEach(n=>{const o=document.createElement("option");o.value="builtin:"+n;o.textContent=n;group1.append(o)});
 s.append(group1);
 const names=Object.keys(customPresets);
 if(names.length){const g=document.createElement("optgroup");g.label="My presets";names.forEach(n=>{const o=document.createElement("option");o.value="custom:"+n;o.textContent=n;g.append(o)});s.append(g)}
 if([...s.options].some(o=>o.value===keep))s.value=keep
}
function currentConfig(){
 return{
  sma:{enabled:$("smaEnabled").checked,period:Math.max(2,Math.min(500,+$("smaPeriod").value||20))},
  ema:{enabled:$("emaEnabled").checked,period:Math.max(2,Math.min(500,+$("emaPeriod").value||20))},
  volume:$("volumeEnabled").checked,
  rsi:{enabled:$("rsiEnabled").checked,period:Math.max(2,Math.min(100,+$("rsiPeriod").value||14))},
  macd:{enabled:$("macdEnabled").checked,fast:Math.max(2,+$("macdFast").value||12),slow:Math.max(3,+$("macdSlow").value||26),signal:Math.max(2,+$("macdSignal").value||9)}
 }
}
async function save(){
 ensure();Object.assign(prefs[symbol],currentConfig());
 await browser.storage.local.set({stockPrefs:prefs});
 $("status").textContent="Saved for "+symbol+".";
}
["smaEnabled","smaPeriod","emaEnabled","emaPeriod","volumeEnabled","rsiEnabled","rsiPeriod","macdEnabled","macdFast","macdSlow","macdSignal"].forEach(id=>$(id).addEventListener("change",save));
document.querySelectorAll(".help").forEach(b=>b.onclick=()=>{$("help-"+b.dataset.help).classList.toggle("hidden")});
$("applyPresetBtn").onclick=async()=>{
 const [kind,name]=$("presetSelect").value.split(":");
 const src=kind==="builtin"?BUILTINS[name]:customPresets[name];
 if(!src)return;
 ensure();Object.assign(prefs[symbol],JSON.parse(JSON.stringify(src)));
 await browser.storage.local.set({stockPrefs:prefs});
 renderForm();$("status").textContent=`Applied ${name} to ${symbol}.`;
};
$("savePresetBtn").onclick=async()=>{
 const name=$("presetName").value.trim().slice(0,24);if(!name)return;
 customPresets[name]=currentConfig();
 await browser.storage.local.set({indicatorPresets:customPresets});
 renderPresets();$("presetSelect").value="custom:"+name;$("status").textContent=`Saved preset "${name}".`;
};
$("deletePresetBtn").onclick=async()=>{
 const [kind,name]=$("presetSelect").value.split(":");if(kind!=="custom"){$("status").textContent="Built-in presets cannot be deleted.";return}
 delete customPresets[name];await browser.storage.local.set({indicatorPresets:customPresets});renderPresets();$("status").textContent=`Deleted preset "${name}".`;
};
$("closeBtn").onclick=()=>window.close();

(async()=>{
 const d=await browser.storage.local.get(["stockPrefs","indicatorPresets","theme","stockAlerts"]);
 prefs=d.stockPrefs&&typeof d.stockPrefs==="object"?d.stockPrefs:{};
 customPresets=d.indicatorPresets&&typeof d.indicatorPresets==="object"?d.indicatorPresets:{};
 theme=["slate","forest","cream","terminal","midnight"].includes(d.theme)?d.theme:"slate";
 alertsStore=BearFishAlerts.sanitizeStore(d.stockAlerts);
 document.body.dataset.theme=theme;renderForm();renderPresets();renderAlerts();
 $("alertRsiPeriod").classList.toggle("hidden",!BearFishAlerts.isRsiType($("alertType").value));
})();
