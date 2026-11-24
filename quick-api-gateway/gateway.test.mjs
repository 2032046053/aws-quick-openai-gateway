import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {issueKey,revokeKey,readKeys} from './keys.mjs';
import {createGateway} from './gateway.mjs';

test('per-user keys, stream preservation, history isolation, revocation and scope limits',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'quick-gateway-')),file=path.join(directory,'keys.json');
  const alice=issueKey(file,'Alice'),bob=issueKey(file,'Bob'),limited=issueKey(file,'Chat only',{scopes:['chat'],rpm:1});
  assert.equal(JSON.stringify(readKeys(file)).includes(alice.apiKey),false);
  const internalKey='internal-key-is-never-shared';
  let upstreamCalls=0,receivedKey,receivedPrincipal,id=0;
  const upstream=http.createServer(async(req,res)=>{
    upstreamCalls++;receivedKey=req.headers.authorization;receivedPrincipal=req.headers['x-quick-principal'];
    let raw='';for await(const c of req)raw+=c;
    if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end('{"data":[{"id":"quick"}]}');return;}
    const input=JSON.parse(raw);
    if(req.url==='/v1/chat/completions'){
      res.setHeader('content-type','text/event-stream');res.write('data: {"choices":[{"delta":{"content":"你');
      res.end('好"}}]}\n\ndata: [DONE]\n\n');return;
    }
    assert.equal(req.url,'/v1/responses');
    const data={id:'resp_'+(++id),object:'response',output:[]};
    if(input.stream){
      res.setHeader('content-type','text/event-stream');
      const text=`event: response.created\r\ndata: ${JSON.stringify({response:data})}\r\n\r\n`;
      for(let i=0;i<text.length;i+=7)res.write(text.slice(i,i+7));res.end();
    }else{res.setHeader('content-type','application/json');res.end(JSON.stringify(data));}
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const server=createGateway({keysFile:file,chatURL:`http://127.0.0.1:${upstream.address().port}/v1`,responsesURL:`http://127.0.0.1:${upstream.address().port}/v1`,upstreamKey:internalKey,publicPrefix:'/quick'});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}/quick/v1`;
  const post=(apiKey,route,data)=>fetch(base+route,{method:'POST',headers:{authorization:'Bearer '+apiKey,'content-type':'application/json','x-quick-principal':'forged-owner'},body:JSON.stringify(data)});
  try{
    assert.equal((await fetch(base+'/models')).status,401);
    assert.equal((await fetch(base+'/models',{headers:{authorization:'Bearer '+internalKey}})).status,401);
    const chat=await post(alice.apiKey,'/chat/completions',{model:'quick',messages:[],stream:true});
    assert.equal(chat.status,200);assert.match(await chat.text(),/你好/);assert.equal(receivedKey,'Bearer '+internalKey);assert.equal(receivedPrincipal,alice.record.id);
    const first=await (await post(alice.apiKey,'/responses',{model:'quick',input:'hello'})).json();
    assert.equal(first.id,'resp_1');
    const calls=upstreamCalls;
    assert.equal((await post(bob.apiKey,'/responses',{previous_response_id:first.id,input:'private'})).status,400);
    assert.equal(upstreamCalls,calls);
    assert.equal((await post(alice.apiKey,'/responses',{previous_response_id:first.id,input:'continue'})).status,200);
    const sse=await post(alice.apiKey,'/responses',{input:'hello',stream:true});assert.match(await sse.text(),/resp_3/);
    assert.equal((await post(bob.apiKey,'/responses',{previous_response_id:'resp_3',input:'steal'})).status,400);
    assert.equal((await post(alice.apiKey,'/responses',{previous_response_id:'resp_3',input:'continue'})).status,200);
    assert.equal((await post(limited.apiKey,'/responses',{})).status,403);
    await (await post(limited.apiKey,'/chat/completions',{})).text();
    assert.equal((await post(limited.apiKey,'/chat/completions',{})).status,429);
    revokeKey(file,alice.record.id);
    assert.equal((await post(alice.apiKey,'/responses',{})).status,401);
  }finally{
    server.closeAllConnections();upstream.closeAllConnections();
    await new Promise(r=>server.close(r));await new Promise(r=>upstream.close(r));
    for(const name of fs.readdirSync(directory))fs.unlinkSync(path.join(directory,name));fs.rmdirSync(directory);
  }
});

test('Messages gateway accepts x-api-key and beta query without forwarding forged identity',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'quick-messages-')),file=path.join(directory,'keys.json');
 const alice=issueKey(file,'Alice'),limited=issueKey(file,'Chat',{scopes:['chat']});let captured;
 const upstream=http.createServer(async(req,res)=>{captured={url:req.url,headers:req.headers};for await(const c of req){}res.setHeader('content-type','application/json');res.end('{"type":"message","content":[]}');});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const base=`http://127.0.0.1:${upstream.address().port}/v1`;
 const gateway=createGateway({keysFile:file,chatURL:base,responsesURL:base,upstreamKey:'internal',publicPrefix:'/quick'});
 gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
 const call=apiKey=>fetch(`http://127.0.0.1:${gateway.address().port}/quick/v1/messages?beta=true`,{method:'POST',headers:{'x-api-key':apiKey,'x-quick-principal':'forged'},body:JSON.stringify({model:'quick',messages:[]})});
 try{assert.equal((await call(alice.apiKey)).status,200);assert.equal(captured.url,'/v1/messages');assert.equal(captured.headers.authorization,'Bearer internal');assert.equal(captured.headers['x-quick-principal'],alice.record.id);assert.equal(captured.headers['x-api-key'],undefined);assert.equal((await call(limited.apiKey)).status,403);}
 finally{gateway.close();gateway.closeAllConnections();upstream.close();upstream.closeAllConnections();fs.rmSync(directory,{recursive:true,force:true});}
});

