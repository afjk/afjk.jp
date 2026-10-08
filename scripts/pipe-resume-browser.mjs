// Isolated real-browser companion to pipe-resume-latency.test.mjs.
// Requires installed Playwright and sandbox-capable Chromium. No production traffic.
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
const baseline = execFileSync('git',['show','96ff46795f2e396bd51d8f20e80a93d079d560d4:html/assets/js/pipe/app.js'],{cwd:root,encoding:'utf8'});
const patched = await readFile(path.join(root,'html/assets/js/pipe/app.js'),'utf8');
const slots = new Map();
const server = createServer(async (req,res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/relay/')) {
      const key=url.pathname; const slot=slots.get(key)||{}; slots.set(key,slot);
      if(req.method==='POST') { const parts=[]; for await (const p of req) parts.push(p); slot.body=Buffer.concat(parts); slot.post=res; }
      else slot.get=res;
      if(slot.body && slot.get) {slot.get.setHeader('content-type','application/json');slot.get.end(slot.body);slot.post.end('ok');slots.delete(key);}
      return;
    }
    const relative = url.pathname==='/' ? '/pipe/index.html' : url.pathname;
    const file = path.resolve(root,'html','.'+relative);
    if (!file.startsWith(path.join(root,'html')+path.sep)) {res.writeHead(403).end();return;}
    let data=await readFile(file);
    if(relative==='/assets/js/pipe/app.js') {
      const version = new URL(req.headers.referer).searchParams.get('version');
      data=(version==='baseline'?baseline:patched)
        .replace("const PIPE        = 'https://pipe.afjk.jp';", "const PIPE = location.origin + '/relay';")
        .replace('return iceConfigService.fetchServers();','return Promise.resolve([]);');
      // Test-only observation and direct function entrypoints; no protocol edits.
      data += `\nwindow.__pipeTest = {trySendWebRTCFiles,tryRecvWebRTC,getFiles:()=>selFiles};
        window.__received=[];
        const originalDownload=triggerDownload;
        triggerDownload=(blob,name)=>{window.__received.push({blob,name}); originalDownload(blob,name);};
        window.__completedAt=null;
        const originalEnd=_sendEnd;
        _sendEnd=()=>{window.__completedAt=performance.now(); originalEnd();};\n`;
    }
    if(relative==='/pipe/index.html') data=data.toString().replace(/<script src="https:\/\/cdnjs[^>]*><\/script>/g,'');
    const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'};
    res.setHeader('content-type',mime[path.extname(file)]||'application/octet-stream');res.end(data);
  } catch(e) {res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',chromiumSandbox:true,headless:true});
  const results=[];
  for(const receiverVersion of ['baseline','patched']) {
    for(const sizes of [[4096],[4096,4096,4096,4096,4096],[0]]) {
      const context=await browser.newContext({acceptDownloads:true});
      await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
      await context.routeWebSocket('**/*',ws=>ws.close());
      // CDN QR rendering is unrelated to transfer tests and deliberately offline.
      await context.addInitScript(() => {window.QRCode = class { clear() {} };});
      const sender=await context.newPage(), receiver=await context.newPage();
      await sender.goto(origin+'/?version=patched'); await receiver.goto(origin+'/?version='+receiverVersion);
      await sender.waitForFunction(()=>window.__pipeTest); await receiver.waitForFunction(()=>window.__pipeTest);
      const payloads=sizes.map((size,i)=>({name:`test-${i}.bin`,mimeType:'application/octet-stream',buffer:Buffer.from(Array.from({length:size},(_,n)=>(n*31+i)%256))}));
      await sender.locator('#file-input').setInputFiles(payloads);
      const transferPath=await sender.evaluate(()=>window.__pipeTest.getFiles()[0].path);
      // Real UI controls start both sides. In the actual page the Receive tab has
      // data-tab selector; clicking the exact tab avoids harness UI edits.
      await receiver.locator('[data-tab="receive"]').click();
      await receiver.locator('#recv-path').fill(transferPath);
      await receiver.locator('#recv-btn').click();
      await sender.evaluate(()=>{window.__start=performance.now();});
      await sender.locator('#send-btn').click();
      await sender.waitForFunction(()=>document.querySelector('#send-status').classList.contains('ok'),undefined,{timeout:15000});
      await receiver.waitForFunction(count=>window.__received.length===count,sizes.length,{timeout:15000});
      const received=await receiver.evaluate(async()=>Promise.all(window.__received.map(async({blob,name})=>({name,bytes:Array.from(new Uint8Array(await blob.arrayBuffer()))}))));
      assert.equal(received.length,payloads.length);
      received.forEach((r,i)=>{assert.equal(r.name,payloads[i].name);assert.deepEqual(Buffer.from(r.bytes),payloads[i].buffer);});
      const totalMs=await sender.evaluate(()=>window.__completedAt-window.__start);
      results.push({receiverVersion,sizes,totalMs,byteEquality:true});
      const tag=receiverVersion+'-'+sizes.length+'-'+sizes[0];
      await sender.screenshot({path:path.join(output,tag+'-sender.png'),fullPage:true});
      await receiver.screenshot({path:path.join(output,tag+'-receiver.png'),fullPage:true});
      await context.close();
    }
  }
  await writeFile(path.join(output,'results.json'),JSON.stringify({conditions:'Localhost signaling, host ICE only, real Chromium RTCDataChannel; timing includes UI start, signaling and sender completion callback after ACK',results},null,2));
  console.log(results);
} finally {await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
