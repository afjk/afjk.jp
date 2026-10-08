// Real app UI + RTCDataChannel verification. Only loopback synthetic transfers.
// No production relay, external ICE, weakened browser sandbox, or TLS override.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const {chromium} = await import(process.env.PIPE_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.env.PIPE_BROWSER_OUTPUT || path.join(root, 'pipe-browser-results'));
await mkdir(output, {recursive:true});
const baselineRef='96ff46795f2e396bd51d8f20e80a93d079d560d4';
const baseline=execFileSync('git',['show',`${baselineRef}:html/assets/js/pipe/app.js`],{cwd:root,encoding:'utf8'});
const patched=await readFile(path.join(root,'html/assets/js/pipe/app.js'),'utf8');
const repetitions=Number(process.env.PIPE_BROWSER_SAMPLES||5);
assert.ok(Number.isInteger(repetitions)&&repetitions>=1&&repetitions<=10);
const report={baselineRef,security:{chromiumSandbox:true,ignoreHTTPSErrors:false,hostIceOnly:true},
  conditions:'Two pages in one browser context; actual app UI and RTCDataChannel; loopback HTTP signaling; prewarming enabled; timing from actual Send click through the later of sender completion and observed receiver ACK; QR CDN stubbed; no production traffic',
  browser:null,results:[],checks:[],speedCases:[],errors:[],blockedExternal:[]};
