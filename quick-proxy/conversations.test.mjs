import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Conversations} from './conversations.mjs';
test('full transcript reuse requires the same caller and exact prefix, not just a common first message',()=>{
  const store=new Conversations();const first=[{role:'system',content:'same instructions'},{role:'user',content:'task A'}];
  const a=store.acquire({principal:'alice',messages:first});a.commit('answer');a.release();
  const history=[...first,{role:'assistant',content:'answer'},{role:'user',content:'continue'}];
  const b=store.acquire({principal:'alice',messages:history});assert.equal(b.threadId,a.threadId);assert.deepEqual(b.delta,[history.at(-1)]);b.commit('next');b.release();
  const other=store.acquire({principal:'bob',messages:history});assert.notEqual(other.threadId,a.threadId);other.release();
  const newTask=store.acquire({principal:'alice',messages:[first[0],{role:'user',content:'task B'}]});assert.notEqual(newTask.threadId,a.threadId);newTask.release();
});
test('explicit revisions serialize a thread; cancellation, expiry and cache loss cannot silently reuse stale context',()=>{
  let now=0;const store=new Conversations({now:()=>now,ttlMs:10});
  const options={principal:'alice',sessionId:'opaque-session',revision:0,incremental:true,messages:[{role:'user',content:'setup'}]};
  const a=store.acquire(options);assert.throws(()=>store.acquire(options),e=>e.code==='quick_session_busy');a.commit('ok');a.release();
  assert.throws(()=>store.acquire(options),e=>e.code==='quick_session_conflict');
  assert.throws(()=>store.acquire({...options,principal:'bob',revision:1}),e=>e.code==='quick_session_missing');
  const b=store.acquire({...options,revision:1});assert.equal(a.threadId,b.threadId);b.release();
  assert.throws(()=>store.acquire({...options,revision:1}),e=>e.code==='quick_session_missing');
  const c=store.acquire(options);c.commit('ok');c.release();now=11;
  assert.throws(()=>store.acquire({...options,revision:1}),e=>e.code==='quick_session_missing');
});
