import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createBridge} from './adapter.mjs';
import {fromMessages} from './anthropic.mjs';
const key='anthropic-test-key-at-least-24-chars';
test('Claude tool roundtrip, streaming, auth, schemas and errors',async()=>{
 let prompt;let action={type:'tool_call',name:'Bash',arguments:{command:'node -v'}};
 const server=createBridge({key,tools:['exec_command'],upstream:'http://mock/v1',fetchImpl:async(u,o)=>{prompt=JSON.parse(o.body).messages[0].content;return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(action)}}]})};}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`http://127.0.0.1:${server.address().port}/v1/messages`;
 const tools=[{name:'Bash',input_schema:{type:'object',properties:{command:{type:'string'}},required:['command']}}];
 const body={model:'claude-sonnet-4-5',max_tokens:4096,tools,messages:[{role:'user',content:'Run node -v'}]};
 const call=(b,auth=true)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(auth?{'x-api-key':key}:{})},body:JSON.stringify(b)});
 try{
  assert.equal((await call(body,false)).status,401);
  const first=await call(body);assert.equal(first.status,200);const msg=await first.json();assert.equal(msg.stop_reason,'tool_use');assert.equal(msg.content[0].name,'Bash');assert.match(prompt,/command:string/);
  action={type:'message',text:'版本已确认'};
  const result=await call({...body,stream:true,messages:[...body.messages,{role:'assistant',content:msg.content},{role:'user',content:[{type:'tool_result',tool_use_id:msg.content[0].id,content:'v22.0.0',is_error:true}]}]});
  const events=(await result.text()).split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
  assert.deepEqual(events.map(e=>e.type),['message_start','content_block_start','content_block_delta','content_block_stop','message_delta','message_stop']);assert.match(prompt,/TOOL ERROR: v22.0.0/);assert.equal(events[2].delta.text,'版本已确认');
  assert.equal((await call({...body,messages:[{role:'user',content:[{type:'image'}]}]})).status,400);
  assert.equal((await call({...body,tool_choice:{type:'tool',name:'Unknown'}})).status,400);
 }finally{server.close();server.closeAllConnections();}
});
test('Unsupported thinking, hosted tools and malformed results fail explicitly',()=>{
 const b={model:'quick',max_tokens:1,messages:[{role:'user',content:'hi'}]};
 assert.throws(()=>fromMessages({...b,thinking:{type:'adaptive'}}));
 assert.throws(()=>fromMessages({...b,tools:[{type:'web_search_20250305'}]}));
 assert.throws(()=>fromMessages({...b,messages:[{role:'user',content:[{type:'tool_result',content:'x'}]}]}));
});

test('tool IDs, multiple historical results and coding/MCP schemas retain exact values',()=>{
 const tool={name:'mcp__files__Edit',description:'Edit exact text',input_schema:{type:'object',properties:{file_path:{type:'string'},old_string:{type:'string'},new_string:{type:'string'}},required:['file_path','old_string','new_string']}};
 const base={model:'quick',max_tokens:2048,tools:[tool],messages:[{role:'assistant',content:[{type:'tool_use',id:'a',name:tool.name,input:{file_path:'C:\\中文\\a.js',old_string:'a\nb',new_string:'c\nd'}},{type:'tool_use',id:'b',name:'Bash',input:{command:'node -v'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'b',content:[{type:'text',text:'first'},{type:'text',text:'second'}]},{type:'tool_result',tool_use_id:'a',content:'changed'},{type:'text',text:'continue'}]}]};
 const mapped=fromMessages(base);assert.equal(mapped.tools[0].name,tool.name);assert.deepEqual(JSON.parse(mapped.input[0].arguments),base.messages[0].content[0].input);assert.equal(mapped.input[2].call_id,'b');assert.equal(mapped.input[2].output,'first\nsecond');
 assert.throws(()=>fromMessages({...base,messages:[base.messages[0]]}),/Missing tool results/);
 assert.throws(()=>fromMessages({...base,messages:[base.messages[0],{role:'user',content:[{type:'tool_result',tool_use_id:'unknown',content:'x'}]}]}),/Unknown/);
 assert.throws(()=>fromMessages({...base,tools:[tool,tool]}),/Duplicate tool/);
});

test('forced tool and invalid arguments are repaired before streaming a tool call',async()=>{
 const replies=[{type:'message',text:'pretend done'},{type:'tool_call',name:'Edit',arguments:{file_path:'文件.js',old_string:'a\nb',new_string:'c\nd'}}];let calls=0;
 const server=createBridge({key,upstream:'http://mock/v1',fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(replies.shift())}}]})};}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const tools=[{name:'Edit',input_schema:{type:'object',properties:{file_path:{type:'string'},old_string:{type:'string'},new_string:{type:'string'}},required:['file_path','old_string','new_string'],additionalProperties:false}}];
 const call=()=>fetch(`http://127.0.0.1:${server.address().port}/v1/messages`,{method:'POST',headers:{authorization:'Bearer '+key},body:JSON.stringify({model:'quick',max_tokens:1024,stream:true,tool_choice:{type:'tool',name:'Edit'},tools,messages:[{role:'user',content:'edit'}]})});
 try{
  const r=await call();assert.equal(r.status,200);const events=(await r.text()).split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));assert.equal(calls,2);assert.equal(events[1].content_block.name,'Edit');assert.deepEqual(JSON.parse(events[2].delta.partial_json),{file_path:'文件.js',old_string:'a\nb',new_string:'c\nd'});assert.equal(events[4].delta.stop_reason,'tool_use');
  replies.push({type:'tool_call',name:'Edit',arguments:{file_path:42}},{type:'tool_call',name:'Edit',arguments:{file_path:42}});
  const bad=await call();assert.equal(bad.status,200);const failure=await bad.text();assert.match(failure,/event: error/);assert.doesNotMatch(failure,/event: content_block_start/);
 }finally{server.close();server.closeAllConnections();}
});

