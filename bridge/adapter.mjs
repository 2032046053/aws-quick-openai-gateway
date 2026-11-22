import http from 'node:http';
import fs from 'node:fs';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {makePrompt,compactInput,compactTools,fingerprint,historyPrefix} from './prompts.mjs';
export {makePrompt} from './prompts.mjs';

export function parseAction(text, tools=[], toolChoice) {
  let s=text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/,'$1');
  // Quick sometimes appends an empty source footer. Only this exact empty footer is removable.
  s=s.replace(/\s*<sources>\s*<\/sources>\s*$/,'');
  let a; try {a=JSON.parse(s);} catch {throw new Error('Quick returned invalid action JSON');}
  if(a.type==='message' && typeof a.text==='string' && a.text.trim()) return a;
  if(toolChoice==='none') throw new Error('Quick attempted a disabled tool');
  const available=a.namespace === undefined ? tools : tools.find(t=>t.type==='namespace'&&t.name===a.namespace)?.tools||[];
  const t=available.find(t=>t.name===a.name&&['function','custom'].includes(t.type));
  if(!t) throw new Error('Quick selected an unknown tool');
  if(a.type==='tool_call' && t.type==='function' && a.arguments && typeof a.arguments==='object' && !Array.isArray(a.arguments)) return a;
  if(a.type==='custom_tool_call' && t.type==='custom' && typeof a.input==='string') return a;
  throw new Error('Quick returned an invalid tool action');
}

function outputItem(a) {
  if(a.type==='message') return {id:'msg_'+randomUUID().replaceAll('-',''),type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:a.text,annotations:[]}]};
  const call_id='call_'+randomUUID().replaceAll('-','');
  const scope=a.namespace === undefined ? {} : {namespace:a.namespace};
  if(a.type==='custom_tool_call') return {id:'ctc_'+randomUUID().replaceAll('-',''),type:'custom_tool_call',status:'completed',call_id,name:a.name,...scope,input:a.input};
  return {id:'fc_'+randomUUID().replaceAll('-',''),type:'function_call',status:'completed',call_id,name:a.name,...scope,arguments:JSON.stringify(a.arguments)};
}

