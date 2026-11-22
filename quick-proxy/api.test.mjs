import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import OpenAI from 'openai';
import {WebSocketServer} from 'ws';
import {createApiServer} from './api-server.mjs';
import {createQuickClient,buildRequest} from './quick-client.mjs';
import {encodeEvent,EventDecoder} from './quick-protocol.mjs';
import {EventStreamCodec} from '@smithy/eventstream-codec';
import {toUtf8,fromUtf8} from '@smithy/util-utf8';
import {Encoder} from 'cbor-x';

test('decode actual captured EventStream/CBOR frame and reject corrupted CRC',()=>{
  const actual=Buffer.from('AAAAlwAAAFRqArGECzpldmVudC10eXBlBwAOcmF3T3V0cHV0RXZlbnQNOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2Nib3INOm1lc3NhZ2UtdHlwZQcABWV2ZW50v2dwYXlsb2FkWCd7InR5cGUiOiJrZWVwYWxpdmUiLCJ0cyI6MTc5NTMxMTYxNjczNn3/Oyza7w==','base64');
  const decoder=new EventDecoder();
  assert.deepEqual(decoder.push(actual.subarray(0,20)),[]);
  assert.equal(decoder.push(actual.subarray(20))[0].type,'keepalive');
  actual[actual.length-1]^=1;
  assert.throws(()=>new EventDecoder().push(actual));
});
test('AWS active-connection limits retain their reason and become HTTP 429',()=>{
  const bytes=new EventStreamCodec(toUtf8,fromUtf8).encode({headers:{':message-type':{type:'string',value:'exception'},':exception-type':{type:'string',value:'limitExceededException'}},body:new Encoder({useRecords:false}).encode({message:'Too many active connections. Maximum allowed: 3'})});
  assert.throws(()=>new EventDecoder().push(bytes),e=>e.status===429&&e.code==='quick_limit_exceeded'&&e.message.includes('Maximum allowed: 3'));
});

test('official SDK through API and binary Quick transport',async()=>{
  const upstream=http.createServer();
  const wss=new WebSocketServer({server:upstream});
  let request;
  wss.on('connection',(ws,req)=>{
    const protocols=req.headers['sec-websocket-protocol'].split(',').map(x=>x.trim());
    assert.equal(JSON.parse(decodeURIComponent(protocols[1])).csrfToken,'abc%2Fdef%3D');
    assert.equal(req.headers.cookie,'session=mock');
    const decoder=new EventDecoder();
    ws.send(encodeEvent({type:'connected'},'rawOutputEvent'));
    ws.on('message',bytes=>{
      for(const e of decoder.push(bytes))if(e.type==='user_message'){
        request=e;
        const root={thread_id:e.payload.thread_id,message_id:'msg-reply',scope:'chat'};
        for(const event of [
          {type:'message_start',payload:{role:'assistant'}},
          {type:'text_delta',payload:{delta:'你好，'}},
          {type:'text_delta',payload:{delta:'世界'}},
          {type:'message_complete',payload:{text:'你好，世界',tool_calls:[]}},
        ])ws.send(encodeEvent({...root,...event},'rawOutputEvent'));
      }
    });
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const complete=createQuickClient({accountId:'123456789012',cookie:'session=mock',csrf:'abc%2Fdef%3D',wsUrl:`ws://127.0.0.1:${upstream.address().port}/chat`,timeoutMs:3000});
  const key='test-key-with-at-least-24-characters';
  const server=createApiServer({key,complete});server.listen(0,'127.0.0.1');await once(server,'listening');
  const baseURL=`http://127.0.0.1:${server.address().port}/v1`;
  const client=new OpenAI({apiKey:key,baseURL,maxRetries:0});
  try{
    assert.equal((await client.models.list()).data[0].id,'quick');
    const messages=[{role:'system',content:'使用中文'},{role:'user',content:'你好'}];
    const result=await client.chat.completions.create({model:'quick',messages});
    assert.equal(result.choices[0].message.content,'你好，世界');
    assert.equal(request.payload.custom_prompt,'使用中文');
    const firstThread=request.payload.thread_id;
    let text='',finish;
    for await(const chunk of await client.chat.completions.create({model:'quick',messages,stream:true})){
      text+=chunk.choices[0]?.delta.content||'';finish=chunk.choices[0]?.finish_reason||finish;
    }
    assert.equal(text,'你好，世界');assert.equal(finish,'stop');
    assert.notEqual(request.payload.thread_id,firstThread);
    await assert.rejects(()=>client.chat.completions.create({model:'quick',messages,tools:[]}),e=>e.status===400);
    const unauthorized=new OpenAI({apiKey:'wrong',baseURL,maxRetries:0});
    await assert.rejects(()=>unauthorized.models.list(),e=>e.status===401);
    const bad=await fetch(baseURL+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+key},body:'broken'});
    assert.equal(bad.status,400);
    assert.equal((await fetch(baseURL+'/chat/completions',{headers:{authorization:'Bearer '+key}})).status,405);
  }finally{
    for(const ws of wss.clients)ws.terminate();
    server.closeAllConnections();upstream.closeAllConnections();
    await new Promise(r=>server.close(r));await new Promise(r=>wss.close(r));await new Promise(r=>upstream.close(r));
  }
});

