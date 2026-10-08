// Protocol regression tests and repeatable synthetic latency benchmark.
// Runs actual app sender/receiver functions with asynchronous in-memory channels.
// No browser, signaling server, production service, or network is used.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';

const source = await readFile(new URL('../html/assets/js/pipe/app.js', import.meta.url), 'utf8');
const baselineRef = process.env.PIPE_BASELINE_REF || '96ff46795f2e396bd51d8f20e80a93d079d560d4';
const baseline = execFileSync('git', ['show', `${baselineRef}:html/assets/js/pipe/app.js`], {
  cwd: new URL('../', import.meta.url), encoding: 'utf8',
});
function definition(code, name) {
  const start = code.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, name);
  const tail = code.slice(start);
  return tail.slice(0, tail.search(/^\}/m) + 1);
}
class Channel extends EventTarget {
  readyState = 'open'; bufferedAmount = 0; onmessage = null; onerror = null;
  frames = [];
  constructor(latency = 1, ackDelay = 0) { super(); this.latency = latency; this.ackDelay = ackDelay; }
  send(data) {
    if (this.readyState !== 'open') throw new Error('closed');
    const decoded = typeof data === 'string' ? JSON.parse(data) : null;
    this.frames.push({ at: performance.now(), data: decoded || new Uint8Array(data).slice() });
    const delay = this.latency + (decoded?.t === 'recv-ack' ? this.ackDelay : 0);
    setTimeout(() => {
      if (this.peer.readyState !== 'open') return;
      const e = new Event('message'); e.data = data;
      this.peer.onmessage?.(e); this.peer.dispatchEvent(e);
    }, delay);
  }
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
}
function runtime(code, dc, kind, peerAcks = true) {
  const pc = { connectionState: 'connected', close() { this.connectionState = 'closed'; dc.close(); } };
  const session = { dc, pc, ac: new AbortController(), peerAcks, chunkSize: 1024, flowHigh: 8192, flowLow: 4096 };
  const context = vm.createContext({
    Blob, File, Uint8Array, ArrayBuffer, TextEncoder, crypto: webcrypto, performance, console,
    setTimeout, clearTimeout,
    initSendRtcSession: async () => session, initRecvRtcSession: async () => session,
    disposeRtcSession: (_s, opts) => { session.disposed = opts; },
    _recvAC: null, RECV_INACTIVITY: 1000, RECV_FOLD_BYTES: 2048, HASH_MAX_BYTES: 1048576,
    ACK_TIMEOUT: 1000, FLOW_STALL_MS: 200, CHUNK_PROFILE: 'test',
    makeProgressThrottle: () => fn => fn(), shrinkChunk: () => false,
    waitForBufferDrain: async () => {}, reportTransfer: () => {}, fmt: String,
    t: () => (...args) => args.join(' '),
  });
  for (const name of ['hashBlob', 'maybeHashBlob', 'sendDoneFrame', 'waitForAck', 'trySendWebRTCFiles', 'tryRecvWebRTC']) {
    vm.runInContext(definition(code, name), context);
  }
  return { context, session, dc, kind };
}
function pair(senderCode = source, receiverCode = source, options = {}) {
  const sdc = new Channel(options.latency ?? 1), rdc = new Channel(options.latency ?? 1, options.ackDelay ?? 0);
  sdc.peer = rdc; rdc.peer = sdc;
  return { sender: runtime(senderCode, sdc, 'send', options.peerAcks ?? true), receiver: runtime(receiverCode, rdc, 'recv') };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const payloads = sizes => sizes.map((size, i) => Uint8Array.from({length: size}, (_, n) => (n * 31 + i) % 256));
async function transfer(senderCode, receiverCode, sizes, options = {}) {
  const { sender, receiver } = pair(senderCode, receiverCode, options);
  const bytes = payloads(sizes);
  const received = [], done = [];
  const recv = receiver.context.tryRecvWebRTC('synthetic', () => {}, (_m, blob, name) => received.push({blob, name}), () => {});
  let completeAt = null;
  const started = performance.now();
  const send = sender.context.trySendWebRTCFiles(bytes.map((data, i) => ({file: new File([data], `file-${i}.bin`), path: 'synthetic'})),
    () => {}, i => done.push(i), () => {completeAt = performance.now();}, () => {});
  const [sendOk, recvOk] = await Promise.all([send, recv]);
  assert.equal(sendOk, true); assert.equal(recvOk, true);
  assert.equal(received.length, sizes.length); assert.equal(done.length, sizes.length);
  for (let i = 0; i < sizes.length; i++) {
    assert.equal(received[i].name, `file-${i}.bin`);
    assert.deepEqual(new Uint8Array(await received[i].blob.arrayBuffer()), bytes[i]);
  }
  const frames = sender.dc.frames;
  const waits = frames.flatMap((frame, index) => frame.data.t === 'meta'
    ? [frames[index + 1].at - frame.at] : []);
  return { totalMs: completeAt - started, fileWaitMs: waits, bytes: sizes.reduce((a,b) => a+b,0), sender, receiver };
}

test('transport core and final ACK remain unchanged apart from a file-start observer', () => {
  const sender = definition(source, 'trySendWebRTCFiles')
    .replace(', onFileStart)', ')')
    .replace("      if (typeof onFileStart === 'function') onFileStart(i, resumeOffset, total);\n\n", '');
  assert.equal(sender, definition(baseline, 'trySendWebRTCFiles'));
  for (const name of ['waitForAck', 'sendDoneFrame']) {
    assert.equal(definition(source, name), definition(baseline, name));
  }
});
for (const [name, senderCode, receiverCode] of [
  ['new/new', source, source], ['old/new', baseline, source],
  ['new/old', source, baseline], ['old/old', baseline, baseline],
]) {
  test(`${name}: single and multiple files arrive byte-for-byte, including empty file`, async () => {
    for (const sizes of [[4096], [0], [23, 0, 8193]]) {
      const result = await transfer(senderCode, receiverCode, sizes);
      if (receiverCode === baseline) assert.ok(result.fileWaitMs.every(ms => ms >= 450));
      else assert.ok(result.fileWaitMs.every(ms => ms < 450));
    }
  });
}
test('file-start observers reset meters with actual resumed offsets, including empty files', async () => {
  const {sender,receiver}=pair();const sendStarts=[],recvStarts=[];
  const recv=receiver.context.tryRecvWebRTC('synthetic',()=>{},()=>{},()=>{},(...args)=>recvStarts.push(args));
  const send=sender.context.trySendWebRTCFiles([0,1024].map((size,i)=>({file:new File([new Uint8Array(size)],`file-${i}`),path:'synthetic'})),()=>{},()=>{},()=>{},()=>{},(...args)=>sendStarts.push(args));
  assert.deepEqual(await Promise.all([send,recv]),[true,true]);
  assert.deepEqual(sendStarts,[[0,0,0],[1,0,1024]]);assert.deepEqual(recvStarts,sendStarts);
});
test('completion timing includes delayed final ACK', async () => {
  const r = await transfer(source, source, [4096, 4096], { ackDelay: 40 });
  const last = r.sender.dc.frames.findLast(f => f.data.t === 'all-done');
  const start = r.sender.dc.frames[0].at;
  assert.ok(r.totalMs - (last.at - start) >= 35);
});
test('receiver preserves matching partial bytes and resets different files', async () => {
  for (const same of [true, false]) {
    const {sender, receiver} = pair();
    const received = [], starts = [];
    const recv = receiver.context.tryRecvWebRTC('synthetic', () => {}, (_m,b) => received.push(b), () => {}, (_i,offset) => starts.push(offset));
    await sleep(0);
    const meta = {t:'meta', name:'partial.bin', index:0, count:2, size:4, resumable:true};
    sender.dc.send(JSON.stringify(meta)); sender.dc.send(new Uint8Array([1,2]).buffer);
    sender.dc.send(JSON.stringify({...meta, name: same ? meta.name : 'different.bin'}));
    await sleep(10);
    assert.deepEqual(receiver.dc.frames.filter(f => f.data.t === 'resume').map(f => f.data.offset), [0, same ? 2 : 0]);
    assert.deepEqual(starts,[0,same ? 2 : 0]);
    sender.dc.send(new Uint8Array([3,4]).buffer);
    sender.dc.send(JSON.stringify({t:'done'})); sender.dc.send(JSON.stringify({t:'all-done'}));
    assert.equal(await recv, true);
    assert.deepEqual(new Uint8Array(await received[0].arrayBuffer()), new Uint8Array(same ? [1,2,3,4] : [3,4]));
  }
});
test('non-resumable legacy metadata does not get unsolicited resume frame', async () => {
  const {sender, receiver} = pair();
  const recv = receiver.context.tryRecvWebRTC('synthetic', () => {}, () => {}, () => {});
  await sleep(0);
  sender.dc.send(JSON.stringify({t:'meta', name:'legacy.bin', size:0, count:1}));
  sender.dc.send(JSON.stringify({t:'done'}));
  assert.equal(await recv, true);
  assert.equal(receiver.dc.frames.some(f => f.data.t === 'resume'), false);
});
test('cancel during resume wait does not report completion (new and silent old receiver)', async () => {
  for (const receiverCode of [source, baseline]) {
    for (const size of [0, 4096]) {
      const {sender,receiver} = pair(source, receiverCode, {latency: 20});
      let completed = false;
      const recv = receiver.context.tryRecvWebRTC('synthetic', () => {}, () => {}, () => {});
      const send = sender.context.trySendWebRTCFiles([{file:new File([new Uint8Array(size)], 'cancel.bin'), path:'synthetic'}],
        () => {}, () => {}, () => {completed=true}, () => {});
      await sleep(5); sender.session.pc.close();
      assert.equal(await send, false); assert.equal(completed, false);
      assert.equal(await recv, false);
    }
  }
});

test('benchmark baseline versus patched receiver (synthetic transport, five samples)', async () => {
  const report = { baselineRef, conditions: 'Node.js actual app functions; 1 ms scheduled one-way in-memory channel; no browser/network/signaling; total includes receiver final ACK; 5 alternating samples; 4 KiB/file', samples: {} };
  for (const count of [1,5]) {
    report.samples[count] = {baseline:[], patched:[]};
    for (let n=0;n<5;n++) {
      for (const [label,code] of [['baseline',baseline], ['patched',source]]) {
        const {totalMs,fileWaitMs,bytes} = await transfer(source, code, Array(count).fill(4096));
        report.samples[count][label].push({totalMs,fileWaitMs,bytes});
      }
    }
    const median = a => [...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
    const row = report.samples[count];
    row.summary = {baselineMedianMs:median(row.baseline.map(r=>r.totalMs)),patchedMedianMs:median(row.patched.map(r=>r.totalMs))};
    console.log(`${count} files: baseline median ${row.summary.baselineMedianMs.toFixed(1)} ms, patched ${row.summary.patchedMedianMs.toFixed(1)} ms`);
  }
  if (process.env.PIPE_BENCH_OUTPUT) await writeFile(process.env.PIPE_BENCH_OUTPUT, JSON.stringify(report,null,2)+'\n');
});