export const CORE_TOOLS=['exec_command','shell','shell_command','local_shell','write_stdin','apply_patch','update_plan','request_user_input','request_permissions'];
export function createBridge({key,upstream,upstreamKey=key,fetchImpl=fetch,timeoutMs=120000,onRequest=()=>{},tools='all'}) {
  const toolFilter=tools==='all'?null:new Set(tools);
  const cache=new Map(); let active=0;
  if(typeof key!=='string'||key.length<24) throw new Error('A local key of at least 24 characters is required');
  return http.createServer(async(req,res)=>{
    const path=req.url?.split('?')[0];
    const error=(status,message)=>{if(res.destroyed)return;if(res.headersSent){res.write(`event: error\ndata: ${JSON.stringify({type:'error',code:'adapter_error',message})}\n\n`);res.end();}else{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'adapter_error',message}}));}};
    if(path==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end('{"status":"ok","experimental":true}');return;}
    const auth=Buffer.from(req.headers.authorization||''), expected=Buffer.from('Bearer '+key);
    if(auth.length!==expected.length||!timingSafeEqual(auth,expected)){error(401,'Invalid API key');return;}
    if(path==='/v1/models'&&req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({object:'list',data:[{id:'quick',object:'model',created:0,owned_by:'quick-codex-experimental'}]}));return;}
    if(path!=='/v1/responses'||req.method!=='POST'){error(404,'Use POST /v1/responses');return;}
    if(active>=2){error(429,'Adapter is busy');return;}
    active++; const controller=new AbortController();let heartbeat;
    const abort=()=>controller.abort();res.once('close',abort);
    const timer=setTimeout(abort,timeoutMs);
    try {
      const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>4*1024*1024)throw Object.assign(new Error('Request exceeds 4 MiB'),{status:413});chunks.push(chunk);}
      let b;try{b=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('Invalid JSON'),{status:400});}
      if(!['quick','quick-codex'].includes(b.model))throw Object.assign(new Error('Use model quick'),{status:400});
      if(b.background)throw Object.assign(new Error('Background responses are unsupported'),{status:400});
      const supported=t=>t&&(['function','custom'].includes(t.type)||(t.type==='namespace'&&typeof t.name==='string'&&Array.isArray(t.tools)&&t.tools.length>0&&t.tools.every(c=>c&&['function','custom'].includes(c.type))));
      if(!Array.isArray(b.tools||[]))throw Object.assign(new Error('tools must be an array'),{status:400});
      // Codex Desktop sends dozens of plugin/MCP tool schemas (often >300k chars). Quick cannot handle that context,
      // so by default only core coding tools are exposed. Set QUICK_CODEX_TOOLS=all to forward every tool.
      if(toolFilter&&Array.isArray(b.tools)){const dropped=b.tools.filter(t=>!toolFilter.has(t?.name));if(dropped.length){b.tools=b.tools.filter(t=>toolFilter.has(t?.name));onRequest({droppedTools:dropped.length,droppedChars:JSON.stringify(dropped).length});}}
      const unsupported=(b.tools||[]).filter(t=>!supported(t));
      if(unsupported.length){onRequest({unsupportedTools:unsupported.map(t=>({name:t?.name,type:t?.type}))});throw Object.assign(new Error('Unsupported tool types: '+unsupported.map(t=>t?.type||'invalid').join(', ')+'. Supports external function/custom tools and namespace groups; hosted tools must be disabled.'),{status:400});}
      const owner=String(req.headers['x-quick-principal']||'local');
      if(!/^[a-zA-Z0-9_.:-]{1,160}$/.test(owner))throw Object.assign(new Error('Invalid principal'),{status:400});
      let previous=b.previous_response_id ? cache.get(b.previous_response_id) : null;
      if(previous&&previous.owner!==owner)throw Object.assign(new Error('Previous response not found for this caller'),{status:400});
      if(b.previous_response_id&&!previous)throw Object.assign(new Error('Previous response not found; resend full input history'),{status:400});
      const input=typeof b.input==='string'?[{role:'user',content:b.input}]:(b.input||[]);
      if(!Array.isArray(input))throw Object.assign(new Error('input must be text or an array'),{status:400});
      if(b.instructions!==undefined&&typeof b.instructions!=='string')throw Object.assign(new Error('instructions must be text'),{status:400});
      const compact=compactInput(input),setup=fingerprint(b);
      if(!previous&&!b.previous_response_id){
        const matches=[...cache.values()].filter(x=>x.owner===owner&&x.setup===setup&&historyPrefix(x.history,compact));
        const longest=Math.max(-1,...matches.map(x=>x.history.length));
        const best=matches.filter(x=>x.history.length===longest);if(best.length===1)previous=best[0];
      }
      const history=b.previous_response_id?[...(previous?.history||[]),...compact]:compact;
      if(JSON.stringify(history).includes('"type":"input_image"'))throw Object.assign(new Error('Images are unsupported'),{status:400});
      let reuse=!!previous&&previous.setup===setup;
      const delta=b.previous_response_id?compact:compact.slice(reuse?previous.history.length:0);
      let prompt=makePrompt(b,reuse?delta:history,{incremental:reuse});
      let sessionId=reuse?previous.sessionId:randomUUID(),revision=reuse?previous.revision:0;
      if(prompt.length>350000){onRequest({oversized:true,promptChars:prompt.length,instructionsChars:(b.instructions||'').length,historyChars:JSON.stringify(history).length,inputItems:input.length,toolSizes:(b.tools||[]).map(t=>({name:t.name,type:t.type,chars:JSON.stringify(t).length})).sort((x,y)=>y.chars-x.chars).slice(0,12)});}
      if(prompt.length>350000)throw Object.assign(new Error('Quick experimental context limit exceeded'),{status:413});
      onRequest({inputItems:input.length,toolNames:(b.tools||[]).map(t=>({name:t.name,type:t.type})),promptChars:prompt.length,reused:reuse,toolJsonChars:JSON.stringify(b.tools||[]).length,toolSignatureChars:compactTools(b.tools).length});
      const base={id:'resp_'+randomUUID().replaceAll('-',''),object:'response',created_at:Math.floor(Date.now()/1000),model:b.model,status:'in_progress',output:[],error:null,incomplete_details:null,parallel_tool_calls:false,tool_choice:b.tool_choice||'auto',tools:b.tools||[],metadata:{}};
      let sequence=0;
      const event=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,sequence_number:sequence++,...data})}\n\n`);
      if(b.stream){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});res.flushHeaders();event('response.created',{response:base});event('response.in_progress',{response:base});heartbeat=setInterval(()=>res.write(': waiting for Quick\n\n'),10000);}
      let action,lastError;
      for(let attempt=0;attempt<2;attempt++){
        const send=content=>fetchImpl(upstream.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+upstreamKey,'x-quick-principal':owner,'x-quick-session':sessionId,'x-quick-revision':String(revision),'x-quick-incremental':'1'},body:JSON.stringify({model:'quick',messages:[{role:'user',content}]}),signal:controller.signal});
        const content=attempt?'Protocol error: '+lastError.message+'. Return one valid JSON action for the listed tools, or a message.':prompt;
        let r=await send(content);
        if(r.status===409&&!attempt){
          const failure=await r.json();
          if(['quick_session_missing','quick_session_conflict','quick_session_busy'].includes(failure.error?.code)){
            sessionId=randomUUID();revision=0;reuse=false;prompt=makePrompt(b,history);
            if(prompt.length>350000)throw Object.assign(new Error('Full-history recovery exceeds context limit'),{status:413});
            r=await send(prompt);onRequest({sessionRecovery:true,promptChars:prompt.length});
          }else throw Object.assign(new Error('Quick session was rejected'),{status:409});
        }
        if(!r.ok){let detail='';try{const failure=await r.json();if(typeof failure.error?.message==='string')detail=': '+failure.error.message.slice(0,240);}catch{}throw Object.assign(new Error('Quick upstream HTTP '+r.status+detail),{status:r.status===429?429:502});}
        const data=await r.json(),text=data.choices?.[0]?.message?.content;
        revision=Number(r.headers?.get('x-quick-revision')||revision+1);
        const conversationId=r.headers?.get('x-quick-conversation-id');
        if(conversationId)base.metadata.quick_conversation_id=conversationId;
        base.metadata.quick_reused=reuse;
        base.metadata.quick_sent_chars=Number(r.headers?.get('x-quick-sent-chars')||content.length);
        if(conversationId&&!res.headersSent)res.setHeader('x-quick-conversation-id',conversationId);
        if(!res.headersSent){res.setHeader('x-quick-reused',String(reuse));res.setHeader('x-quick-sent-chars',r.headers?.get('x-quick-sent-chars')||String(content.length));}
        onRequest({quickConversationId:conversationId,reused:reuse,revision,sentChars:Number(r.headers?.get('x-quick-sent-chars')||content.length)});
        if(typeof text!=='string')throw new Error('Quick upstream returned no text');
        try{action=parseAction(text,b.tools,b.tool_choice);break;}catch(e){lastError={text,message:e.message};}
      }
      if(!action)throw new Error(lastError.message+' after one protocol repair');
      if(process.env.QUICK_CODEX_DEBUG_ACTIONS==='1')onRequest({debugAction:action});
      const item=outputItem(action),response={...base,status:'completed',completed_at:Math.floor(Date.now()/1000),output:[item]};
      cache.set(base.id,{owner,history:[...history,item],setup,sessionId,revision});while(cache.size>100)cache.delete(cache.keys().next().value);
      if(!b.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(response));return;}
      const initial={...item,status:'in_progress'};
      if(item.type==='message')initial.content=[];else if(item.type==='function_call')initial.arguments='';else initial.input='';
      event('response.output_item.added',{output_index:0,item:initial});
      const common={item_id:item.id,output_index:0};
      if(item.type==='message'){
        event('response.content_part.added',{...common,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
        event('response.output_text.delta',{...common,content_index:0,delta:action.text});
        event('response.output_text.done',{...common,content_index:0,text:action.text});
        event('response.content_part.done',{...common,content_index:0,part:item.content[0]});
      }else if(item.type==='function_call'){
        event('response.function_call_arguments.delta',{...common,delta:item.arguments});
        event('response.function_call_arguments.done',{...common,name:item.name,arguments:item.arguments});
      }else{
        event('response.custom_tool_call_input.delta',{...common,delta:item.input});
        event('response.custom_tool_call_input.done',{...common,input:item.input});
      }
      event('response.output_item.done',{output_index:0,item});event('response.completed',{response});res.end();
    }catch(e){onRequest({requestFailed:true,status:e.status||(controller.signal.aborted?504:502),reason:controller.signal.aborted?'timeout_or_disconnect':e.message});error(e.status||(controller.signal.aborted?504:502),controller.signal.aborted?'Quick request timed out or client disconnected':e.message);}
    finally{clearTimeout(timer);clearInterval(heartbeat);res.off('close',abort);active--;}
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const file=process.env.QUICK_CLIENT_FILE;
  if(!file)throw new Error('Set QUICK_CLIENT_FILE to the existing client.local.json (do not paste the key into source).');
  const c=JSON.parse(fs.readFileSync(file,'utf8'));
  const envTools=process.env.QUICK_CODEX_TOOLS;
  const server=createBridge({key:c.apiKey,upstream:c.baseURL,tools:envTools==='all'?'all':envTools?envTools.split(',').map(s=>s.trim()).filter(Boolean):CORE_TOOLS,onRequest:r=>console.log(JSON.stringify({at:new Date().toISOString(),...r}))});
  server.listen(Number(process.env.QUICK_CODEX_PORT||8788),'127.0.0.1',()=>console.log('Quick Codex experimental bridge on http://127.0.0.1:'+(process.env.QUICK_CODEX_PORT||8788)+'/v1'));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close();server.closeAllConnections();});
}