const slots=new Map(),httpUploads=new Map();
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/relay/')) {
      if(url.pathname==='/relay/http-rate-download.__offer'){res.writeHead(503).end();return;}
      if(url.pathname==='/relay/http-rate-download'){
        res.setHeader('content-type','application/octet-stream');
        res.setHeader('content-disposition','attachment; filename="synthetic-http.bin"');res.end(Buffer.alloc(4096));return;
      }
      if(!/\.__(offer|answer)$/.test(url.pathname)){
        assert.equal(req.method,'POST');const parts=[];for await(const p of req)parts.push(p);
        httpUploads.set(url.pathname,Buffer.concat(parts));res.end('ok');return;
      } // P2P verification below still requires actual RTC frames and final ACKs.

      const key=url.pathname, slot=slots.get(key)||{};slots.set(key,slot);
      if(req.method==='POST'){const parts=[];for await(const p of req)parts.push(p);slot.body=Buffer.concat(parts);slot.post=res;}
      else slot.get=res;
      if(slot.body&&slot.get){slot.get.setHeader('content-type','application/json');slot.get.end(slot.body);slot.post.end('ok');slots.delete(key);}
      return;
    }
    const relative=url.pathname==='/'?'/pipe/index.html':url.pathname;
    const file=path.resolve(root,'html','.'+relative);
    if(!file.startsWith(path.join(root,'html')+path.sep)){res.writeHead(403).end();return;}
    let data=await readFile(file);
    if(relative==='/assets/js/pipe/app.js') {
      const version=new URL(req.headers.referer).searchParams.get('version');
      data=version==='baseline'?baseline:patched;
      const relay="const PIPE        = 'https://pipe.afjk.jp';", ice='return iceConfigService.fetchServers();';
      assert.ok(data.includes(relay)&&data.includes(ice));
      data=data.replace(relay,"const PIPE = location.origin + '/relay';").replace(ice,'return Promise.resolve([]);');
      // Test-only observations; protocol and UI handlers are unchanged.
      data+=`\nwindow.__pipeTest={getFiles:()=>selFiles,getSession:()=>_activeSendSession};window.__received=[];
        const originalDownload=triggerDownload;
        triggerDownload=(blob,name)=>{window.__received.push({blob,name});originalDownload(blob,name);};
        window.__completedAt=null;const originalEnd=_sendEnd;
        _sendEnd=()=>{window.__completedAt=performance.now();originalEnd();};\n`;
    }
    if(relative==='/pipe/index.html')data=data.toString().replace(/<script src="https:\/\/cdnjs[^>]*><\/script>/g,'');
    const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'};
    res.setHeader('content-type',mime[path.extname(file)]||'application/octet-stream');res.end(data);
  }catch(e){if(!res.destroyed&&!res.writableEnded)res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;const openContexts=[];
async function openPair(senderVersion,receiverVersion,{mobile=false,slowReadMs=0,language='en'}={}) {
  const context=await browser.newContext({acceptDownloads:true,ignoreHTTPSErrors:false,
    viewport:mobile?{width:390,height:844}:{width:1100,height:900},isMobile:mobile,hasTouch:mobile});
  openContexts.push(context);
  await context.route('**/*',route=>{
    if(new URL(route.request().url()).origin===origin)return route.continue();
    report.blockedExternal.push(route.request().url());return route.abort();
  });
  await context.routeWebSocket('**/*',ws=>ws.close());
  await context.addInitScript(({slowReadMs,language})=>{
    localStorage.setItem('lang',language);
    if(slowReadMs){
      // Synthetic producer pacing makes live UI sampling observable; transport stays real.
      const slice=File.prototype.slice;
      File.prototype.slice=function(...args){const blob=slice.apply(this,args),read=blob.arrayBuffer.bind(blob);
        blob.arrayBuffer=async()=>{await new Promise(r=>setTimeout(r,slowReadMs));return read();};return blob;};
    }

    window.QRCode=class{clear(){}}; // CDN QR rendering is deliberately offline.
    window.__wire=[];window.__start=null;
    document.addEventListener('click',e=>{if(e.target.closest('#send-btn'))window.__start=performance.now();},true);
    const original=RTCDataChannel.prototype.send;
    const observed=new WeakSet();
    const observe=(direction,data)=>window.__wire.push({direction,at:performance.now(),
      frame:typeof data==='string'?JSON.parse(data):null,bytes:typeof data==='string'?0:data.byteLength});
    RTCDataChannel.prototype.send=function(data){
      if(!observed.has(this)){observed.add(this);this.addEventListener('message',e=>observe('in',e.data));}
      observe('out',data);return original.call(this,data);
    };
  },{slowReadMs,language});
  const sender=await context.newPage(),receiver=await context.newPage();
  for(const p of [sender,receiver])p.on('pageerror',e=>report.errors.push(e.message));
  await sender.goto(origin+'/?version='+senderVersion);await receiver.goto(origin+'/?version='+receiverVersion);
  await sender.waitForFunction(()=>window.__pipeTest);await receiver.waitForFunction(()=>window.__pipeTest);
  await receiver.locator('[data-tab="receive"]').click();
  return{context,sender,receiver};
}
const payloadsFor=sizes=>sizes.map((size,i)=>({name:`test-${i}.bin`,mimeType:'application/octet-stream',
  buffer:Buffer.from(Array.from({length:size},(_,n)=>(n*31+i)%256))}));
async function start(pair,payloads){
  await pair.sender.locator('#file-input').setInputFiles(payloads);
  const transferPath=await pair.sender.evaluate(()=>window.__pipeTest.getFiles()[0].path);
  await pair.receiver.locator('#recv-path').fill(transferPath);
  await pair.receiver.locator('#recv-btn').click();
  await pair.sender.locator('#send-btn').click();
}
async function verify(pair,payloads){
  await pair.sender.waitForFunction(()=>document.querySelector('#send-status').classList.contains('ok'),undefined,{timeout:15000});
  await pair.receiver.waitForFunction(count=>window.__received.length===count,payloads.length,{timeout:15000});
  const received=await pair.receiver.evaluate(async()=>Promise.all(window.__received.map(async({blob,name})=>({name,bytes:Array.from(new Uint8Array(await blob.arrayBuffer()))}))));
  assert.equal(received.length,payloads.length);
  received.forEach((r,i)=>{assert.equal(r.name,payloads[i].name);assert.deepEqual(Buffer.from(r.bytes),payloads[i].buffer);});
  // Single-file receiver ACKs both done and all-done; multi-file ACKs all-done only.
  // Each case uses its own channel, so waiting for this count includes the final ACK.
  await pair.sender.waitForFunction(count=>window.__wire.filter(e=>e.direction==='in'&&e.frame?.t==='recv-ack').length===count,payloads.length===1?2:1,{timeout:3000});
  const timing=await pair.sender.evaluate(()=>{
    const meta=window.__wire.find(e=>e.direction==='out'&&e.frame?.t==='meta');
    const ack=window.__wire.findLast(e=>e.direction==='in'&&e.frame?.t==='recv-ack');
    const frames=window.__wire.filter(e=>e.direction==='out');
    const confirmedAt=Math.max(window.__completedAt,ack.at);
    return{totalMs:confirmedAt-window.__start,postHandshakeMs:confirmedAt-meta.at,
      senderCompletionMs:window.__completedAt-window.__start,receiverAckMs:ack.at-window.__start,
      completedAt:window.__completedAt,peerAcks:window.__pipeTest.getSession()?.peerAcks,
      ackBeforeCompletion:!!ack&&ack.at<=window.__completedAt,
      fileWaitMs:frames.flatMap((e,i)=>e.frame?.t==='meta'?[frames[i+1].at-e.at]:[]),wire:window.__wire};
  });
  assert.ok(timing.totalMs>=timing.receiverAckMs);
  for(const [page,id]of [[pair.sender,'send-speed'],[pair.receiver,'recv-speed']]){
    if(await page.locator('#'+id).isVisible())assert.doesNotMatch(await page.locator('#'+id).innerText(),/NaN|Infinity/);
  }
  console.log("TRANSFER",JSON.stringify({files:payloads.length,totalMs:timing.totalMs,peerAcks:timing.peerAcks,ackBeforeCompletion:timing.ackBeforeCompletion}));
  return timing;
}
async function shots(pair,tag){
  await pair.sender.waitForTimeout(400); // Let the existing progress-bar transition settle.
  await pair.sender.screenshot({path:path.join(output,tag+'-sender.png'),fullPage:true});
  await pair.receiver.screenshot({path:path.join(output,tag+'-receiver.png'),fullPage:true});
}
try{
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',chromiumSandbox:true,
    ignoreDefaultArgs:['--enable-unsafe-swiftshader'],headless:true});
  report.browser=await browser.version();
  const security=await browser.newPage();await security.goto('chrome://sandbox');
  report.security.status=await security.locator('body').innerText();
  assert.match(report.security.status,/You are adequately sandboxed/);await security.close();
  // Alternate baseline/patched receiver per sample, using identical sender code.
  for(const count of [1,5])for(let sample=0;sample<repetitions;sample++)for(const receiverVersion of ['baseline','patched']){
    const pair=await openPair('patched',receiverVersion),sizes=Array(count).fill(4096),payloads=payloadsFor(sizes);
    await start(pair,payloads);const timing=await verify(pair,payloads);
    report.results.push({senderVersion:'patched',receiverVersion,sizes,sample,byteEquality:true,...timing});
    if(sample===0)await shots(pair,`${receiverVersion}-${count}`);
    await pair.context.close();
  }
  // Additional UI compatibility, zero-byte and mobile-emulated-layout checks.
  for(const [senderVersion,receiverVersion,sizes,mobile] of [
    ['baseline','patched',[4096],false],['baseline','baseline',[4096],false],
    ['patched','patched',[0],false],['patched','baseline',[0],false],
    ['patched','patched',[23,0,8193],true],
  ]){
    const pair=await openPair(senderVersion,receiverVersion,{mobile}),payloads=payloadsFor(sizes);
    await start(pair,payloads);const timing=await verify(pair,payloads);
    report.results.push({senderVersion,receiverVersion,sizes,mobile,byteEquality:true,...timing});
    await shots(pair,`compat-${senderVersion}-${receiverVersion}-${sizes.join('-')}-${mobile}`);
    await pair.context.close();
  }
  // New live-speed UI: paced synthetic file reads, real RTC transfer, both directions.
  for(const mobile of [false,true]){
    const pair=await openPair('patched','patched',{mobile,slowReadMs:80,language:mobile?'ja':'en'});
    const payloads=payloadsFor([8*1024*1024]);
    for(const [page,id]of [[pair.sender,'send-speed'],[pair.receiver,'recv-speed']])await page.evaluate(id=>{
      window.__speedWrites=0;new MutationObserver(()=>window.__speedWrites++).observe(document.querySelector('#'+id+' .speed-value'),{childList:true});
    },id);
    await start(pair,payloads);
    for(const [page,id]of [[pair.sender,'send-speed'],[pair.receiver,'recv-speed']])await page.waitForFunction(id=>{
      const el=document.getElementById(id);return !el.hidden&&/^[1-9][0-9.]* [KMG]?B\/s$/.test(el.querySelector('.speed-value').textContent)&&!el.querySelector('.speed-label').textContent.includes('Average')&&!el.querySelector('.speed-label').textContent.includes('平均');
    },id);
    const values={mobile,sender:await pair.sender.locator('#send-speed').innerText(),receiver:await pair.receiver.locator('#recv-speed').innerText()};
    assert.match(values.sender,/queued|キュー投入/);assert.match(values.receiver,/Receive speed|受信速度/);
    await Promise.all([pair.sender.screenshot({path:path.join(output,`live-speed-${mobile}-sender.png`),fullPage:true}),pair.receiver.screenshot({path:path.join(output,`live-speed-${mobile}-receiver.png`),fullPage:true})]);
    const timing=await verify(pair,payloads);
    for(const p of [pair.sender,pair.receiver]){
      assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      assert.ok(await p.evaluate(()=>window.__speedWrites)<=Math.ceil(timing.totalMs/250)+8);
    }
    report.speedCases.push({...values,byteEquality:true,totalMs:timing.totalMs});await pair.context.close();
  }
  // Actual XHR upload-to-relay progress, throttled only in this test browser.
  {
    const pair=await openPair('patched','patched');
    await pair.context.route('**/relay/**.__answer',route=>route.fulfill({status:503,body:'test P2P unavailable'}));
    const cdp=await pair.context.newCDPSession(pair.sender);await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:10*1024*1024,uploadThroughput:1024*1024});
    const payloads=payloadsFor([4*1024*1024]);await pair.sender.locator('#file-input').setInputFiles(payloads);
    const transferPath=await pair.sender.evaluate(()=>window.__pipeTest.getFiles()[0].path);
    await pair.sender.locator('#send-btn').click();
    await pair.sender.waitForFunction(()=>/^[1-9][0-9.]* [KMG]?B\/s$/.test(document.querySelector('#send-speed .speed-value').textContent));
    assert.match(await pair.sender.locator('#send-speed').innerText(),/to relay/);
    await pair.sender.screenshot({path:path.join(output,'live-speed-http-upload.png'),fullPage:true});
    await pair.sender.waitForFunction(()=>document.querySelector('#send-status').classList.contains('ok'),undefined,{timeout:20000});
    assert.deepEqual(httpUploads.get('/relay/'+transferPath),payloads[0].buffer);
    report.checks.push('HTTP upload shows observed upload-to-relay rate and exact bytes');
    await pair.receiver.locator('#recv-path').fill('http-rate-download');await pair.receiver.locator('#recv-btn').click();
    await pair.receiver.waitForFunction(()=>document.querySelector('#recv-speed .speed-hint').textContent.includes('browser-managed'));
    assert.equal(await pair.receiver.locator('#recv-speed .speed-value').innerText(),'—');
    await pair.receiver.screenshot({path:path.join(output,'speed-unavailable-http-download.png'),fullPage:true});
    report.checks.push('browser-managed HTTP receive explicitly reports rate unavailable');await pair.context.close();
  }
  const pair=await openPair('patched','baseline');
  // A long legacy queue keeps the Cancel control available to real UI automation.
  // Do not rely on winning a sub-500 ms actionability window for a single file.
  await start(pair,payloadsFor(Array(20).fill(4096)));
  await pair.sender.waitForFunction(()=>window.__wire.some(e=>e.frame?.t==='meta'));
  await pair.sender.locator('#cancel-send-btn').click();
  await pair.sender.waitForTimeout(650);
  assert.match(await pair.sender.locator('#send-status').innerText(),/キャンセル|cancel/i);
  assert.equal(await pair.sender.locator('#send-speed').isVisible(),false);
  assert.ok(await pair.receiver.evaluate(()=>window.__received.length)<20);
  assert.equal(await pair.sender.evaluate(()=>window.__wire.some(e=>e.direction==='out'&&e.frame?.t==='all-done')),false);
  await shots(pair,'cancel');report.checks.push('UI sender cancellation stops an unfinished legacy multi-file queue');
  await pair.receiver.reload();await pair.receiver.waitForFunction(()=>window.__pipeTest);
  await pair.receiver.locator('[data-tab="receive"]').click();
  // Regression: Reset must call the exported swarm UI helper without ReferenceError.
  await pair.sender.evaluate(()=>document.getElementById('magnet-info').classList.add('visible'));
  await pair.sender.locator('#reset-send-btn').click();
  assert.equal(await pair.sender.locator('#magnet-info').evaluate(el=>el.classList.contains('visible')),false);
  assert.equal(await pair.sender.evaluate(()=>window.__pipeTest.getFiles().length),0);
  assert.equal(await pair.sender.locator('#send-speed').isVisible(),false);
  await pair.sender.evaluate(()=>{window.__wire=[];window.__completedAt=null;});
  await start(pair,payloadsFor([4096]));await verify(pair,payloadsFor([4096]));
  report.checks.push('fresh transfer succeeds after sender cancel/reset and receiver reload');await shots(pair,'repeat-after-cancel');
  await pair.context.close();
  assert.deepEqual(report.errors,[]);report.ok=true;
  const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
  report.summary=[1,5].map(count=>({files:count,...Object.fromEntries(['baseline','patched'].map(version=>{
    const rows=report.results.filter(r=>r.sample!==undefined&&r.sizes.length===count&&r.receiverVersion===version);
    return[version,{totalMedianMs:median(rows.map(r=>r.totalMs)),postHandshakeMedianMs:median(rows.map(r=>r.postHandshakeMs))}];
  }))}));
  console.log(JSON.stringify(report.summary,null,2));
}catch(error){report.ok=false;report.failure=error.stack;process.exitCode=1;console.error(error);console.log("BROWSER_REPORT",JSON.stringify(report));
  for(const [i,context]of openContexts.entries())for(const[j,p]of context.pages().entries())await p.screenshot({path:path.join(output,`failure-${i}-${j}.png`),fullPage:true}).catch(()=>{});
}finally{
  await writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2));
  await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
