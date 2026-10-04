import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { localChromiumOptions } from './lib/local-chromium.mjs';
const out=path.resolve(process.env.AFJK_SKYBOX_OUTPUT || 'logs/skybox-swap-browser-smoke');
const origin=process.env.AFJK_WEB_ORIGIN || 'http://127.0.0.1:8888';
const presence=process.env.AFJK_PRESENCE_URL || 'ws://127.0.0.1:8787';
for(const url of [origin,presence]) assert.ok(['localhost','127.0.0.1'].includes(new URL(url).hostname));
await mkdir(out,{recursive:true});
const phase=process.env.AFJK_SKYBOX_PHASE || 'all';
assert.ok(['all','failures','races'].includes(phase));
const result={phase,checks:[],errors:[],security:{chromiumSandbox:true,ignoreHTTPSErrors:false},states:{}};
const browser=await chromium.launch(localChromiumOptions());
const pages=[];const gates=[];
const wait=(p,fn,arg)=>p.waitForFunction(fn,arg,{timeout:45000});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const pass=name=>{result.checks.push(name);console.log('PASS',name);};
const skyState=p=>p.evaluate(()=>window.__sceneSyncDebug.objects.list().map(id=>window.__sceneSyncDebug.objects.get(id)).filter(o=>o.asset?.source==='generated-skybox'));
const expectedIds=new Map();
async function expectSky(p,letter){
 const expectedId=p.testClientName==='receiver'?expectedIds.get(letter):null;
 await wait(p,({letter,expectedId})=>{
  const s=window.__sceneSyncDebug.objects.list().map(id=>window.__sceneSyncDebug.objects.get(id)).filter(o=>o.asset?.source==='generated-skybox');
  return s.length===1&&s[0].visible&&s[0].name.includes(`panorama-${letter}.png`)&&(!expectedId||s[0].objectId===expectedId);
 },{letter,expectedId});
 if(p.testClientName==='presenter') expectedIds.set(letter,(await skyState(p))[0].objectId);
}
async function expectEmpty(p){await wait(p,()=>window.__sceneSyncDebug.objects.list().map(id=>window.__sceneSyncDebug.objects.get(id)).filter(o=>o.asset?.source==='generated-skybox').length===0);}
async function shot(p,name){result.states[name]=await skyState(p);await p.screenshot({path:`${out}/${name}.png`});}
async function open(name,room,{mobile=false,shell='editor'}={}){
 const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1100,height:760},isMobile:mobile,hasTouch:true,ignoreHTTPSErrors:false,...(mobile?{userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'}:{})});
 await context.addInitScript(name=>{localStorage.setItem('sceneSync.welcomeSeen','true');localStorage.setItem('sceneSync.displayName',name);},name);
 const p=await context.newPage();p.testClientName=name;pages.push(p);p.setDefaultTimeout(20000);
 p.on('console',m=>{if(m.type()==='warn'&&/skybox|Failed to load mesh/.test(m.text()))console.log('EXPECTED/DIAGNOSTIC',name,m.text().slice(0,200));});
 p.on('pageerror',e=>{result.errors.push({name,error:e.message});console.log('PAGEERROR',name,e.message);});
 await p.goto(`${origin}/scenesync/?dev=1&shell=${shell}&room=${room}&presence=${encodeURIComponent(presence)}`,{waitUntil:'domcontentloaded',timeout:60000});
 await wait(p,()=>window.__sceneSyncDebug?.getRoomLifecycle().ready);
 return p;
}
async function choose(p,letter){
 if(!await p.locator('#mobile-env-sheet').isVisible()) {
  await p.locator('#add-btn').tap();await pause(250);
  await p.locator('#mobile-env-open-btn').tap();await pause(250);
 }
 const [chooser]=await Promise.all([p.waitForEvent('filechooser'),p.locator('#mobile-set-skybox-btn').tap()]);
 await chooser.setFiles(`${out}/panorama-${letter}.png`);
}
async function gateDownload(p,{fail=false,method='GET',pattern='**/presence/blob/*'}={}){
 let signal,release;const started=new Promise(r=>{signal=r;});const held=new Promise(r=>{release=r;});
 const requests=[];let accepting=true;
 const handler=async route=>{
  if(!accepting || route.request().method()!==method){await route.continue();return;}
  requests.push(route.request().url());signal();await held;
  await (fail?route.fulfill(fail==='decode'
    ? {status:200,contentType:'model/gltf-binary',body:'invalid GLB: deliberate local decode failure'}
    : {status:404,body:'deliberate local test failure'}):route.continue()).catch(()=>{});
 };
 await p.route(pattern,handler);
 const gate={started,requests,release,bypass(){accepting=false;},async remove(){release();await p.unroute(pattern,handler);}};gates.push(gate);return gate;
}
async function clear(p){const epoch=await p.evaluate(()=>window.__sceneSyncDebug.getRoomLifecycle().epoch);await p.locator('#editor-scene-menu summary').click();await p.locator('#editor-scene-clear').click();await wait(p,e=>window.__sceneSyncDebug.getRoomLifecycle().ready&&window.__sceneSyncDebug.getRoomLifecycle().epoch!==e,epoch);}
try{
 const security=await browser.newPage();await security.goto('chrome://sandbox');result.security.status=await security.locator('body').innerText();assert.match(result.security.status,/You are adequately sandboxed/);
 for(const [letter,color] of [['A','#147951'],['B','#9b245e'],['C','#246ab9']]){
  const png=await security.evaluate(({letter,color})=>{const c=document.createElement('canvas');c.width=2048;c.height=1024;const x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,c.width,c.height);x.fillStyle='#ffffff';x.font='bold 90px sans-serif';for(let i=0;i<4;i++){x.fillText(`PANORAMA ${letter}`,i*512+15,460);x.fillText(['N','E','S','W'][i],i*512+210,650);}x.fillRect(0,512,2048,8);return c.toDataURL('image/png').split(',')[1];},{letter,color});
  await writeFile(`${out}/panorama-${letter}.png`,Buffer.from(png,'base64'));
 }
 await security.close();
 const room=`sky-${Date.now().toString(36)}`;result.room=room;
 const a=await open('presenter',room,{mobile:true});await choose(a,'A');await expectSky(a,'A');
 const b=await open('receiver',room,{shell:'viewer'});await expectSky(b,'A');
 await shot(a,'initial-A-presenter');await shot(b,'initial-A-receiver');pass('initial panorama file picker and late-joining second client');
 if(phase!=='races') {
 const local=await gateDownload(a),remote=await gateDownload(b);
 await choose(a,'B');await local.started;await expectSky(a,'A');await expectSky(b,'A');await shot(a,'local-loading-keeps-A');
 local.release();await expectSky(a,'B');await remote.started;await expectSky(b,'A');await shot(b,'remote-loading-keeps-A');
 remote.release();await expectSky(b,'B');await local.remove();await remote.remove();await shot(b,'replacement-B');pass('both clients keep A until their own B load is ready');
 // Local failure must neither remove B nor broadcast a replacement to the receiver.
 const failure=await gateDownload(a,{fail:true});await choose(a,'C');await failure.started;failure.release();
 await wait(a,()=>document.body.innerText.includes('前の背景を保持しています'));await expectSky(a,'B');await expectSky(b,'B');await failure.remove();await shot(a,'local-failure-keeps-B');pass('local failed load keeps B in both clients');
 const corrupt=await gateDownload(a,{fail:'decode'});
 await wait(a,()=>!document.querySelector('#toast').classList.contains('show'));
 await choose(a,'C');await corrupt.started;corrupt.release();
 await wait(a,()=>document.querySelector('#toast').classList.contains('show')&&document.querySelector('#toast').textContent.includes('前の背景を保持しています'));
 await expectSky(a,'B');await expectSky(b,'B');await corrupt.remove();pass('malformed GLB cannot replace the previous background');
 // Receiver failure preserves its last good sky while the presenter succeeds.
 const remoteFailure=await gateDownload(b,{fail:true});await choose(a,'C');await expectSky(a,'C');await remoteFailure.started;remoteFailure.release();
 await wait(b,()=>document.body.innerText.includes('前の背景を保持しています'));await expectSky(b,'B');await remoteFailure.remove();await shot(b,'remote-failure-keeps-B');pass('receiver failed load keeps its previous B');
 }
 if(phase!=='failures') {
 // The failures phase ends with different backgrounds; restore agreement.
 if(phase==='all') { await choose(a,'A');await expectSky(a,'A');await expectSky(b,'A'); }
 const older=await gateDownload(a);await choose(a,'B');await older.started;
 // Stop intercepting new requests while the first one remains delayed.
 older.bypass();await choose(a,'C');await expectSky(a,'C');await expectSky(b,'C');older.release();await pause(1600);
 await expectSky(a,'C');await expectSky(b,'C');await shot(b,'rapid-latest-C');pass('rapid local replacement: delayed B cannot overwrite newer C');
 // Intent order must also win when conversion/upload (before GLB loading) is delayed.
 const upload=await gateDownload(a,{method:'POST'});await choose(a,'B');await upload.started;
 upload.bypass();await choose(a,'A');await expectSky(a,'A');await expectSky(b,'A');
 const uploaded=a.waitForResponse(r=>upload.requests.includes(r.url())&&r.request().method()==='POST');
 upload.release();await uploaded;await pause(1600);await expectSky(a,'A');await expectSky(b,'A');pass('older upload finishing last cannot override newer image intent');
 // Remote receiver also must reject a previously received, now-obsolete B load.
 const remoteOlder=await gateDownload(b);await choose(a,'B');await expectSky(a,'B');await remoteOlder.started;remoteOlder.bypass();
 await choose(a,'A');await expectSky(a,'A');await expectSky(b,'A');remoteOlder.release();await pause(1600);await expectSky(b,'A');pass('rapid remote replacement: delayed B cannot overwrite newer A');
 // Exercise existing Undo/Redo controls with the same replacement batches.
 await a.locator('#btn-undo').click();await expectSky(a,'B');await expectSky(b,'B');
 await a.locator('#btn-redo').click();await expectSky(a,'A');await expectSky(b,'A');pass('undo and redo preserve one background and synchronize');
 // A received replacement is pending while the shared clear countdown completes.
 const clearing=await gateDownload(b);await choose(a,'B');await expectSky(a,'B');await clearing.started;
 await clear(a);await expectEmpty(a);await expectEmpty(b);clearing.release();await pause(1600);await expectEmpty(b);await clearing.remove();
 await shot(b,'clear-no-resurrection');pass('clear during receiver load prevents old image resurrection');
 await choose(a,'A');await expectSky(a,'A');await expectSky(b,'A');
 const leaving=await gateDownload(a);await choose(a,'B');await leaving.started;
 // Close the background sheet before opening the real room dialog.
 await a.locator('#mobile-env-sheet-close').tap();
 if(!await a.locator('#editor-scene-menu').evaluate(el=>el.open)) await a.locator('#editor-scene-menu summary').tap();
 await a.locator('#editor-room-open-btn').tap();await a.getByRole('button',{name:'ルームを離脱',exact:true}).tap();
 await wait(a,room=>window.__sceneSyncDebug.presence().room!==room,room);
 leaving.release();await pause(1600);await expectEmpty(a);await expectSky(b,'A');await leaving.remove();await shot(a,'leave-no-resurrection');pass('leave during local load prevents background from returning or broadcasting');
 }
 assert.deepEqual(result.errors,[]);result.ok=true;
}catch(error){result.failure=error.stack;console.error(error);process.exitCode=1;for(let i=0;i<pages.length;i++){result.states[`failure-${i}`]=await skyState(pages[i]).catch(()=>null);await pages[i].screenshot({path:`${out}/failure-${i}.png`}).catch(()=>{});}}
finally{for(const g of gates)g.release();await writeFile(`${out}/results${phase==='all'?'':`-${phase}`}.json`,JSON.stringify(result,null,2));await browser.close();}
