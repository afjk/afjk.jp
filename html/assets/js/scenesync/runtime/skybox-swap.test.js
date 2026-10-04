import test from 'node:test';
import assert from 'node:assert/strict';
import { createSkyboxSwapController, skyboxReplacementInBatch } from './skybox-swap.js';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };

test('old background stays visible until preparation succeeds, and survives failure', async () => {
  const swaps = createSkyboxSwapController(); let visible='A';
  const loading=deferred();
  const work=swaps.run(swaps.begin(),()=>loading.promise,value=>{visible=value;});
  assert.equal(visible,'A'); loading.resolve('B'); await work; assert.equal(visible,'B');
  await assert.rejects(swaps.run(swaps.begin(),()=>Promise.reject(new Error('decode failed')),value=>{visible=value;}),/decode failed/);
  assert.equal(visible,'B');
});

test('latest intent wins even if old preparation finishes last or newer request fails', async () => {
  const swaps=createSkyboxSwapController(); let visible='A'; const disposed=[];
  const loading=deferred(), oldToken=swaps.begin();
  const old=swaps.run(oldToken,()=>loading.promise,v=>{visible=v;},v=>disposed.push(v));
  const rejection=assert.rejects(old,{name:'AbortError'});
  await swaps.run(swaps.begin(),async()=> 'C',v=>{visible=v;});
  assert.equal(oldToken.signal.aborted,true); loading.resolve('B'); await rejection;
  assert.equal(visible,'C'); assert.deepEqual(disposed,['B']);
  const delayed=deferred();
  const obsolete=swaps.run(swaps.begin(),()=>delayed.promise,v=>{visible=v;});
  const obsoleteRejection=assert.rejects(obsolete,{name:'AbortError'});
  await assert.rejects(swaps.run(swaps.begin(),async()=>{throw Error('new failed');},v=>{visible=v;}),/new failed/);
  delayed.resolve('D'); await obsoleteRejection; assert.equal(visible,'C');
});

test('clear/leave cancellation prevents late prepared content from committing', async () => {
  const swaps=createSkyboxSwapController(), loading=deferred(); let visible='A', disposed=false;
  const work=swaps.run(swaps.begin(),()=>loading.promise,v=>{visible=v;},()=>{disposed=true;});
  const rejection=assert.rejects(work,{name:'AbortError'});
  swaps.cancel(); visible=null; loading.resolve('B'); await rejection;
  assert.equal(visible,null); assert.equal(disposed,true);
});

test('recognizes existing forward/undo skybox batches without swallowing mixed operations',()=>{
  const add={kind:'scene-add',objectId:'sky-next',asset:{source:'generated-skybox',meshPath:'next.glb'}};
  const remove={kind:'scene-remove',objectId:'sky-old'};
  assert.equal(skyboxReplacementInBatch([remove,add]),add);
  assert.equal(skyboxReplacementInBatch([add,remove]),add);
  assert.equal(skyboxReplacementInBatch([add]),add);
  for(const ops of [[remove],[add,add],[add,{kind:'scene-remove',objectId:'cube'}],[add,{kind:'scene-env'}]]) assert.equal(skyboxReplacementInBatch(ops),null);
});