test('history translation rejects images and preserves all text turns',()=>{
  const request=buildRequest([{role:'user',content:'记住731'},{role:'assistant',content:'已记住'},{role:'user',content:'数字是什么'}]);
  assert.equal(JSON.parse(request.text).conversation_history[0].text,'记住731');
  assert.throws(()=>buildRequest([{role:'user',content:[{type:'image_url',image_url:{url:'data:'}}]}]));
});

test('upstream failure is an HTTP error before SSE starts',async()=>{
  const key='another-test-key-with-24-characters';
  const server=createApiServer({key,complete:async function*(){throw Object.assign(new Error('Session expired'),{status:502});}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer '+key},body:JSON.stringify({model:'quick',messages:[{role:'user',content:'hi'}],stream:true})});
    assert.equal(response.status,502);assert.match(response.headers.get('content-type'),/application\/json/);
    assert.equal((await response.json()).error.message,'Session expired');
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('three native turns reuse one thread and send only new input, with caller isolation',async()=>{
  const upstream=http.createServer(),wss=new WebSocketServer({server:upstream});const transcripts=new Map(),sent=[],workingIds=[];
  wss.on('connection',(ws,req)=>{
    workingIds.push(new URL(req.url,'http://mock').searchParams.get('workingSessionId'));
    const decoder=new EventDecoder();ws.send(encodeEvent({type:'connected'},'rawOutputEvent'));
    ws.on('message',bytes=>{
      for(const e of decoder.push(bytes))if(e.type==='user_message'){
        const {thread_id,text}=e.payload;sent.push({thread_id,text});
        const prior=transcripts.get(thread_id)||[];prior.push(text);transcripts.set(thread_id,prior);
        const answer=prior.length===1?'ACK':'remembered TOKEN_abc';
        ws.send(encodeEvent({type:'message_start',thread_id,message_id:'answer',payload:{role:'assistant'}},'rawOutputEvent'));
        ws.send(encodeEvent({type:'message_complete',thread_id,message_id:'answer',payload:{text:answer,tool_calls:[]}},'rawOutputEvent'));
      }
    });
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const client=createQuickClient({accountId:'123456789012',cookie:'session=mock',csrf:'abc',wsUrl:`ws://127.0.0.1:${upstream.address().port}/chat`});
  const messages=[{role:'user',content:'remember TOKEN_abc'}];const metadata=[];
  const turn=async(principal='alice')=>{
    let answer;
    for await(const event of client({messages,principal})){if(event.type==='session')metadata.push(event);if(event.type==='done')answer=event.text;}
    messages.push({role:'assistant',content:answer});return answer;
  };
  try{
    await turn();messages.push({role:'user',content:'recall'});assert.equal(await turn(),'remembered TOKEN_abc');
    messages.push({role:'user',content:'recall again'});await turn();
    assert.equal(new Set(sent.map(s=>s.thread_id)).size,1);
    assert.deepEqual(sent.map(s=>s.text),['remember TOKEN_abc','recall','recall again']);
    assert.deepEqual(metadata.map(m=>m.reused),[false,true,true]);
    assert.equal(new Set(workingIds).size,1);
    messages.push({role:'user',content:'new caller'});await turn('bob');assert.equal(new Set(sent.map(s=>s.thread_id)).size,2);
  }finally{
    for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>upstream.close(r));
  }
});
