import {createToolRegistry} from './tool-registry.mjs';
import {optimizeMessages} from './prompt-optimizer.mjs';
import {randomUUID} from 'node:crypto';
const invalid=message=>{throw Object.assign(new Error(message),{status:400});};
export function toolDescriptions(tools){
  const maxPerTool=Math.min(900,Math.floor(14000/Math.max(1,tools.length)));
  return tools.filter(t=>t.description).map(t=>{
    const text=String(t.description);let short='';
    for(const c of text){if(Buffer.byteLength(short+c)>maxPerTool)break;short+=c;}
    return 'Tool '+t.name+': '+short+(short.length<text.length?' [description shortened; use exact schema]':'');
  });
}
export function fromMessages(b,{deferTools=false,promptOptimization=false,toolProfile='coding',extraTools=[]}={}){
  if(!b||typeof b!=='object'||Array.isArray(b))invalid('Expected a JSON object');
  if(typeof b.model!=='string'||!b.model)invalid('model is required');
  if(b.tools!==undefined&&!Array.isArray(b.tools))invalid('tools must be an array');
  if(!Array.isArray(b.messages)||!b.messages.length)invalid('messages must be a nonempty array');
  if(!Number.isInteger(b.max_tokens)||b.max_tokens<1)invalid('max_tokens must be a positive integer');
  const text=content=>{
    if(typeof content==='string')return content;
    if(!Array.isArray(content)||content.some(c=>c.type!=='text'||typeof c.text!=='string'))invalid('Only text content is supported');
    return content.map(c=>c.text).join('\n');
  };
  if(b.thinking&&b.thinking.type!=='disabled')invalid('Extended thinking is unsupported; disable thinking');
  const tools=(b.tools||[]).map(t=>{
    if(!t||typeof t!=='object')invalid('Invalid tool definition');
    if(t.type&&t.type!=='custom')invalid('Hosted Anthropic tools are unsupported');
    if(typeof t.name!=='string'||! /^[a-zA-Z0-9_-]{1,128}$/.test(t.name)||!t.input_schema||t.input_schema.type!=='object')invalid('Tool name and input_schema required');
    return {type:'function',name:t.name,description:t.description,parameters:t.input_schema};
  });
  if(new Set(tools.map(t=>t.name)).size!==tools.length)invalid('Duplicate tool names');
  const extraSystem=[];
  const input=[],pending=new Map(),seen=new Set();
  for(const m of b.messages){
    if(m?.role==='system'){extraSystem.push(text(m.content));continue;}
    if(!m||!['user','assistant'].includes(m.role))invalid('Invalid message role');
    if(pending.size&&m.role!=='user')invalid('Tool results must follow tool_use');
    if(pending.size&&(typeof m.content==='string'||!Array.isArray(m.content)||m.content[0]?.type!=='tool_result'))invalid('Pending tools require tool_result blocks first');
    if(typeof m.content==='string'){input.push({role:m.role,content:m.content});continue;}
    if(!Array.isArray(m.content))invalid('Invalid message content');
    let nonResult=false;
    for(const c of m.content){
      if(!c||typeof c!=='object')invalid('Invalid content block');
      if(c.type!=='tool_result')nonResult=true;
      if(c.type==='text')input.push({role:m.role,content:text([c])});
      else if(c.type==='tool_use'&&m.role==='assistant'){
        if(typeof c.id!=='string'||typeof c.name!=='string'||!c.input||typeof c.input!=='object'||Array.isArray(c.input))invalid('Invalid tool_use');
        if(!c.id||seen.has(c.id))invalid('Duplicate or empty tool_use id');
        seen.add(c.id);pending.set(c.id,c.name);
        input.push({type:'function_call',call_id:c.id,name:c.name,arguments:JSON.stringify(c.input)});
      }else if(c.type==='tool_result'&&m.role==='user'){
        if(typeof c.tool_use_id!=='string'||!pending.has(c.tool_use_id))invalid('Unknown or duplicate tool_result id');
        if(nonResult)invalid('tool_result blocks must precede text');
        pending.delete(c.tool_use_id);
        input.push({type:'function_call_output',call_id:c.tool_use_id,output:(c.is_error?'TOOL ERROR: ':'')+text(c.content??'')});
      }else invalid('Unsupported content block: '+c.type);
    }
    if(m.role==='user'&&pending.size)invalid('Missing tool results');
  }
  if(pending.size)invalid('Missing tool results');
  const choice=b.tool_choice||{type:'auto'};
  if(!choice||!['auto','none','any','tool'].includes(choice.type))invalid('Invalid tool_choice');
  if(choice.type==='tool'&&!tools.some(t=>t.name===choice.name))invalid('Unknown forced tool');
  if(['any','tool'].includes(choice.type)&&!tools.length)invalid('tool_choice requires tools');
  if(promptOptimization){
    const optimized=optimizeMessages(b,{profile:toolProfile,extraTools});
    return {...fromMessages(optimized.body,{deferTools}),promptOptimization:optimized.stats};
  }
  const registry=deferTools&&(tools.length>=8||Buffer.byteLength(JSON.stringify(tools))>12000)?createToolRegistry(tools,b.tools):null;
  const codingHint=tools.some(t=>['Write','Edit','NotebookEdit'].includes(t.name))?'For large code changes, prefer focused Edit calls after reading the file. Keep each generated patch or Write content under about 6000 characters; use multiple client-approved actions for larger changes. Never claim a write until its real tool result.':'';
  const requirement=choice.type==='any'?'Required: select a tool.':choice.type==='tool'?'Required: call only tool '+choice.name+'.':'';
  return {model:'quick',input,tools,...(registry?{toolRegistry:registry,toolPrompt:registry.catalog}:{}),toolOutputLimit:24000,instructions:[codingHint,text(b.system??''),...extraSystem,...(registry?[]:toolDescriptions(b.tools||[])),requirement].filter(Boolean).join('\n'),tool_choice:choice.type==='none'?'none':choice.type==='any'?'required':choice.type==='tool'?{type:'function',name:choice.name}:'auto',stream:false};
}
export function toMessage(item,model){
  const tool=item.type==='function_call';
  return {id:'msg_'+randomUUID().replaceAll('-',''),type:'message',role:'assistant',model,content:[tool?{type:'tool_use',id:item.call_id,name:item.name,input:JSON.parse(item.arguments)}:{type:'text',text:item.content[0].text}],stop_reason:tool?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:0,output_tokens:0}};
}
export function startMessageStream(res,model){
  const message=toMessage({type:'message',content:[{text:''}]},model);
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','x-accel-buffering':'no'});
  res.flushHeaders();
  res.write('event: message_start\ndata: '+JSON.stringify({type:'message_start',message:{...message,content:[],stop_reason:null}})+'\n\n');
  return message;
}
export function sendMessage(res,message,stream,started){
  if(!stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(message));return;}
  if(started)message={...message,id:started.id};
  else res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  const emit=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
  if(!started)emit('message_start',{message:{...message,content:[],stop_reason:null}});
  const block=message.content[0],tool=block.type==='tool_use';
  emit('content_block_start',{index:0,content_block:tool?{...block,input:{}}:{type:'text',text:''}});
  const text=tool?JSON.stringify(block.input):block.text;
  for(let i=0;i<text.length;i+=1024)emit('content_block_delta',{index:0,delta:tool?{type:'input_json_delta',partial_json:text.slice(i,i+1024)}:{type:'text_delta',text:text.slice(i,i+1024)}});
  emit('content_block_stop',{index:0});
  emit('message_delta',{delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:0}});
  emit('message_stop',{});res.end();
}

