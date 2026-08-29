const $=id=>document.getElementById(id);
const params=new URLSearchParams(location.search),symbol=(params.get("symbol")||"AAPL").toUpperCase();
const BUILTINS={
 "Clean":{sma:{enabled:false,period:20},ema:{enabled:false,period:20},volume:true,rsi:{enabled:false,period:14},macd:{enabled:false,fast:12,slow:26,signal:9}},
 "Trend":{sma:{enabled:true,period:50},ema:{enabled:true,period:20},volume:true,rsi:{enabled:false,period:14},macd:{enabled:false,fast:12,slow:26,signal:9}},
 "Momentum":{sma:{enabled:false,period:20},ema:{enabled:true,period:12},volume:true,rsi:{enabled:true,period:14},macd:{enabled:true,fast:12,slow:26,signal:9}},
 "Full":{sma:{enabled:true,period:20},ema:{enabled:true,period:20},volume:true,rsi:{enabled:true,period:14},macd:{enabled:true,fast:12,slow:26,signal:9}}
};
let prefs={},customPresets={},theme="slate";
$("symbol").textContent=symbol;

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
 const d=await browser.storage.local.get(["stockPrefs","indicatorPresets","theme"]);
 prefs=d.stockPrefs&&typeof d.stockPrefs==="object"?d.stockPrefs:{};
 customPresets=d.indicatorPresets&&typeof d.indicatorPresets==="object"?d.indicatorPresets:{};
 theme=["slate","forest","cream","terminal","midnight"].includes(d.theme)?d.theme:"slate";
 document.body.dataset.theme=theme;renderForm();renderPresets();
})();
