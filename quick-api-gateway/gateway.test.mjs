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
