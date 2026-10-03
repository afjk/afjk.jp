import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Document, NodeIO } from '@gltf-transform/core';
import path from 'node:path';
import { chromium } from 'playwright';
import { localChromiumOptions } from './lib/local-chromium.mjs';
const out = path.resolve(process.env.AFJK_CLEAR_OUTPUT || 'logs/scene-clear-browser-smoke');
await mkdir(out, { recursive: true });
const base = process.env.AFJK_WEB_ORIGIN || 'http://127.0.0.1:8888';
const presence = process.env.AFJK_PRESENCE_URL || 'ws://127.0.0.1:8787';
for (const url of [base,presence]) assert.ok(['localhost','127.0.0.1'].includes(new URL(url).hostname));
const result = { checks: [], errors: [], security: { chromiumSandbox: true, ignoreHTTPSErrors: false } };
const browser = await chromium.launch(localChromiumOptions());
const room = `ct-${Date.now().toString(36)}`;
const pages=[];
const url = name => `${base}/scenesync/?dev=1&shell=studio&room=${name}&presence=${encodeURIComponent(presence)}`;
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
const pass = name => { result.checks.push(name); console.log('PASS',name); };
async function open(name,roomName=room,context=null, waitReady=true) {
  context ||= await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,ignoreHTTPSErrors:false,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'});
  await context.addInitScript(name=>{localStorage.setItem('sceneSync.welcomeSeen','true');localStorage.setItem('sceneSync.displayName',name);},name);
  const page=await context.newPage(); pages.push(page);
  const frames=[];
  page.on('websocket',ws=>ws.on('framereceived',frame=>{try {frames.push(JSON.parse(frame.payload));} catch {}}));
  page.on('pageerror',error=>{result.errors.push({name,error:error.message});console.log('PAGEERROR',name,error.message);});
  page.on('console',m=>{if(m.type()==='error')console.log('CONSOLE',name,m.text().slice(0,250));});
  await page.goto(url(roomName),{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(()=>window.__sceneSyncDebug?.getRoomLifecycle,{},{timeout:45000});
  if (waitReady) await ready(page);
  return {page,context,frames};
}
async function count(page,n) { await page.waitForFunction(n=>window.__sceneSyncDebug.objects.list().filter(x=>x!=='sample-cube').length===n,n,{timeout:20000}); }
const ready=page=>page.waitForFunction(()=>window.__sceneSyncDebug?.getRoomLifecycle?.().ready,null,{timeout:45000});
const epochOf=page=>page.evaluate(()=>window.__sceneSyncDebug.getRoomLifecycle().epoch);
const ids=page=>page.evaluate(()=>window.__sceneSyncDebug.objects.list().filter(x=>x!=='sample-cube'));
async function add(page, roomName, id, asset={type:'primitive',shape:'box',color:'#26bfa6'}) {
  const epoch=await epochOf(page);
  const response=await fetch(presence.replace('ws:','http:')+`/api/room/${roomName}/broadcast`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'scene-add',sceneEpoch:epoch,objectId:id,name:id,asset,position:[0,1,0],rotation:[0,0,0,1],scale:[1,1,1]})});
  assert.equal(response.status,200);
}
async function clear(page) {
  const before=await epochOf(page);await page.locator('#scene-clear-button').click();
  await page.waitForFunction(before=>window.__sceneSyncDebug.getRoomLifecycle().epoch!==before,before,{timeout:15000});
  await ready(page);
}
async function seed(context, roomName, id) {
  const seed=await open('保存用端末',roomName,context);await add(seed.page,roomName,id);await count(seed.page,1);await pause(900);await seed.page.close();await pause(250);
}
try {
  const check=await browser.newPage();await check.goto('chrome://sandbox');
  const sandbox=await check.locator('body').innerText();assert.match(sandbox,/You are adequately sandboxed/);
  result.security.status=sandbox;result.security.browser=browser.version();await check.close();
  const a=await open('スマートフォン');const b=await open('HMDビューア');
  await add(a.page,room,'clear-box');await count(a.page,1);await count(b.page,1);pass('two clients ready and synchronized');
  await a.page.locator('#scene-clear-button').click();await b.page.locator('[data-scene-action="cancel-clear"]').waitFor();
  await a.page.screenshot({path:`${out}/clear-countdown-mobile.png`});
  const pending=a.frames.findLast(m=>m.type==='scene-room'&&m.pending)?.pending;
  assert.ok(pending);
  await a.page.evaluate(async ({requestId,epoch})=>{const {presenceState}=await import('/assets/js/scenesync/scene.js');for(let i=0;i<2;i++)presenceState.ws.send(JSON.stringify({type:'scene-clear-request',requestId,epoch}));},{requestId:pending.requestId,epoch:await epochOf(a.page)});
  await b.page.locator('[data-scene-action="cancel-clear"]').click();await pause(5500);await count(a.page,1);await count(b.page,1);pass('duplicate request stays one countdown; another participant cancels');
  const point=await b.page.evaluate(()=>window.__sceneSyncDebug.objects.screenPoint('clear-box'));
  const cdp=await b.context.newCDPSession(b.page);
  await Promise.all(['touchStart','touchEnd','touchStart','touchEnd'].map(type=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchStart'?[{x:point.clientX,y:point.clientY,id:1}]:[]})));
  await b.page.waitForFunction(()=>window.__sceneSyncDebug.getSelection().selectedObjectIds.includes('clear-box'));
  const connectionIds=await Promise.all([a.page,b.page].map(p=>p.evaluate(()=>window.__sceneSyncDebug.presence().id)));
  await clear(a.page);await count(a.page,0);await count(b.page,0);
  assert.deepEqual(await Promise.all([a.page,b.page].map(p=>p.evaluate(()=>window.__sceneSyncDebug.presence().id))),connectionIds);
  assert.equal(await b.page.evaluate(()=>window.__sceneSyncDebug.getSelection().selectedObjectIds.length),0);
  await b.page.evaluate(()=>{window.__sceneSyncDebug.undo();window.__sceneSyncDebug.redo();});await count(a.page,0);await count(b.page,0);
  pass('clear ignores other selection locks, clears history, preserves both connections');
  await a.page.screenshot({path:`${out}/clear-completed-mobile.png`});
  await add(a.page,room,'before-disconnect');await count(b.page,1);
  await b.context.setOffline(true);
  await b.page.evaluate(async()=>{(await import('/assets/js/scenesync/scene.js')).presenceState.ws.close();});
  await clear(a.page);await add(a.page,room,'after-clear');await count(a.page,1);
  await b.context.setOffline(false);await ready(b.page);await count(b.page,1);
  assert.deepEqual(await ids(b.page),['after-clear']);pass('offline client misses clear then reconnects to current scene including subsequent addition');
  // Keep the network response pending across the countdown, then let the old load finish.
  let releaseImage, imageRequested;
  const imageStarted=new Promise(resolve=>{imageRequested=resolve;});
  const delayed=new Promise(resolve=>{releaseImage=resolve;});
  const pixel=Buffer.from(await a.page.evaluate(()=>{const c=document.createElement('canvas');c.width=32;c.height=32;c.getContext('2d').fillRect(0,0,32,32);return c.toDataURL().split(',')[1];}),'base64');
  await a.page.route('**/clear-delayed.png',route=>route.fulfill({contentType:'image/png',body:pixel}));
  await b.page.route('**/clear-delayed.png',async route=>{imageRequested();await delayed;await route.fulfill({contentType:'image/png',body:pixel}).catch(()=>{});});
  await add(a.page,room,'delayed-image',{type:'image',url:base+'/clear-delayed.png'});
  await imageStarted;await clear(a.page);releaseImage();await pause(1000);await count(a.page,0);await count(b.page,0);
  pass('unregistered image load completing after clear cannot reappear');
  const doc=new Document();const buffer=doc.createBuffer();
  const vertices=doc.createAccessor().setType('VEC3').setArray(new Float32Array([0,0,0,1,0,0,0,1,0])).setBuffer(buffer);
  const prim=doc.createPrimitive().setAttribute('POSITION',vertices);
  doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)));
  const glb=Buffer.from(await new NodeIO().writeBinary(doc)).toString('base64');
  await b.page.evaluate(glb=>{
    const manager=window.__sceneSyncDebug.dragDropManager, loader=manager.glbLoader;
    const original=loader._load.bind(loader);let release;
    const gate=new Promise(resolve=>{release=resolve;});
    window.__releaseGlb=()=>{loader._load=original;release();};
    loader._load=async(...args)=>{const value=await original(...args);window.__glbDecoded=true;await gate;return value;};
    const file=new File([Uint8Array.from(atob(glb),c=>c.charCodeAt(0))],'late-model.glb',{type:'model/gltf-binary'});
    window.__pendingGlb=manager.handleFile(file).then(()=>({ok:true}),error=>({error:error.message}));
  },glb);
  await b.page.waitForFunction(()=>window.__glbDecoded===true);await clear(a.page);
  const cancelledGlb=await b.page.evaluate(async()=>{window.__releaseGlb();return await window.__pendingGlb;});
  assert.ok(cancelledGlb.error);await count(a.page,0);await count(b.page,0);
  pass('local GLB decoded before clear is disposed instead of attaching or broadcasting afterward');
  // Exercise the real XR notice mesh and the same select event used by XR controllers.
  const xr=await open('XR入力確認');await a.page.locator('#scene-clear-button').click();await xr.page.locator('[data-scene-action="cancel-clear"]').waitFor();
  await xr.page.evaluate(async()=>{
    const {scene,camera,renderer}=await import('/assets/js/scenesync/scene.js');
    renderer.setAnimationLoop(null);
    const mesh=scene.getObjectByName('scene-clear-xr-notice');mesh.visible=true;
    const {Vector3}=await import('three');
    mesh.position.copy(camera.position).add(new Vector3(0,0,-1.6).applyQuaternion(camera.quaternion));mesh.quaternion.copy(camera.quaternion);
    document.querySelector('#scene-clear-notice').hidden=true;
    renderer.render(scene,camera);
  });
  await xr.page.screenshot({path:`${out}/xr-notice-browser-preview.png`});
  await xr.page.evaluate(async()=>{const {renderer}=await import('/assets/js/scenesync/scene.js');renderer.xr.getController(0).dispatchEvent({type:'selectstart'});});
  await a.page.locator('#scene-clear-notice').waitFor({state:'hidden'});await xr.page.close();
  pass('browser alternative: actual XR notice mesh renders and controller select cancels (no HMD hardware)');
  const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,ignoreHTTPSErrors:false,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'});
  const restoreRoom=room+'-restore';await seed(ctx,restoreRoom,'saved-object');
  let restore=await open('復元端末',restoreRoom,ctx,false);
  await restore.page.locator('[data-scene-action="restore-yes"]').waitFor();
  await restore.page.screenshot({path:`${out}/restore-confirm-mobile.png`});
  await count(restore.page,0);await restore.page.locator('[data-scene-action="restore-yes"]').click();await ready(restore.page);await count(restore.page,1);
  pass('empty-room restore waits for explicit Yes');await pause(700);await restore.page.close();await pause(250);
  restore=await open('復元端末',restoreRoom,ctx,false);await restore.page.locator('[data-scene-action="restore-no"]').click();await ready(restore.page);await count(restore.page,0);
  await pause(700);await restore.page.close();await pause(250);
  restore=await open('復元端末',restoreRoom,ctx);await count(restore.page,0);assert.equal(await restore.page.evaluate(()=>window.__sceneSyncDebug.objects.list().length),0);assert.equal(await restore.page.locator('[data-scene-action="restore-yes"]').count(),0);
  pass('No starts empty and does not resurrect on the next visit');await restore.page.close();
  const raceRoom=room+'-join';await seed(ctx,raceRoom,'old-join-object');
  const waiting=await open('復元待ち',raceRoom,ctx,false);await waiting.page.locator('[data-scene-action="restore-yes"]').waitFor();
  const joiner=await open('途中参加',raceRoom);await ready(waiting.page);await count(waiting.page,0);await count(joiner.page,0);
  assert.equal(await waiting.page.locator('[data-scene-action="restore-yes"]').count(),0);pass('participant arrival cancels restore prompt and converges without old objects');
  await waiting.page.close();await joiner.context.close();
  const loadingRoom=room+'-loading';await seed(ctx,loadingRoom,'slow-restored-object');
  const preparing=await ctx.newPage();await preparing.goto(base);
  await preparing.evaluate(async ({roomName,imageUrl})=>{
    const {createRoomSnapshotCache}=await import('/assets/js/scenesync/assets/scene-snapshot-cache.js');const cache=createRoomSnapshotCache();
    const record=await cache.getSnapshot(roomName);const original=record.snapshot.objects[0];
    record.snapshot.objects=[{...original,asset:{type:'image',url:imageUrl}}, {...original,objectId:'second-stale-object'}];
    await cache.saveSnapshot(roomName,record.snapshot);
  },{roomName:loadingRoom,imageUrl:base+'/restore-delayed.png'});await preparing.close();
  const loading=await open('復元実行中',loadingRoom,ctx,false);
  let releaseRestore, restoreRequested;
  const restoreStarted=new Promise(resolve=>{restoreRequested=resolve;});const holdRestore=new Promise(resolve=>{releaseRestore=resolve;});
  await loading.page.route('**/restore-delayed.png',async route=>{restoreRequested();await holdRestore;await route.fulfill({contentType:'image/png',body:pixel}).catch(()=>{});});
  await loading.page.locator('[data-scene-action="restore-yes"]').click();await restoreStarted;
  const interrupting=await open('復元中の参加',loadingRoom);await ready(loading.page);
  releaseRestore();await pause(500);await count(loading.page,0);await count(interrupting.page,0);
  pass('arrival during accepted restore cancels delayed media and remaining snapshot objects');
  await loading.page.close();await interrupting.context.close();
  const moveRoom=room+'-move';await seed(ctx,moveRoom,'old-move-object');
  const moving=await open('移動端末',moveRoom,ctx,false);await moving.page.locator('[data-scene-action="restore-yes"]').waitFor();
  await moving.page.evaluate(room=>window.__sceneSyncDebug.sceneClear.switchRoom(room),room+'-destination');
  await ready(moving.page);await count(moving.page,0);assert.equal(await moving.page.locator('[data-scene-action="restore-yes"]').count(),0);
  pass('room switch invalidates restore prompt and stale work');
  assert.equal(result.errors.length,0);result.ok=true;
} catch(error) {result.error=error.stack;console.error(error);for(let i=0;i<pages.length;i++)if(!pages[i].isClosed())await pages[i].screenshot({path:`${out}/failure-${i}.png`}).catch(()=>{});process.exitCode=1;}
finally {await writeFile(`${out}/browser-results.json`,JSON.stringify(result,null,2));await browser.close();}