test('SSE forwards headers and first event before completion; client cancellation and whole-stream timeout close upstream',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'quick-stream-')),file=path.join(directory,'keys.json');
 const alice=issueKey(file,'SSE test');let closeUpstream,sendEvent;
 const upstream=http.createServer(async(req,res)=>{
  for await(const chunk of req){}
  res.on('close',()=>closeUpstream?.());
  res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();
  sendEvent=()=>res.write('event: ping\ndata: {"type":"ping"}\n\n');
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const base=`http://127.0.0.1:${upstream.address().port}/v1`;
 const gateway=createGateway({keysFile:file,chatURL:base,responsesURL:base,upstreamKey:'internal',timeoutMs:500});
 gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
 const call=()=>fetch(`http://127.0.0.1:${gateway.address().port}/v1/messages`,{method:'POST',headers:{'x-api-key':alice.apiKey},body:JSON.stringify({stream:true})});
 try{
  const cancelled=new Promise(r=>closeUpstream=r);
  const first=await call();assert.equal(first.status,200);assert.match(first.headers.get('cache-control'),/no-transform/);assert.equal(first.headers.get('x-accel-buffering'),'no');
  const reader=first.body.getReader();sendEvent();assert.match(new TextDecoder().decode((await reader.read()).value),/event: ping/);
  await reader.cancel();await cancelled;
  const timedOut=new Promise(r=>closeUpstream=r);
  const second=await call();sendEvent();const secondReader=second.body.getReader();await secondReader.read();
  await timedOut;
  await assert.rejects(secondReader.read());
 }finally{gateway.close();gateway.closeAllConnections();upstream.close();upstream.closeAllConnections();fs.rmSync(directory,{recursive:true,force:true});}
});