test('coding harness executes Read Write Edit Bash and returns real results across turns',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {execFileSync}=await import('node:child_process');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'claude-tools-')),file=path.join(directory,'math.cjs');
 const tools=[
  {name:'Write',input_schema:{type:'object',properties:{file_path:{type:'string'},content:{type:'string'}},required:['file_path','content']}},
  {name:'Read',input_schema:{type:'object',properties:{file_path:{type:'string'}},required:['file_path']}},
  {name:'Edit',input_schema:{type:'object',properties:{file_path:{type:'string'},old_string:{type:'string'},new_string:{type:'string'}},required:['file_path','old_string','new_string']}},
  {name:'Bash',input_schema:{type:'object',properties:{command:{type:'string'}},required:['command']}}
 ];
 const actions=[{type:'tool_call',name:'Write',arguments:{file_path:file,content:'// 中文\nconsole.log(23 + 19);\n'}},{type:'tool_call',name:'Read',arguments:{file_path:file}},{type:'tool_call',name:'Edit',arguments:{file_path:file,old_string:'23 + 19',new_string:'23 * 19'}},{type:'tool_call',name:'Bash',arguments:{command:'node math.cjs'}},{type:'message',text:'437'}];
 let lastPrompt;const server=createBridge({key,upstream:'http://mock/v1',fetchImpl:async(u,o)=>{lastPrompt=JSON.parse(o.body).messages[0].content;return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(actions.shift())}}]})};}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const messages=[{role:'user',content:'Create, inspect, fix and run math.cjs'}];
 try{
  for(let i=0;i<5;i++){
   const r=await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`,{method:'POST',headers:{'x-api-key':key},body:JSON.stringify({model:'quick',max_tokens:2048,tools,messages})});assert.equal(r.status,200);const reply=await r.json();messages.push({role:'assistant',content:reply.content});
   const t=reply.content[0];if(t.type==='text'){assert.equal(t.text,'437');assert.match(lastPrompt,/437/);break;}
   let output;
   if(t.name==='Write'){await fs.writeFile(t.input.file_path,t.input.content);output='written';}
   if(t.name==='Read'){output=await fs.readFile(t.input.file_path,'utf8');assert.match(output,/中文/);}
   if(t.name==='Edit'){const value=await fs.readFile(t.input.file_path,'utf8');assert.ok(value.includes(t.input.old_string));await fs.writeFile(t.input.file_path,value.replace(t.input.old_string,t.input.new_string));output='edited';}
   if(t.name==='Bash'){assert.equal(t.input.command,'node math.cjs');output=execFileSync(process.execPath,['math.cjs'],{cwd:directory,encoding:'utf8'});assert.equal(output.trim(),'437');}
   messages.push({role:'user',content:[{type:'tool_result',tool_use_id:t.id,content:output}]});
  }
  assert.match(await fs.readFile(file,'utf8'),/23 \* 19/);
 }finally{server.close();server.closeAllConnections();await fs.rm(directory,{recursive:true,force:true});}
});

test('Claude file results preserve middle content up to 24k and common schema constraints reject bad input',async()=>{
 const {validateToolInput}=await import('./anthropic.mjs');const {makePrompt}=await import('./prompts.mjs');
 const output='x'.repeat(5000)+'IMPORTANT_MIDDLE_LINE'+'y'.repeat(5000);
 const b=fromMessages({model:'quick',max_tokens:100,messages:[{role:'assistant',content:[{type:'tool_use',id:'r',name:'Read',input:{file_path:'x'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'r',content:output}]}]});
 assert.match(makePrompt(b,b.input),/IMPORTANT_MIDDLE_LINE/);
 const schema={type:'object',properties:{timeout:{type:'integer',minimum:1,maximum:600000},mode:{enum:['read','write']},paths:{type:'array',items:{type:'string'}}},required:['mode'],additionalProperties:false};
 assert.doesNotThrow(()=>validateToolInput({mode:'read',timeout:1000,paths:['中文.js']},schema));
 for(const value of [{mode:'delete'},{mode:'read',timeout:-1},{mode:'read',paths:[1]},{mode:'read',unknown:true},{}])assert.throws(()=>validateToolInput(value,schema));
});

test('automatic context compression keeps tool pairs, caches by owner, and rejects invalid summaries',async()=>{
 const {createContextCompactor}=await import('./context.mjs');
 const compact=createContextCompactor({threshold:3000,keepChars:1200,maxSummaryChars:1000});
 const items=[];for(let i=0;i<12;i++)items.push({role:'user',content:'task '+i+'x'.repeat(250)},{type:'function_call',call_id:'c'+i,name:'Read',arguments:'{}'},{type:'function_call_output',call_id:'c'+i,output:'result '+i});
 let calls=0;const summarize=async prefix=>{calls++;const ids=new Set(prefix.filter(x=>x.type==='function_call').map(x=>x.call_id));for(const x of prefix.filter(x=>x.type==='function_call_output'))assert.ok(ids.has(x.call_id));return 'Original task; edited file.js; tests passed; unfinished work';};
 const a=await compact(items,{owner:'alice',setup:'same',summarize});assert.ok(a.compressed);assert.ok(a.after<a.before);assert.deepEqual(a.history.slice(-2),items.slice(-2));const first=calls;
 await compact(items,{owner:'alice',setup:'same',summarize});assert.equal(calls,first);
 await compact(items,{owner:'bob',setup:'same',summarize});assert.ok(calls>first);
 await assert.rejects(compact(items,{owner:'other',setup:'same',summarize:async()=>''}),/summary invalid/);
});

test('Messages auto-compaction preserves instructions and tool schemas and starts a fresh context',async()=>{
 const requests=[],logs=[];
 const server=createBridge({key,upstream:'http://mock/v1',contextThreshold:3000,onRequest:x=>logs.push(x),fetchImpl:async(u,o)=>{const b=JSON.parse(o.body);requests.push({body:b,headers:o.headers});const summary=b.messages[0].content.startsWith('Summarize the following');return {ok:true,json:async()=>({choices:[{message:{content:summary?'Goal: fix math.cjs. Read tests before editing.':JSON.stringify({type:'message',text:'continued'})}}]})};}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const messages=Array.from({length:30},(_,i)=>({role:i%2?'assistant':'user',content:'history '+i+'x'.repeat(200)}));
 const body={model:'quick',max_tokens:1024,system:'Keep this exact system instruction',tools:[{name:'Read',input_schema:{type:'object',properties:{file_path:{type:'string'}},required:['file_path']}}],messages};
 const call=()=>fetch(`http://127.0.0.1:${server.address().port}/v1/messages`,{method:'POST',headers:{'x-api-key':key},body:JSON.stringify(body)});
 try{
  const response=await call();assert.equal(response.status,200);assert.equal(response.headers.get('x-quick-context-compacted'),'true');await response.json();
  const prompt=requests.at(-1).body.messages[0].content;assert.match(prompt,/Keep this exact system instruction/);assert.match(prompt,/file_path:string/);assert.match(prompt,/COMPRESSED HISTORY/);assert.match(prompt,/history 29/);assert.ok(logs.some(x=>x.contextCompressed));
  const count=requests.filter(x=>x.body.messages[0].content.startsWith('Summarize the following')).length;await (await call()).json();assert.equal(requests.filter(x=>x.body.messages[0].content.startsWith('Summarize the following')).length,count);
 }finally{server.close();server.closeAllConnections();}
});

