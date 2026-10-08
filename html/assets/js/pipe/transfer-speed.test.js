import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransferRate, createSpeedReadout, formatTransferSpeed } from './transfer-speed.js';

test('decimal byte units adapt and invalid rates never print NaN/Infinity', () => {
  assert.equal(formatTransferSpeed(0), '0 B/s');
  assert.equal(formatTransferSpeed(999), '999 B/s');
  assert.equal(formatTransferSpeed(1500), '1.50 KB/s');
  assert.equal(formatTransferSpeed(25000000), '25.0 MB/s');
  assert.equal(formatTransferSpeed(1200000000), '1.20 GB/s');
  for (const value of [NaN, Infinity, -1, undefined, null]) assert.equal(formatTransferSpeed(value), '—');
});
test('known byte/time deltas, meaningful startup sample and stable rolling window', () => {
  let time=0;const meter=createTransferRate({now:()=>time});
  assert.equal(meter.rate(),null);meter.update(100);assert.equal(meter.rate(),null);
  time=250;meter.update(250000);assert.equal(meter.rate(),1000000);
  for(time=500;time<=3000;time+=250){meter.update(time*1000);assert.equal(meter.rate(),1000000);}
  time=3250;meter.update(3500000);assert.equal(meter.rate(),1125000);
});
test('stalled transfers age to zero without any new progress callback', () => {
  let time=0;const meter=createTransferRate({now:()=>time});
  time=250;meter.update(250000);assert.equal(meter.rate(),1000000);
  time=1000;assert.equal(meter.rate(),250000);
  time=2250;assert.equal(meter.rate(),0);
  time=10000;assert.equal(meter.rate(),0);
});
test('resume baseline excludes retained bytes and file counters reset', () => {
  let time=0;const meter=createTransferRate({now:()=>time});
  meter.reset(10000000);time=500;meter.update(10500000);assert.equal(meter.rate(),1000000);
  meter.reset(0);time=1000;meter.update(1000);assert.equal(meter.rate(),2000);
  time=1100;meter.update(0);assert.equal(meter.rate(),null);
  time=1600;meter.update(500);assert.equal(meter.rate(),1000);
});
test('empty, short, invalid and non-monotonic clock inputs remain finite or unknown', () => {
  let time=0;const meter=createTransferRate({now:()=>time});
  assert.equal(meter.average(),0);meter.update(100);assert.equal(meter.average(),null);
  for(const bytes of [NaN,Infinity,-1])meter.update(bytes);
  time=500;assert.equal(meter.average(),200);
  time=-1;assert.equal(meter.rate(),null);
  assert.equal(meter.rate(Infinity),null);
});
function fixture(){
  let time=0,id=0;const timers=new Map(),renders=[];
  const controller=createSpeedReadout(state=>renders.push({...state}),{now:()=>time,
    schedule:fn=>{timers.set(++id,fn);return id;},unschedule:key=>timers.delete(key)});
  return{controller,timers,renders,advance(ms){time+=ms;for(const fn of [...timers.values()])fn();}};
}
test('live rendering is timer bounded, ages stalls, and completion stops timer', () => {
  const f=fixture(),run=f.controller.begin('queued');run.startFile();
  const count=f.renders.length;
  for(let i=1;i<=10000;i++)run.update(i);
  assert.equal(f.renders.length,count);f.advance(250);
  assert.equal(f.renders.at(-1).rate,40000);f.advance(2000);assert.equal(f.renders.at(-1).rate,0);
  run.finish();assert.equal(f.timers.size,0);assert.equal(f.renders.at(-1).phase,'complete');
  assert.ok(Number.isFinite(f.renders.at(-1).rate));
});
test('cancel/retry ignores old callbacks and file/fallback resets never leak old rate', () => {
  const f=fixture(),old=f.controller.begin('queued');old.startFile();old.update(1000);f.advance(250);
  f.controller.cancel();assert.equal(f.timers.size,0);assert.equal(f.renders.at(-1).visible,false);
  const current=f.controller.begin('receive');current.startFile(9000);current.update(10000);f.advance(250);
  const state=f.renders.at(-1),count=f.renders.length;
  old.update(999999);old.startFile();old.finish();old.unavailable();old.cancel();
  assert.equal(f.renders.length,count);assert.deepEqual(f.renders.at(-1),state);
  current.startFile(0,'upload');assert.equal(f.timers.size,1);assert.equal(f.renders.at(-1).rate,null);
  current.unavailable('download');assert.equal(f.timers.size,0);assert.equal(f.renders.at(-1).phase,'unavailable');
});
test('independent send/receive controllers, empty finish and language refresh', () => {
  const send=fixture(),recv=fixture();const s=send.controller.begin('queued'),r=recv.controller.begin('receive');
  s.startFile();r.startFile();s.update(1000);send.advance(250);recv.advance(250);
  assert.equal(send.renders.at(-1).rate,4000);assert.equal(recv.renders.at(-1).rate,0);
  r.finish();assert.equal(recv.renders.at(-1).rate,0);assert.equal(send.timers.size,1);
  const count=send.renders.length;send.controller.refresh();assert.equal(send.renders.length,count+1);
  send.controller.cancel();assert.equal(send.timers.size,0);
});

