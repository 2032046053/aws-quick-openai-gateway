import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {pageReadAction,boundReadResults} from './file-context.mjs';
import {createContextCompactor} from './context.mjs';
import {createBridge} from './adapter.mjs';
const bytes=x=>Buffer.byteLength(JSON.stringify(x));
const tools=[{type:'function',name:'Read',parameters:{type:'object',properties:{file_path:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1}},required:['file_path'],additionalProperties:false}}];
const pair=(id,output)=>[{type:'function_call',call_id:id,name:'Read',arguments:JSON.stringify({file_path:'source.py',offset:1,limit:120})},{type:'function_call_output',call_id:id,output}];
test('Read gets a bounded page without changing paths, narrow ranges, unrelated tools or binary formats',()=>{
 const a={type:'tool_call',name:'Read',arguments:{file_path:'C:/中文/source.py'}};
 assert.deepEqual(pageReadAction(a,tools).arguments,{file_path:'C:/中文/source.py',offset:1,limit:120});assert.deepEqual(a.arguments,{file_path:'C:/中文/source.py'});
 const middle={...a,arguments:{file_path:'source.py',offset:350,limit:426}};
 assert.deepEqual(pageReadAction(middle,tools).arguments,{file_path:'source.py',offset:350,limit:120});
 for(const args of [{file_path:'x.py',offset:12,limit:35},{file_path:'doc.pdf',pages:'1-2'},{file_path:'x.ipynb'}]){
  const action={...a,arguments:args};assert.equal(pageReadAction(action,tools),action);
 }
 assert.equal(pageReadAction(a,[{...tools[0],parameters:{type:'object'}}]),a);
 assert.equal(pageReadAction(a,tools,0),a);
});
test('UTF-8 Read excerpts retain exact numbered prefix, continuation guidance and IDs without editing the real result',()=>{
 const text=Array.from({length:1000},(_,i)=>`${i+201}\t中文😀 line\n`).join('');const original=pair('r1',text);
 const bounded=boundReadResults(original,{maxBytes:3000});
 assert.equal(bounded.reduced,1);assert.equal(original[1].output,text);assert.equal(bounded.history[1].call_id,'r1');
 const excerpt=bounded.history[1].output;assert.ok(Buffer.byteLength(excerpt)<=3000);assert.ok(excerpt.startsWith('201\t中文😀'));assert.match(excerpt,/READ EXCERPT/);assert.match(excerpt,/offset=\d+/);assert.match(excerpt,/NOT the complete file/);assert.ok(!excerpt.includes('\uFFFD'));
 const error=pair('r2','TOOL ERROR: '+text);assert.equal(boundReadResults(error,{maxBytes:3000}).history[1],error[1]);
 const write=[{...original[0],name:'Write'},original[1]];assert.equal(boundReadResults(write,{maxBytes:3000}).reduced,0);
 const pdf=[{...original[0],arguments:'{"file_path":"doc.pdf"}'},original[1]];assert.equal(boundReadResults(pdf,{maxBytes:3000}).reduced,0);
});
test('large recent file regression fits a tight fixed-instruction budget while preserving the exact current task and last tool pair',async()=>{
 const input=[{role:'user',content:'old architecture '+'x'.repeat(17000)},{role:'assistant',content:'previous decisions'},{role:'user',content:'Modularize source.py without changing behavior.'},...pair('old','x'.repeat(6500)),...pair('latest','中文😀\n'.repeat(5500))];
 const bounded=boundReadResults(input,{maxBytes:3000}).history;
 const compact=createContextCompactor();let summaries=0;
 const result=await compact(bounded,{owner:'a',setup:'fixed',maxBytes:9000,summarize:async(events,limits)=>{
  summaries++;assert.ok(bytes(events)<=48000);assert.ok(limits.maxSummaryBytes<=3000);return 'Goal: modularize source.py without behavior change. Architecture inspected, no file edited. Re-read exact sections before editing.';
 }});
 assert.ok(summaries>0);assert.ok(result.afterBytes<=9000);assert.deepEqual(result.history.slice(-2),bounded.slice(-2));assert.ok(result.history.some(x=>x.content==='Modularize source.py without changing behavior.'));
});
test('growing transcripts reuse exact summary checkpoints, isolate owners/setups and keep paired tools in summary batches',async()=>{
 const compact=createContextCompactor({threshold:7000,keepChars:2000}),history=[{role:'user',content:'Keep this current task exactly.'}];let calls=0;
 const summarize=async(events)=>{
  calls++;const pending=new Set();for(const e of events){if(e.type==='function_call')pending.add(e.call_id);if(e.type==='function_call_output'){assert.ok(pending.has(e.call_id));pending.delete(e.call_id);}}assert.equal(pending.size,0);
  return 'Reference: inspect source.py, preserve interfaces, no edits yet.';
 };
 for(let i=0;i<14;i++)history.push(...pair('c'+i,'x'.repeat(1200)));
 const args={owner:'a',setup:'one',summarize};const first=await compact(history,args);const count=calls;
 const again=await compact(history,args);assert.equal(calls,count);assert.equal(again.checkpointsReused,1);assert.deepEqual(again.history,first.history);
 history.push(...pair('new','y'.repeat(1000)));const growing=await compact(history,args);assert.equal(growing.checkpointsReused,1);assert.ok(growing.afterBytes<=7000);
 await compact(history,{...args,owner:'b'});assert.ok(calls>count);const before=calls;
 await compact(history,{...args,setup:'changed'});assert.ok(calls>before);
});
test('summary inputs are batched under 48k and Unicode summaries are bounded by bytes, not JS string length',async()=>{
 const compact=createContextCompactor({threshold:8000,keepChars:2000});const history=[];
 for(let i=0;i<12;i++)history.push(...pair('c'+i,'源'.repeat(4500)));
 const bounded=boundReadResults(history,{maxBytes:6000}).history;let rounds=0;
 const result=await compact(bounded,{owner:'a',setup:'a',summarize:async(events)=>{rounds++;assert.ok(bytes(events)<=48000);return 'Historical code inspected. No write performed.';}});
 assert.ok(rounds>=2);assert.ok(result.afterBytes<=8000);
 const invalid=createContextCompactor({threshold:3000,keepChars:1000});
 await assert.rejects(invalid([{role:'user',content:'old '.repeat(1500)},{role:'assistant',content:'ok'},{role:'user',content:'current'}],{owner:'a',setup:'b',summarize:async()=> '中'.repeat(900)}),/summary invalid/);
});
test('impossible pinned context ends with a clear 422 instead of leaking an oversized prompt or repeatedly summarizing it',async()=>{
 const compact=createContextCompactor({threshold:3000,keepChars:1000});let calls=0;
 await assert.rejects(compact([{role:'user',content:'x'.repeat(5000)}],{owner:'a',setup:'a',summarize:async()=>{calls++;return 'short';}}),e=>e.status===422);
 assert.equal(calls,0);
});
test('SSE starts and pings while summarizing, recent file stays bounded and outgoing Read is paginated',async()=>{
 let release,entered;const blocked=new Promise(r=>release=r),summarizing=new Promise(r=>entered=r);const key='large-context-test-key-at-least-24-chars';const prompts=[];
 const server=createBridge({key,upstream:'http://mock/v1',heartbeatMs:10,protocolPreset:true,fetchImpl:async(u,o)=>{
  const prompt=JSON.parse(o.body).messages[0].content;prompts.push(prompt);
  if(prompt.startsWith('Summarize the following')){entered();await blocked;return {ok:true,json:async()=>({choices:[{message:{content:'Reference: source.py inspected. Goal unchanged. No edits yet.'}}]})};}
  return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({type:'tool_call',name:'Read',arguments:{file_path:'source.py',offset:400,limit:426}})}}]})};
 }});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const messages=[{role:'user',content:'architecture '.repeat(1600)},{role:'assistant',content:'noted'},{role:'user',content:'Modularize source.py without changing behavior.'},{role:'assistant',content:[{type:'tool_use',id:'old',name:'Read',input:{file_path:'source.py'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'old',content:'中文'.repeat(18000)}]}];
 try{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`,{method:'POST',headers:{'x-api-key':key},body:JSON.stringify({model:'quick',max_tokens:1024,stream:true,system:'S'.repeat(44000),tools:[{name:'Read',input_schema:tools[0].parameters}],messages})});
  const reader=response.body.getReader(),decoder=new TextDecoder();let output='';await summarizing;
  while(!output.includes('event: ping'))output+=decoder.decode((await reader.read()).value,{stream:true});
  assert.match(output,/message_start/);release();while(true){const next=await reader.read();if(next.done)break;output+=decoder.decode(next.value,{stream:true});}
  const events=output.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));assert.equal(events.at(-1).type,'message_stop');assert.equal(events.filter(e=>e.type==='message_start').length,1);
  const args=JSON.parse(events.filter(e=>e.type==='content_block_delta').map(e=>e.delta.partial_json).join(''));assert.deepEqual(args,{file_path:'source.py',offset:400,limit:120});
  const prompt=prompts.find(x=>!x.startsWith('Summarize the following'));assert.ok(Buffer.byteLength(prompt)<=56000);assert.match(prompt,/READ EXCERPT/);assert.match(prompt,/Modularize source.py/);
 }finally{release();server.close();server.closeAllConnections();}
});
