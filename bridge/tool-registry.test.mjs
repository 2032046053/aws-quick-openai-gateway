import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createBridge} from './adapter.mjs';
import {createToolRegistry} from './tool-registry.mjs';
import {fromMessages} from './anthropic.mjs';
import {makePrompt,fingerprint} from './prompts.mjs';
const key='registry-test-key-at-least-24-chars';
const tools=Array.from({length:8},(_,i)=>({name:i?'Plugin_'+i:'Read',description:'Full use instructions. '.repeat(80),input_schema:{type:'object',properties:{path:{type:'string',description:'EXACT_PATH_SEMANTICS',minLength:1}},required:['path'],additionalProperties:false}}));
async function harness(reply,options={}){
 const requests=[];
 const server=createBridge({key,upstream:'http://mock/v1',...options,fetchImpl:async(u,o)=>{const prompt=JSON.parse(o.body).messages[0].content;requests.push({prompt,headers:o.headers});const value=await reply(prompt,requests);if(value?.status)return value;return {ok:true,headers:new Headers({'x-quick-revision':String(Number(o.headers['x-quick-revision'])+1)}),json:async()=>({choices:[{message:{content:JSON.stringify(value)}}]})};}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 return {requests,close:()=>{server.close();server.closeAllConnections();},call:(body={},owner='alice')=>fetch(`http://127.0.0.1:${server.address().port}/v1/messages`,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json','x-quick-principal':owner},body:JSON.stringify({model:'quick',max_tokens:1000,tools,messages:[{role:'user',content:'Read x'}],...body})})};
}
test('catalog retains every name; definitions retain exact original schemas and nested documentation',()=>{
 const b=fromMessages({model:'quick',max_tokens:1,tools,messages:[{role:'user',content:'read'}]},{deferTools:true});
 const prompt=makePrompt(b,b.input,{protocolPreset:true});for(const t of tools)assert.ok(prompt.includes(t.name));assert.ok(!prompt.includes('EXACT_PATH_SEMANTICS'));
 assert.deepEqual(JSON.parse(b.toolRegistry.definition('Read')),tools[0]);
 assert.ok(Buffer.byteLength(prompt)<Buffer.byteLength(JSON.stringify(tools))/3);
 const changed=structuredClone(tools);changed[0].input_schema.properties.path.description='new requirement';
 assert.notEqual(fingerprint(b),fingerprint(fromMessages({model:'quick',max_tokens:1,tools:changed,messages:[{role:'user',content:'read'}]},{deferTools:true})));
 assert.throws(()=>b.toolRegistry.load(['invented'],new Set()),/exact catalog/);
 assert.throws(()=>b.toolRegistry.load(['Read'],new Set(['Read'])),/already loaded/);
});
test('lookup stays internal, direct unloaded calls require definitions, continuation reuses once and isolates owners',async()=>{
 const h=await harness(prompt=>prompt.startsWith('TOOL DEFINITIONS')||prompt.startsWith('NEW EVENTS')?{type:'tool_call',name:'Read',arguments:{path:'x'}}:{type:'tool_lookup',names:['Read']});
 try{
  const first=await h.call();assert.equal(first.status,200);const a=await first.json();assert.equal(a.content[0].name,'Read');assert.equal(h.requests.length,2);assert.match(h.requests[1].prompt,/EXACT_PATH_SEMANTICS/);
  const messages=[{role:'user',content:'Read x'},{role:'assistant',content:a.content},{role:'user',content:[{type:'tool_result',tool_use_id:a.content[0].id,content:'actual content'}]}];
  assert.equal((await h.call({messages})).status,200);assert.equal(h.requests.length,3);assert.match(h.requests[2].prompt,/NEW EVENTS/);assert.doesNotMatch(h.requests[2].prompt,/EXACT_PATH_SEMANTICS/);
  assert.equal((await h.call({},'bob')).status,200);assert.equal(h.requests.length,5);assert.notEqual(h.requests[0].headers['x-quick-session'],h.requests[3].headers['x-quick-session']);
 }finally{h.close();}
 const direct=await harness(()=>({type:'tool_call',name:'Read',arguments:{path:'x'}}));
 try{assert.equal((await direct.call()).status,200);assert.equal(direct.requests.length,2);assert.match(direct.requests[1].prompt,/TOOL DEFINITIONS/);}finally{direct.close();}
});
test('unknown tools, tool_choice none, invalid args and repeated lookups never reach client execution',async()=>{
 for(const [action,body]of [[{type:'tool_lookup',names:['invented']},{}],[{type:'tool_lookup',names:['Read']},{tool_choice:{type:'none'}}],[{type:'tool_lookup',names:['Read']},{}],[{type:'tool_call',name:'Read',arguments:{path:42}},{}]]){
  const h=await harness(()=>action);try{const r=await h.call(body);assert.equal(r.status,502);assert.equal((await r.json()).type,'error');assert.ok(h.requests.length<=5);}finally{h.close();}
 }
});
test('lost native session clears loaded tools and bootstraps before loading definitions again',async()=>{
 let fail=false;
 const h=await harness((prompt,requests)=>{
  if(fail){fail=false;return {status:409,ok:false,json:async()=>({error:{code:'quick_session_missing'}})};}
  return {type:'tool_call',name:'Read',arguments:{path:'x'}};
 },{protocolPreset:true});
 try{
  const a=await(await h.call()).json();fail=true;
  const messages=[{role:'user',content:'Read x'},{role:'assistant',content:a.content},{role:'user',content:[{type:'tool_result',tool_use_id:a.content[0].id,content:'ok'}]}];
  assert.equal((await h.call({messages})).status,200);
  assert.equal(h.requests.filter(x=>x.prompt.startsWith('TOOL DEFINITIONS')).length,2);
  assert.notEqual(h.requests[0].headers['x-quick-session'],h.requests.at(-1).headers['x-quick-session']);
 }finally{h.close();}
});
test('oversized definitions fail clearly without truncating them or forwarding an action',async()=>{
 const huge=structuredClone(tools);huge[0].description='x'.repeat(60000);
 const h=await harness(()=>({type:'tool_lookup',names:['Read']}));
 try{const r=await h.call({tools:huge});assert.equal(r.status,413);assert.match((await r.json()).error.message,/full tool definitions exceed/);}finally{h.close();}
});

test('definition changes, forced tools and disabled registry choose the correct path',async()=>{
 const h=await harness(()=>({type:'tool_call',name:'Read',arguments:{path:'x'}}));
 try{
  const first=await(await h.call()).json();const changed=structuredClone(tools);changed[0].description+=' NEW_EXACT_REQUIREMENT';
  const messages=[{role:'user',content:'Read x'},{role:'assistant',content:first.content},{role:'user',content:[{type:'tool_result',tool_use_id:first.content[0].id,content:'ok'}]}];
  assert.equal((await h.call({tools:changed,messages,tool_choice:{type:'tool',name:'Read'}})).status,200);assert.match(h.requests.at(-1).prompt,/NEW_EXACT_REQUIREMENT/);assert.notEqual(h.requests[0].headers['x-quick-session'],h.requests.at(-1).headers['x-quick-session']);
 }finally{h.close();}
 const inline=await harness(()=>({type:'tool_call',name:'Read',arguments:{path:'x'}}),{toolRegistry:false});
 try{assert.equal((await inline.call()).status,200);assert.equal(inline.requests.length,1);assert.doesNotMatch(inline.requests[0].prompt,/TOOL REGISTRY/);}finally{inline.close();}
});