// Exercise the actual HTTP UI handler so the new meter cannot break upload
// completion, errors or cancellation. This makes no network requests.
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const app=await readFile(new URL('./app.js',import.meta.url),'utf8');
const httpSource=app.slice(app.indexOf('function sendHTTP('),app.indexOf('\nfunction resetSend'));
function httpFixture(){
  let xhr;const calls=[],els=new Map();
  class FakeXHR{constructor(){xhr=this;this.upload={};}open(){}setRequestHeader(){}send(){}}
  const context=vm.createContext({XMLHttpRequest:FakeXHR,PIPE:'http://example.invalid',_sendXHR:null,
    performance:{now:()=>1000},document:{getElementById:id=>{if(!els.has(id))els.set(id,{style:{},textContent:''});return els.get(id);}},
    t:()=>()=>'',fmt:String,setStatus(){},_sendEnd(){},reportTransfer(){}});
  vm.runInContext(httpSource,context);
  const speed={startFile:(...a)=>calls.push(['start',...a]),update:b=>calls.push(['update',b]),finish:()=>calls.push(['finish']),cancel:()=>calls.push(['cancel'])};
  const start=()=>context.sendHTTP({size:4000,name:'synthetic.bin'},'synthetic',0,1,speed);
  return{start,calls,get xhr(){return xhr;}};
}
test('HTTP upload rate follows observable progress and finishes without shadowing the meter',async()=>{
  const f=httpFixture(),done=f.start();
  f.xhr.upload.onprogress({loaded:2000,total:4000,lengthComputable:true});f.xhr.status=200;f.xhr.onload();await done;
  assert.deepEqual(f.calls,[['start',0,'upload'],['update',2000],['update',4000],['finish']]);
});
test('HTTP error and abort stop the meter; unknown total still has observable byte rate',async()=>{
  const f=httpFixture(),done=f.start(),failed=assert.rejects(done,/HTTP upload failed/);
  f.xhr.upload.onprogress({loaded:100,lengthComputable:false});f.xhr.status=500;f.xhr.onload();await failed;
  assert.deepEqual(f.calls,[['start',0,'upload'],['update',100],['cancel']]);
  const a=httpFixture(),aborted=a.start();a.xhr.onabort();await aborted;assert.equal(a.calls.at(-1)[0],'cancel');
});

test('actual startSend rejects an old P2P failure after Cancel and immediate retry',async()=>{
  const code=app.slice(app.indexOf('async function startSend()'),app.indexOf('// Upload via piping-server'));
  const pending=[],statuses=[],f=fixture();let uploads=0;
  const els=new Map();const element=id=>{if(!els.has(id))els.set(id,{style:{display:''},textContent:'',classList:{contains:()=>false,add(){},remove(){}}});return els.get(id);};
  const context=vm.createContext({sendSpeed:f.controller,selFiles:[{file:{size:1},path:'synthetic'}],
    _sendPC:null,_sendXHR:null,PIPE_MAX_SIZE:1000,document:{getElementById:element},
    _sendStart:()=>{element('cancel-send-btn').style.display='';},_sendEnd:()=>{element('cancel-send-btn').style.display='none';},
    setStatus:(...a)=>statuses.push(a),t:()=>()=>'',fmt:String,
    trySendWebRTCFiles:(...args)=>new Promise(resolve=>pending.push({args,resolve})),sendHTTP:async()=>{uploads++;}});
  vm.runInContext(code,context);
  const old=context.startSend();f.controller.cancel();element('cancel-send-btn').style.display='none';
  const fresh=context.startSend();const count=statuses.length;
  pending[0].args[1](0,1,1);pending[0].args[2](0);pending[0].args[3](1,1);pending[0].args[4]();
  assert.equal(statuses.length,count);pending[0].resolve(false);await old;
  assert.equal(uploads,0);assert.equal(f.renders.at(-1).mode,'queued');
  pending[1].args[5](0,0,1);assert.equal(f.timers.size,1);
  pending[1].resolve(true);await fresh;f.controller.cancel();
});
test('unavailable handoff remains owned for status guards but rejects late data/file callbacks',()=>{
  const f=fixture(),run=f.controller.begin('receive');run.startFile();run.unavailable('download');
  assert.equal(run.isCurrent(),true);const count=f.renders.length;
  run.startFile();run.update(4000);run.finish();assert.equal(f.renders.length,count);assert.equal(f.timers.size,0);
  f.controller.begin('receive');assert.equal(run.isCurrent(),false);
});
test('hiding a readout for another mode does not cancel transfer ownership',()=>{
  const f=fixture(),run=f.controller.begin('receive');run.startFile();f.controller.hide();
  assert.equal(run.isCurrent(),true);assert.equal(f.renders.at(-1).visible,false);assert.equal(f.timers.size,0);
  const count=f.renders.length;run.startFile();run.update(900);run.finish();assert.equal(f.renders.length,count);
});
test('actual receive still delivers bytes after an alternate mode hides its speed row',async()=>{
  const code=app.slice(app.indexOf('async function startReceive('),app.indexOf('// Receive multiple files arriving'));
  const f=fixture();let args,resolve,downloads=0,ended=0;
  const context=vm.createContext({recvSpeed:f.controller,parsePath:x=>x,
    document:{getElementById:()=>({value:'synthetic',style:{display:''}})},
    _recvStart(){},_recvEnd(){ended++;},setRecvSender(){},setStatus(){},t:()=>()=>'',
    tryRecvWebRTC:(...a)=>{args=a;return new Promise(r=>{resolve=r;});},
    triggerDownload(){downloads++;}});
  vm.runInContext(code,context);const task=context.startReceive();
  f.controller.hide();args[2]('done',new Blob(['bytes']),'synthetic.bin');resolve(true);await task;
  assert.equal(downloads,1);assert.equal(ended,1);assert.equal(f.renders.at(-1).visible,false);
});