test('key failover preserves request body, principal, SSE and response ownership; user auth never enters the pool',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'quick-pool-gateway-')),file=path.join(directory,'keys.json');
 const alice=issueKey(file,'Alice'),bob=issueKey(file,'Bob'),limited=issueKey(file,'Chat only',{scopes:['chat']});
 const captured=[],logs=[];let rejectedClosed=false;
 const upstream=http.createServer(async(req,res)=>{
  let body='';for await(const c of req)body+=c;
  captured.push({key:req.headers.authorization,owner:req.headers['x-quick-principal'],url:req.url,body});
  if(req.headers.authorization==='Bearer expired'){
   res.on('close',()=>rejectedClosed=true);res.writeHead(429,{'retry-after':'30'});res.write('limited');return;
  }
  if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end('{"data":[{"id":"quick"}]}');return;}
  if(req.url==='/v1/responses'){res.setHeader('content-type','application/json');res.end('{"id":"resp_pool1","object":"response","output":[]}');return;}
  res.setHeader('content-type','text/event-stream');res.end('event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const base=`http://127.0.0.1:${upstream.address().port}/v1`;
 const gateway=createGateway({keysFile:file,chatURL:base,responsesURL:base,upstreamKeys:['expired','valid'],log:x=>logs.push(x)});
 gateway.listen(0,'127.0.0.1');await once(gateway,'listening');const url=`http://127.0.0.1:${gateway.address().port}`;
 const post=(token,path,body)=>fetch(url+path,{method:'POST',headers:{'x-api-key':token,authorization:'Bearer '+token,'x-quick-principal':'forged'},body:JSON.stringify(body)});
 try{
  const health=await (await fetch(url+'/healthz')).json();assert.equal(health.upstreamKeyPoolSize,2);
  const body={model:'quick',stream:true,messages:[{role:'user',content:'request body intact'}]};
  const stream=await post(alice.apiKey,'/v1/messages',body);assert.equal(stream.status,200);assert.match(await stream.text(),/message_stop/);
  assert.equal(captured.length,2);assert.ok(rejectedClosed);assert.equal(captured[0].body,captured[1].body);assert.deepEqual(JSON.parse(captured[1].body),body);assert.ok(captured.every(x=>x.owner===alice.record.id));
  await (await post(alice.apiKey,'/v1/responses',{model:'quick',input:'hello'})).json();const count=captured.length;
  assert.equal((await post(bob.apiKey,'/v1/responses',{previous_response_id:'resp_pool1',input:'steal'})).status,400);
  assert.equal((await post(limited.apiKey,'/v1/messages',body)).status,403);
  assert.equal((await post('not-a-user-key','/v1/messages',body)).status,401);assert.equal(captured.length,count);
  const models=await fetch(url+'/v1/models',{headers:{authorization:'Bearer '+alice.apiKey}});assert.equal(models.status,200);await models.json();assert.equal(captured.at(-1).key,'Bearer valid');
  const serialized=JSON.stringify(logs);for(const secret of [alice.apiKey,bob.apiKey,'Bearer expired','Bearer valid'])assert.ok(!serialized.includes(secret));assert.ok(logs.some(x=>x.event==='upstream_attempt'&&x.attempt===2));
 }finally{gateway.close();gateway.closeAllConnections();upstream.close();upstream.closeAllConnections();fs.rmSync(directory,{recursive:true,force:true});}
});

test('a started SSE error is not replayed; exhausted upstream keys return retry-after without leaking credentials',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'quick-pool-failures-')),file=path.join(directory,'keys.json');
 const alice=issueKey(file,'Alice');let calls=0,mode='stream';
 const upstream=http.createServer(async(req,res)=>{
  for await(const c of req){}calls++;
  if(mode==='stream'){res.writeHead(200,{'content-type':'text/event-stream'});res.end('event: error\ndata: {"type":"error","error":{"message":"generation failed"}}\n\n');}
  else{res.writeHead(401);res.end('bad upstream authentication');}
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const base=`http://127.0.0.1:${upstream.address().port}/v1`;
 const gateway=createGateway({keysFile:file,chatURL:base,responsesURL:base,upstreamKeys:['first','second']});gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
 const call=()=>fetch(`http://127.0.0.1:${gateway.address().port}/v1/messages`,{method:'POST',headers:{'x-api-key':alice.apiKey},body:JSON.stringify({stream:true})});
 try{
  assert.match(await (await call()).text(),/generation failed/);assert.equal(calls,1);
  mode='bad';const last=await call();assert.equal(last.status,401);await last.text();assert.equal(calls,3);
  const unavailable=await call();assert.equal(unavailable.status,503);assert.ok(Number(unavailable.headers.get('retry-after'))>0);const text=await unavailable.text();assert.doesNotMatch(text,/first|second/);assert.equal(calls,3);
 }finally{gateway.close();gateway.closeAllConnections();upstream.close();upstream.closeAllConnections();fs.rmSync(directory,{recursive:true,force:true});}
});