// Validate common coding-tool constraints before handing an action to the client.
// Unrecognized JSON Schema keywords remain in the prompt; this is not a full validator.
export function validateToolInput(value,schema,path='arguments',depth=0){
 if(depth>64)throw new Error('Tool schema nesting limit exceeded');
 const fail=reason=>{throw new Error(path+': '+reason);};
 if(schema===false)fail('value is forbidden');
 if(!schema||schema===true)return;
 const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 if(schema.enum&&!schema.enum.some(x=>equal(x,value)))fail('value must match enum');
 if(Object.hasOwn(schema,'const')&&!equal(schema.const,value))fail('value must match const');
 const matches=type=>type==='null'?value===null:type==='array'?Array.isArray(value):type==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):type==='integer'?Number.isInteger(value):type==='number'?typeof value==='number'&&Number.isFinite(value):typeof value===type;
 if(schema.type&&!(Array.isArray(schema.type)?schema.type:[schema.type]).some(matches))fail('expected '+schema.type);
 for(const sub of schema.allOf||[])validateToolInput(value,sub,path,depth+1);
 for(const keyword of ['anyOf','oneOf'])if(schema[keyword]){
  const count=schema[keyword].filter(sub=>{try{validateToolInput(value,sub,path,depth+1);return true;}catch{return false;}}).length;
  if(keyword==='oneOf'?count!==1:!count)fail('does not satisfy '+keyword);
 }
 if(value&&typeof value==='object'&&!Array.isArray(value)){
  for(const name of schema.required||[])if(!Object.hasOwn(value,name))fail('missing required property '+name);
  for(const [name,child]of Object.entries(value)){
   if(Object.hasOwn(schema.properties||{},name))validateToolInput(child,schema.properties[name],path+'.'+name,depth+1);
   else if(!schema.patternProperties){if(schema.additionalProperties===false)fail('unknown property '+name);if(typeof schema.additionalProperties==='object')validateToolInput(child,schema.additionalProperties,path+'.'+name,depth+1);}
  }
 }
 if(Array.isArray(value)){
  if(schema.minItems!==undefined&&value.length<schema.minItems)fail('too few items');
  if(schema.maxItems!==undefined&&value.length>schema.maxItems)fail('too many items');
  if(schema.items)for(let i=0;i<value.length;i++)validateToolInput(value[i],schema.items,path+'['+i+']',depth+1);
 }
 if(typeof value==='string'){
  const length=[...value].length;
  if(schema.minLength!==undefined&&length<schema.minLength)fail('string too short');
  if(schema.maxLength!==undefined&&length>schema.maxLength)fail('string too long');
 }
 if(typeof value==='number'){
  if(schema.minimum!==undefined&&value<schema.minimum)fail('below minimum');
  if(schema.maximum!==undefined&&value>schema.maximum)fail('above maximum');
 }
}
