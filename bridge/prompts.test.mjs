import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {compactTools,trimOutput,compactInput,makePrompt} from './prompts.mjs';
import {createBridge} from './adapter.mjs';

test('compact signatures remove verbose descriptions but retain parameter constraints and custom grammars',()=>{
  const tools=[{type:'function',name:'exec_command',description:'Safety details '.repeat(15000),parameters:{type:'object',required:['cmd'],additionalProperties:false,properties:{cmd:{type:'string',description:'long text'.repeat(1000),minLength:1},mode:{enum:['read','write']},description:{type:'string'}}}},{type:'namespace',name:'patches',tools:[{type:'custom',name:'patch',format:{type:'grammar',syntax:'lark',definition:'start: "patch"'}}]}];
  const compact=compactTools(tools);
  assert.ok(compact.length<JSON.stringify(tools).length*0.3);
  assert.match(compact,/cmd:string/);assert.match(compact,/mode\?:"read"\|"write"/);
  assert.match(compact,/description\?:string/);assert.match(compact,/minLength/);assert.match(compact,/noExtraFields/);assert.match(compact,/namespace=patches/);assert.match(compact,/start:/);
  const prompt=makePrompt({tools,instructions:'Keep approval requirements.'},[{role:'user',content:'hello'}]);
  assert.equal(prompt.split('\nINSTRUCTIONS:')[0].split('\n').length,5);
  assert.match(prompt,/Keep approval requirements/);
});
test('tool output keeps its head and tail within 2000 characters, without truncating user instructions',()=>{
  const text='HEAD'+'.'.repeat(6000)+'TAIL';const result=trimOutput(text);
  assert.equal(result.length,2000);assert.ok(result.startsWith('HEAD'));assert.ok(result.endsWith('TAIL'));assert.match(result,/truncated/);
  const input=compactInput([{type:'function_call_output',output:text},{role:'tool',content:text},{role:'user',content:text}]);
  assert.equal(input[0].output.length,2000);assert.equal(input[1].content.length,2000);assert.equal(input[2].content.length,text.length);
});
test('Responses continuation sends only new events and isolates owners; full-prefix clients also reuse',async()=>{
  const key='session-test-key-with-24-characters';let calls=[];
  const tools=[{type:'function',name:'exec_command',parameters:{type:'object',properties:{cmd:{type:'string'}},required:['cmd']}}];
  const server=createBridge({key,upstream:'http://mock/v1',fetchImpl:async(url,options)=>{
    calls.push(options);
    const text=JSON.stringify({type:'tool_call',name:'exec_command',arguments:{cmd:'node -v'}});
    return {ok:true,headers:new Headers({'x-quick-revision':String(Number(options.headers['x-quick-revision'])+1),'x-quick-conversation-id':'native-thread'}),json:async()=>({choices:[{message:{content:text}}]})};
  }});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const call=(body,owner='alice')=>fetch(`http://127.0.0.1:${server.address().port}/v1/responses`,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json','x-quick-principal':owner},body:JSON.stringify({model:'quick',tools,...body})});
  try{
    const first=await(await call({input:'unique initial task'})).json();
    const output={type:'function_call_output',call_id:first.output[0].call_id,output:'HEAD'+'.'.repeat(5000)+'TAIL'};
    const second=await(await call({previous_response_id:first.id,input:[output]})).json();
    const a=calls[0],b=calls[1];assert.equal(a.headers['x-quick-session'],b.headers['x-quick-session']);
    assert.equal(b.headers['x-quick-revision'],'1');
    const delta=JSON.parse(b.body).messages[0].content;assert.ok(!delta.includes('unique initial task'));assert.ok(!delta.includes('TOOLS:'));assert.match(delta,/truncated/);
    assert.equal(second.metadata.quick_conversation_id,'native-thread');assert.equal(second.metadata.quick_reused,true);
    assert.equal((await call({previous_response_id:first.id,input:'steal'},'bob')).status,400);
    await(await call({input:[{role:'user',content:'unique initial task'},first.output[0],output,second.output[0],{type:'function_call_output',call_id:second.output[0].call_id,output:'new result'}]})).json();
    assert.equal(calls[2].headers['x-quick-session'],a.headers['x-quick-session']);assert.equal(calls[2].headers['x-quick-revision'],'2');
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('an evicted/stale upstream session is explicitly bootstrapped once, not silently retried after generation',async()=>{
  const key='recovery-test-key-with-24-characters';let calls=[],fail=false;
  const server=createBridge({key,upstream:'http://mock/v1',fetchImpl:async(url,options)=>{
    calls.push(options);
    if(fail){fail=false;return {ok:false,status:409,json:async()=>({error:{code:'quick_session_missing'}})};}
    return {ok:true,json:async()=>({choices:[{message:{content:'{"type":"message","text":"ok"}'}}]})};
  }});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const call=body=>fetch(`http://127.0.0.1:${server.address().port}/v1/responses`,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({model:'quick',...body})});
  try{
    const first=await(await call({input:'remember me'})).json();fail=true;
    assert.equal((await call({previous_response_id:first.id,input:'continue'})).status,200);
    assert.equal(calls.length,3);assert.notEqual(calls[1].headers['x-quick-session'],calls[2].headers['x-quick-session']);
    assert.match(JSON.parse(calls[2].body).messages[0].content,/remember me/);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
