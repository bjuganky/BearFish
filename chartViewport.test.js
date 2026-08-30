const test=require("node:test");
const assert=require("node:assert/strict");
const V=require("./chartViewport.js");

function bar(t,c=1){return{t,o:c,h:c,l:c,c,v:1}}
const MIN=60000;

test("windowDurationMs keeps a fixed span for repeated units",()=>{
 assert.equal(V.windowDurationMs(3,"minutes"),3*MIN);
 assert.equal(V.windowDurationMs(1,"hours"),3600000);
 assert.equal(V.windowDurationMs(1,"days"),86400000);
});

test("sliceViewport returns only bars inside the fixed window at the newest anchor",()=>{
 const series=[];
 for(let i=0;i<10;i++)series.push(bar(new Date(i*MIN).toISOString(),i));
 const span=V.windowDurationMs(3,"minutes");
 const res=V.sliceViewport(series,null,span);
 assert.equal(res.bars.length,3);
 assert.equal(res.bars[res.bars.length-1].c,9);
 assert.equal(res.bars[0].c,7);
});

test("sliceViewport keeps the same window width when moving to an earlier anchor",()=>{
 const series=[];
 for(let i=0;i<20;i++)series.push(bar(new Date(i*MIN).toISOString(),i));
 const span=V.windowDurationMs(3,"minutes");
 const anchor=V.barTimeMs(series[10]);
 const res=V.sliceViewport(series,anchor,span);
 assert.equal(res.bars.length,3);
 assert.equal(res.bars.map(b=>b.c).join(","),"8,9,10");
});

test("sliceViewport does not fabricate bars across gaps (market closures)",()=>{
 const series=[bar(new Date(0).toISOString(),1),bar(new Date(50*MIN).toISOString(),2)];
 const span=V.windowDurationMs(3,"minutes");
 const res=V.sliceViewport(series,V.barTimeMs(series[1]),span);
 assert.equal(res.bars.length,1);
 assert.equal(res.bars[0].c,2);
});

test("clampAnchorMs never allows an anchor before the first or after the last bar",()=>{
 const series=[bar(new Date(0).toISOString(),1),bar(new Date(10*MIN).toISOString(),2)];
 assert.equal(V.clampAnchorMs(series,-999999),V.barTimeMs(series[0]));
 assert.equal(V.clampAnchorMs(series,999999999),V.barTimeMs(series[1]));
 assert.equal(V.clampAnchorMs(series,null),V.barTimeMs(series[1]));
});

test("isAtLatest is true only when anchor is null or at/after the newest bar",()=>{
 const series=[bar(new Date(0).toISOString(),1),bar(new Date(10*MIN).toISOString(),2)];
 assert.equal(V.isAtLatest(series,null),true);
 assert.equal(V.isAtLatest(series,V.barTimeMs(series[1])),true);
 assert.equal(V.isAtLatest(series,V.barTimeMs(series[0])),false);
});

test("statusLabel prefers LIVE, then CURRENT, then LATEST at the newest position, HISTORY otherwise",()=>{
 assert.equal(V.statusLabel({atLatest:true,liveConnected:true,fresh:false}),"LIVE");
 assert.equal(V.statusLabel({atLatest:true,liveConnected:false,fresh:true}),"CURRENT");
 assert.equal(V.statusLabel({atLatest:true,liveConnected:false,fresh:false}),"LATEST");
 assert.equal(V.statusLabel({atLatest:false,liveConnected:true,fresh:true}),"HISTORY");
});

test("needsOlderData flags when the visible window reaches the oldest buffered bar",()=>{
 const series=[];
 for(let i=0;i<5;i++)series.push(bar(new Date(i*MIN).toISOString(),i));
 const span=V.windowDurationMs(3,"minutes");
 assert.equal(V.needsOlderData(series,V.barTimeMs(series[1]),span),true);
 assert.equal(V.needsOlderData(series,V.barTimeMs(series[4]),span),false);
});

test("live ticks appended while viewing history do not move a fixed anchor forward",()=>{
 const series=[];
 for(let i=0;i<10;i++)series.push(bar(new Date(i*MIN).toISOString(),i));
 const span=V.windowDurationMs(3,"minutes");
 const anchor=V.barTimeMs(series[5]);
 const before=V.sliceViewport(series,anchor,span);
 series.push(bar(new Date(10*MIN).toISOString(),10));
 series.push(bar(new Date(11*MIN).toISOString(),11));
 const after=V.sliceViewport(series,anchor,span);
 assert.deepEqual(before.bars.map(b=>b.c),after.bars.map(b=>b.c));
 assert.equal(V.isAtLatest(series,anchor),false);
});

test("returning to current (anchor=null) reflects newly accumulated bars",()=>{
 const series=[];
 for(let i=0;i<5;i++)series.push(bar(new Date(i*MIN).toISOString(),i));
 const span=V.windowDurationMs(3,"minutes");
 series.push(bar(new Date(5*MIN).toISOString(),5));
 const res=V.sliceViewport(series,null,span);
 assert.equal(res.bars[res.bars.length-1].c,5);
 assert.equal(V.isAtLatest(series,null),true);
});

test("formatRange renders a start\u2013end label using the supplied formatter",()=>{
 const label=V.formatRange(0,MIN,ms=>String(ms));
 assert.equal(label,`0 \u2013 ${MIN}`);
 assert.equal(V.formatRange(NaN,1,ms=>String(ms)),"");
});
