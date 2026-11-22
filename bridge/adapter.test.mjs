import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createBridge,parseAction} from './adapter.mjs';
const key='test-local-key-at-least-24-characters';
const tools=[{type:'function',name:'read_file',parameters:{type:'object',properties:{path:{type:'string'}}}},{type:'custom',name:'apply_patch'}];
const grouped=[{type:'namespace',name:'demo_tools',tools}];
test('namespace parser requires exact scope and rejects invented child tools',()=>{
  assert.equal(parseAction('{"type":"tool_call","namespace":"demo_tools","name":"read_file","arguments":{}}',grouped).namespace,'demo_tools');
  assert.throws(()=>parseAction('{"type":"tool_call","name":"read_file","arguments":{}}',grouped));
  assert.throws(()=>parseAction('{"type":"tool_call","namespace":"wrong","name":"read_file","arguments":{}}',grouped));
  assert.throws(()=>parseAction('{"type":"tool_call","namespace":"demo_tools","name":"invented","arguments":{}}',grouped));
});
test('greeting and streamed namespace function/custom calls with continuation',async()=>{
  const replies=[{type:'message',text:'你好！'},{type:'tool_call',namespace:'demo_tools',name:'read_file',arguments:{path:'math.js'}},{type:'custom_tool_call',namespace:'demo_tools',name:'apply_patch',input:'patch'}];
  let captured;
  const server=createBridge({key,upstream:'http://mock/v1',fetchImpl:async(url,options)=>{captured=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(replies.shift())}}]})};}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const call=b=>fetch('http://127.0.0.1:'+server.address().port+'/v1/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify({model:'quick',tools:grouped,...b})});
  try{
    const hello=await call({input:'你好'});assert.equal(hello.status,200);assert.equal((await hello.json()).output[0].content[0].text,'你好！');
    assert.match(captured.messages[0].content,/EXACT_NAMESPACE_NAME/);
    const first=await call({input:'read file',stream:true});assert.equal(first.status,200);
    const events=(await first.text()).split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)));
    const completed=events.at(-1).response;const item=completed.output[0];
    assert.equal(item.namespace,'demo_tools');assert.equal(item.name,'read_file');
    assert.equal(events.find(e=>e.type==='response.output_item.added').item.namespace,'demo_tools');
    const next=await call({previous_response_id:completed.id,input:[{type:'function_call_output',call_id:item.call_id,output:'actual file contents'}]});
    const patch=(await next.json()).output[0];assert.equal(patch.type,'custom_tool_call');assert.equal(patch.namespace,'demo_tools');assert.equal(patch.input,'patch');
    assert.match(captured.messages[0].content,/actual file contents/);
    const invalid=await call({tools:[{type:'web_search'}],input:'hello'});assert.equal(invalid.status,400);assert.match((await invalid.json()).error.message,/web_search/);
  }finally{server.close();server.closeAllConnections();}
});
test('action parser rejects invented tools and invalid JSON; supports custom patches',()=>{
  assert.throws(()=>parseAction('I ran the command',tools));
  assert.throws(()=>parseAction('{"type":"tool_call","name":"invented","arguments":{}}',tools));
  assert.equal(parseAction('{"type":"custom_tool_call","name":"apply_patch","input":"patch"}',tools).input,'patch');
  assert.throws(()=>parseAction('{"type":"tool_call","name":"read_file","arguments":{}}',tools,'none'));
});
test('authentication, response continuation, streamed function calls and errors',async()=>{
  const replies=[{type:'tool_call',name:'read_file',arguments:{path:'math.js'}},{type:'message',text:'fixed'}];let captured;
  const server=createBridge({key,upstream:'http://mock/v1',fetchImpl:async(url,options)=>{captured=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(replies.shift())}}]})};}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+server.address().port+'/v1/responses';
  const call=(body,authorized=true)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(authorized?{authorization:'Bearer '+key}:{})},body:JSON.stringify(body)});
  try{
    assert.equal((await call({model:'quick'},false)).status,401);
    const first=await call({model:'quick',input:'fix math.js',tools,stream:true});const s=await first.text();
    const events=s.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
    assert.equal(events[0].type,'response.created');assert.ok(events.some(e=>e.type==='response.function_call_arguments.done'));
    const completed=events.at(-1);assert.equal(completed.type,'response.completed');const item=completed.response.output[0];assert.equal(item.name,'read_file');
    const second=await call({model:'quick',previous_response_id:completed.response.id,input:[{type:'function_call_output',call_id:item.call_id,output:'file content'}],tools});
    assert.equal((await second.json()).output[0].content[0].text,'fixed');assert.match(captured.messages[0].content,/file content/);assert.match(captured.messages[0].content,/fix math.js/);
    assert.equal((await call({model:'quick',previous_response_id:'missing'})).status,400);
    assert.equal((await call({model:'quick',tools:[{type:'web_search'}]})).status,400);
  }finally{server.close();server.closeAllConnections();}
});
test('core tool filter drops plugin/MCP tools before building the prompt',async()=>{
  let captured,logs=[];
  const big={type:'namespace',name:'mcp__node_repl',tools:[{type:'function',name:'js',parameters:{type:'object',description:'x'.repeat(400000)}}]};
  const server=createBridge({key,upstream:'http://mock/v1',tools:['exec_command'],onRequest:r=>logs.push(r),fetchImpl:async(url,options)=>{captured=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:'{"type":"tool_call","name":"exec_command","arguments":{"cmd":"node -v"}}'}}]})};}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const r=await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({model:'quick',input:'hi',tools:[{type:'function',name:'exec_command',parameters:{type:'object'}},big]})});
    assert.equal(r.status,200);
    const body=await r.json();
    assert.equal(body.output[0].name,'exec_command');
    assert.ok(!captured.messages[0].content.includes('mcp__node_repl'));
    assert.equal(logs.find(l=>l.droppedTools).droppedTools,1);
  }finally{server.close();}
});