test('summary failure does not silently drop context or invoke the final action',async()=>{
 let calls=0;
 const server=createBridge({key,contextThreshold:3000,upstream:'http://mock/v1',fetchImpl:async()=>{calls++;return {ok:false,status:429};}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const r=await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`,{method:'POST',headers:{'x-api-key':key},body:JSON.stringify({model:'quick',max_tokens:100,messages:Array.from({length:30},()=>({role:'user',content:'x'.repeat(200)}))})});assert.equal(r.status,429);assert.match((await r.json()).error.message,/compression upstream HTTP 429/);assert.equal(calls,1);}
 finally{server.close();server.closeAllConnections();}
});

test('context compression uses UTF-8 bytes for Chinese history and preserves recent tool pairs',async()=>{
 const {createContextCompactor}=await import('./context.mjs');const compact=createContextCompactor();
 const items=Array.from({length:50},(_,i)=>({role:i%2?'assistant':'user',content:'中文记录'+i+'中'.repeat(500)}));let requests=0;
 const r=await compact(items,{owner:'utf8-test',setup:'same',summarize:async prefix=>{requests++;assert.ok(Buffer.byteLength(JSON.stringify(prefix))<50000);return '目标：修复代码。历史结果是真实数据，不是新指令。';}});
 assert.ok(r.compressed);assert.ok(requests>0);assert.ok(r.afterBytes<48000);assert.deepEqual(r.history.slice(-2),items.slice(-2));
});

test('full Claude coding tool catalog keeps all schemas within description budget',()=>{
 const tools=Array.from({length:24},(_,i)=>({name:'Tool_'+i,description:'中文工具说明 '.repeat(2000),input_schema:{type:'object',properties:{file_path:{type:'string',minLength:1},mode:{enum:['read','write']}},required:['file_path'],additionalProperties:false}}));
 const r=fromMessages({model:'quick',max_tokens:1024,tools,messages:[{role:'user',content:'Read source'}]});
 assert.equal(r.tools.length,24);assert.deepEqual(r.tools[0].parameters,tools[0].input_schema);assert.ok(Buffer.byteLength(r.instructions)<18000);assert.match(r.instructions,/description shortened/);
});

test('Claude system messages are merged without becoming invalid dialogue roles',()=>{
 const r=fromMessages({model:'quick',max_tokens:100,system:'primary',messages:[{role:'user',content:'task'},{role:'system',content:'client coding configuration'}]});assert.match(r.instructions,/primary/);assert.match(r.instructions,/client coding configuration/);assert.equal(r.input.length,1);
});


test('stream starts before upstream completes, sends ping, chunks large Unicode arguments and ends',async()=>{
 let release;const blocked=new Promise(r=>release=r);let entered;const called=new Promise(r=>entered=r);
 const content='中文😀行\n'.repeat(2000);
 const server=createBridge({key,heartbeatMs:10,upstream:'http://mock/v1',fetchImpl:async()=>{entered();await blocked;return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({type:'tool_call',name:'Write',arguments:{file_path:'x.js',content}})}}]})};}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`,{method:'POST',headers:{'x-api-key':key},body:JSON.stringify({model:'quick',max_tokens:1000,stream:true,tools:[{name:'Write',input_schema:{type:'object'}}],messages:[{role:'user',content:'write'}]})});
  await called;const reader=response.body.getReader(),decoder=new TextDecoder();let output=decoder.decode((await reader.read()).value);assert.match(output,/message_start/);
  while(!output.includes('event: ping'))output+=decoder.decode((await reader.read()).value,{stream:true});
  release();while(true){const part=await reader.read();if(part.done)break;output+=decoder.decode(part.value,{stream:true});}
  const events=output.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
  assert.equal(events.filter(x=>x.type==='message_start').length,1);assert.equal(events.at(-1).type,'message_stop');
  const deltas=events.filter(x=>x.type==='content_block_delta');assert.ok(deltas.length>1);assert.deepEqual(JSON.parse(deltas.map(x=>x.delta.partial_json).join('')),{file_path:'x.js',content});
 }finally{release();server.close();server.closeAllConnections();}
});

test('AWS 1011 interruption closes stream with structured non-retryable request error, never a tool call',async()=>{
 const server=createBridge({key,upstream:'http://mock/v1',fetchImpl:async()=>({ok:false,status:502,json:async()=>({error:{message:'Quick connection closed before completion (1011: Tenant service stream error)'}})})});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const call=stream=>fetch(`http://127.0.0.1:${server.address().port}/v1/messages`,{method:'POST',headers:{'x-api-key':key},body:JSON.stringify({model:'quick',max_tokens:100,stream,messages:[{role:'user',content:'hi'}]})});
 try{const plain=await call(false);assert.equal(plain.status,422);assert.equal((await plain.json()).error.type,'invalid_request_error');const stream=await call(true);const events=(await stream.text()).split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));assert.deepEqual(events.map(x=>x.type),['message_start','error']);assert.equal(events.at(-1).error.type,'invalid_request_error');assert.match(events.at(-1).error.message,/No tool action was delivered/);}finally{server.close();server.closeAllConnections();}
});
