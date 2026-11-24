import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createUpstreamPool} from './upstream-pool.mjs';
import {upstreamConfig} from './config.mjs';
const ok=()=>new Response('{"ok":true}',{headers:{'content-type':'application/json'}});
test('round robin deduplicates keys, isolates headers and handles concurrent requests without repeated per-request attempts',async()=>{
 const calls=[],logs=[];
 const pool=createUpstreamPool({keys:['one','two','one'],fetchImpl:async(u,o)=>{calls.push({key:o.headers.get('authorization'),clientKey:o.headers.get('x-api-key'),owner:o.headers.get('x-quick-principal')});return ok();}});
 const init={headers:{authorization:'caller-secret','x-api-key':'caller-key','x-quick-principal':'alice'}};
 for(let i=0;i<4;i++)await (await pool.fetch('http://local',init,x=>logs.push(x))).response.text();
 assert.equal(pool.size,2);assert.deepEqual(calls.map(x=>x.key),['Bearer one','Bearer two','Bearer one','Bearer two']);assert.ok(calls.every(x=>x.clientKey===null&&x.owner==='alice'));assert.equal(init.headers.authorization,'caller-secret');
 assert.ok(logs.every(x=>/^upstream-\d+$/.test(x.keySlot)));assert.doesNotMatch(JSON.stringify(logs),/Bearer|caller-secret/);
 const byBody=new Map();
 const concurrent=createUpstreamPool({keys:['a','b','c'],fetchImpl:async(u,o)=>{const list=byBody.get(o.body)||[];list.push(o.headers.get('authorization'));byBody.set(o.body,list);await new Promise(r=>setImmediate(r));return new Response('bad',{status:401});}});
 await Promise.all([concurrent.fetch('http://local',{body:'r1'}),concurrent.fetch('http://local',{body:'r2'})]);
 for(const list of byBody.values())assert.equal(new Set(list).size,list.length);
});
test('401/403/429 switch before response, release rejected bodies and respect cooldown and Retry-After',async()=>{
 for(const status of [401,403,429]){
  let cancelled=false,clock=1000;const calls=[];
  const pool=createUpstreamPool({keys:['bad','good'],now:()=>clock,fetchImpl:async(u,o)=>{
   const key=o.headers.get('authorization');calls.push(key);
   if(key==='Bearer bad')return new Response(new ReadableStream({cancel(){cancelled=true;}}),{status,headers:{'retry-after':'120'}});
   assert.ok(cancelled);return ok();
  }});
  assert.equal((await pool.fetch('http://local')).attempts,2);assert.equal(pool.available,1);
  await pool.fetch('http://local');await pool.fetch('http://local');assert.equal(calls.filter(x=>x==='Bearer bad').length,1);
  clock+=120001;assert.equal(pool.available,2);
 }
});
test('finite attempt budget, exhausted cooldown, non-retryable and transport errors never cause unbounded replay',async()=>{
 let calls=0,clock=0;
 const pool=createUpstreamPool({keys:['a','b','c'],maxAttempts:2,now:()=>clock,fetchImpl:async()=>{calls++;return new Response('limited',{status:429,headers:{'retry-after':'2'}});}});
 assert.equal((await pool.fetch('http://local')).response.status,429);assert.equal(calls,2);
 assert.equal((await pool.fetch('http://local')).response.status,429);assert.equal(calls,3);
 await assert.rejects(pool.fetch('http://local'),e=>e.status===503&&e.retryAfter===10);assert.equal(calls,3);
 clock=10001;assert.equal(pool.available,3);
 for(const status of [400,422,500,502]){
  calls=0;const nonRetry=createUpstreamPool({keys:['a','b'],fetchImpl:async()=>{calls++;return new Response('error',{status});}});
  assert.equal((await nonRetry.fetch('http://local')).response.status,status);assert.equal(calls,1);
 }
 calls=0;const network=createUpstreamPool({keys:['a','b'],fetchImpl:async()=>{calls++;throw new Error('transport failed');}});
 await assert.rejects(network.fetch('http://local',{method:'POST'}),/transport failed/);assert.equal(calls,1);
});
test('SSE success/error bodies are not read or retried by the pool; aborted requests do not send any attempt',async()=>{
 let calls=0,cancelled=false;
 const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('event: error\ndata: {"type":"error"}\n\n'));},cancel(){cancelled=true;}});
 const pool=createUpstreamPool({keys:['a','b'],fetchImpl:async()=>{calls++;return new Response(stream,{headers:{'content-type':'text/event-stream'}});}});
 const {response}=await pool.fetch('http://local');assert.equal(calls,1);assert.equal(response.bodyUsed,false);
 const reader=response.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/event: error/);await reader.cancel();assert.ok(cancelled);assert.equal(calls,1);
 const controller=new AbortController();controller.abort();await assert.rejects(pool.fetch('http://local',{signal:controller.signal}),e=>e.name==='AbortError');assert.equal(calls,1);
});
test('configuration defaults to existing internal key, supports file/environment, validates without disclosing secrets',()=>{
 assert.deepEqual(upstreamConfig({},'internal').upstreamKeys,['internal']);
 assert.equal(upstreamConfig({REQUEST_TIMEOUT_MS:'180000'},'internal').timeoutMs,180000);
 assert.deepEqual(upstreamConfig({UPSTREAM_API_KEYS:' a, b, a '},'old').upstreamKeys,['a','b']);
 assert.deepEqual(upstreamConfig({GATEWAY_UPSTREAM_KEYS_FILE:'private'},'old',()=>'{"apiKeys":["a","b"]}').upstreamKeys,['a','b']);
 for(const env of [{UPSTREAM_API_KEYS:'a',GATEWAY_UPSTREAM_KEYS_FILE:'file'},{RETRY_STATUS_CODES:'500'},{UPSTREAM_MAX_ATTEMPTS:'0'},{UPSTREAM_KEY_HEADER:'cookie'},{REQUEST_TIMEOUT_MS:'NaN'},{REQUEST_TIMEOUT_MS:'0'}])assert.throws(()=>upstreamConfig(env,'old'));
 assert.throws(()=>upstreamConfig({GATEWAY_UPSTREAM_KEYS_FILE:'file'},'old',()=>'{BAD-SECRET'),e=>!e.message.includes('BAD-SECRET'));
 assert.throws(()=>createUpstreamPool({keys:['abc\nSECRET']}),e=>!e.message.includes('SECRET'));
 const custom=createUpstreamPool({keys:['a'],keyHeader:'x-api-key',fetchImpl:async(u,o)=>{assert.equal(o.headers.get('authorization'),null);assert.equal(o.headers.get('x-api-key'),'a');return ok();}});
 return custom.fetch('http://local');
});
