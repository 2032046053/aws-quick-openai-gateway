import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {optimizeMessages} from './prompt-optimizer.mjs';
import {fromMessages} from './anthropic.mjs';
import {createBridge} from './adapter.mjs';
const tool=name=>({name,description:'Exact original docs. Never execute before client approval.',input_schema:{type:'object',properties:{path:{type:'string',description:'Keep exact path semantics.'}},required:['path'],additionalProperties:false}});
const base={model:'quick',max_tokens:100,tools:['Read','Write','Skill','mcp__Claude_Browser__navigate','mcp__ccd_turn__update_plan'].map(tool),messages:[{role:'user',content:'Read code, then fix it.'}]};
test('coding profile is stable, keeps exact allowed definitions, honors extensions and rejects forced excluded tools',()=>{
 const before=JSON.stringify(base),a=optimizeMessages(base),b=optimizeMessages({...base,messages:[{role:'user',content:'browse then schedule'}]});
 assert.deepEqual(a.body.tools.map(t=>t.name),['Read','Write','Skill']);assert.deepEqual(a.body.tools,b.body.tools);assert.deepEqual(a.body.tools[0],base.tools[0]);
 assert.equal(JSON.stringify(base),before);assert.deepEqual(optimizeMessages(a.body).body,a.body);
 assert.equal(optimizeMessages(base,{profile:'all'}).body.tools.length,5);
 assert.equal(optimizeMessages(base,{extraTools:['mcp__Claude_Browser__navigate']}).body.tools.length,4);
 assert.throws(()=>optimizeMessages({...base,tool_choice:{type:'tool',name:base.tools[3].name}}),/disabled/);
 const invalid=structuredClone(base);invalid.tools[3].input_schema=null;
 assert.throws(()=>fromMessages(invalid,{promptOptimization:true}),/input_schema/);
});
test('recognized tool registries and disabled UI sections shrink, while approvals and unknown sections survive',()=>{
 const system='# Rules\nAsk for permission before changes.\n# TOOLS:\nRead\nWrite\n# Starting other sessions\nUse mcp__Claude_Browser__navigate to open a card.\n# Task list and wrap-up (this app)\nUse mcp__ccd_turn__update_plan for the sidebar.\n# Environment\nOS: Windows\nCWD: C:/private/project\n# Unknown\nKeep this exactly.\n';
 const {body,stats}=optimizeMessages({...base,system});
 assert.equal(stats.catalogSections,1);assert.equal(stats.uiSections,2);assert.match(body.system,/Ask for permission/);assert.match(body.system,/CWD: C:\/private\/project/);assert.match(body.system,/# Unknown\nKeep this exactly/);assert.doesNotMatch(body.system,/Starting other sessions/);
 const guarded='# Starting other sessions\nNever start mcp__Claude_Browser__navigate without approval.\n# TOOLS:\nRead\nUnknownFunction\n';
 assert.equal(optimizeMessages({...base,system:guarded}).body.system,guarded);
 assert.match(optimizeMessages({...base,system},{profile:'all'}).body.system,/Starting other sessions/);
 assert.match(optimizeMessages({...base,system:'```\n# Starting other sessions\nmcp__ccd_turn__update_plan\n```\n'}).body.system,/update_plan/);
});
test('skill catalogs keep names, concise purposes, paths and restrictions; unknown formats and no-loader catalogs are unchanged',()=>{
 const system='The following skills are available for use with the Skill tool:\n- `docx`: Create Word documents. Trigger: '+('Long trigger detail. '.repeat(60))+'\n  Never overwrite without approval.\n- `dataviz`: Create interactive charts. Trigger: many more conditions.\nToday\'s date: 2026-11-24\n# Environment\nWindows; keep CWD.\n';
 const {body,stats}=optimizeMessages({...base,system});assert.equal(stats.skillSections,1);assert.match(body.system,/`docx`: Create Word documents\./);assert.match(body.system,/Never overwrite without approval/);assert.match(body.system,/`dataviz`/);assert.match(body.system,/Today's date/);assert.ok(body.system.length<system.length/2);
 const xml='<skills>\n<skill><name>pdf</name><description>Read PDFs. Trigger: long detail.</description><location>C:/skills/pdf.md</location></skill>\n</skills>';
 const reduced=optimizeMessages({...base,system:[{type:'text',text:xml,cache_control:{type:'ephemeral'}}]}).body.system[0];assert.match(reduced.text,/Read PDFs\.<\/description>/);assert.match(reduced.text,/C:\/skills\/pdf.md/);assert.deepEqual(reduced.cache_control,{type:'ephemeral'});
 assert.equal(optimizeMessages({...base,tools:[tool('Read')],system}).body.system,system);
 const fenced='```xml\n'+xml+'\n```\n';assert.equal(optimizeMessages({...base,system:fenced}).body.system,fenced);
 const catalogExample='The following skills are available:\n'+fenced;assert.equal(optimizeMessages({...base,system:catalogExample}).body.system,catalogExample);
 const unknown='The following skills are available:\nThis is an unknown catalog.\nKeep all the conditions.';assert.equal(optimizeMessages({...base,system:unknown}).body.system,unknown);
});
test('only exact standalone repeated reminders are deduplicated, newest copies and changed rules are retained',()=>{
 const a='<system-reminder>Commit as Alice.</system-reminder>\n',b='<system-reminder>Commit as Bob.</system-reminder>\n';
 const input={...base,system:a,messages:[{role:'user',content:a+'First task'},{role:'assistant',content:'answer'},{role:'user',content:[{type:'text',text:a+b+'Current task'}]}]};
 const {body,stats}=optimizeMessages(input);assert.equal(stats.duplicateReminders,1);assert.equal(body.system,a);assert.equal(body.messages[0].content,'First task');assert.equal(body.messages[2].content[0].text,a+b+'Current task');
 const quoted='```xml\n'+a+'```\n> '+a+'Explain this.';
 assert.equal(optimizeMessages({...base,messages:[{role:'user',content:quoted},{role:'user',content:a}]}).body.messages[0].content,quoted);
 const env='<environment_context>Windows; CWD: C:/x</environment_context>\n';
 const e=optimizeMessages({...base,messages:[{role:'user',content:env+env+'task'}]});assert.equal(e.stats.duplicateEnvironments,1);assert.equal(e.body.messages[0].content,env+'task');
});
test('tool arguments/results, user skill examples, association ids and errors stay exact',()=>{
 const text='TOOLS:\nRead\nWrite\n<system-reminder>data</system-reminder>\n';
 const messages=[{role:'user',content:text},{role:'assistant',content:[{type:'tool_use',id:'call1',name:'Read',input:{path:text}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'call1',content:text,is_error:true},{type:'text',text:'Continue.'}]}];
 const before=JSON.stringify(messages),{body}=optimizeMessages({...base,messages});assert.equal(JSON.stringify(body.messages),before);
 const translated=fromMessages({...base,messages},{promptOptimization:true});assert.equal(translated.input[1].call_id,'call1');assert.equal(translated.input[2].call_id,'call1');assert.match(translated.input[2].output,/TOOL ERROR/);
});
test('optimized history reuse is preserved; moving a duplicate reminder rebuilds context instead of dropping new instructions',async()=>{
 const requests=[],logs=[],key='optimizer-test-key-at-least-24-chars';
 const server=createBridge({key,upstream:'http://mock/v1',claudeToolProfile:'coding',onRequest:x=>logs.push(x),fetchImpl:async(u,o)=>{requests.push({body:JSON.parse(o.body),headers:o.headers});return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({type:'message',text:'done'})}}]})};}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const reminder='<system-reminder>Approval required.</system-reminder>\n';let messages=[{role:'user',content:reminder+'task'}];
 const call=async()=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`,{method:'POST',headers:{'x-api-key':key},body:JSON.stringify({...base,messages})});assert.equal(r.status,200);return r.json();};
 try{
  let a=await call();messages.push({role:'assistant',content:a.content},{role:'user',content:'continue'});a=await call();assert.match(requests[1].body.messages[0].content,/^NEW EVENTS/);assert.equal(requests[0].headers['x-quick-session'],requests[1].headers['x-quick-session']);
  messages.push({role:'assistant',content:a.content},{role:'user',content:reminder+'next'});await call();assert.notEqual(requests[1].headers['x-quick-session'],requests[2].headers['x-quick-session']);assert.match(requests[2].body.messages[0].content,/Approval required/);assert.doesNotMatch(requests[2].body.messages[0].content,/mcp__Claude_Browser__navigate/);assert.ok(logs.some(x=>x.promptOptimization?.duplicateReminders===1));
 }finally{server.close();server.closeAllConnections();}
});
