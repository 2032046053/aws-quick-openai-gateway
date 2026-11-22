import WebSocket from 'ws';
import {HttpsProxyAgent} from 'https-proxy-agent';
import {randomUUID} from 'node:crypto';
import {encodeEvent,EventDecoder} from './quick-protocol.mjs';
import {Conversations} from './conversations.mjs';

export function buildRequest(messages) {
  if(!Array.isArray(messages)||!messages.length) throw new Error('messages must be a nonempty array');
  const instructions=[], dialog=[];
  for(const m of messages) {
    if(!m || !['system','developer','user','assistant'].includes(m.role)) throw new Error('Only system/developer/user/assistant text messages are supported');
    let text=m.content;
    if(Array.isArray(text)) {
      if(text.some(p=>p.type!=='text'||typeof p.text!=='string')) throw new Error('Only text content parts are supported');
      text=text.map(p=>p.text).join('\n');
    }
    if(typeof text!=='string' || m.tool_calls || m.function_call) throw new Error('Only plain text messages are supported');
    if(m.role==='system'||m.role==='developer') instructions.push(text);
    else dialog.push({role:m.role,text});
  }
  if(!dialog.length || dialog.at(-1).role!=='user') throw new Error('The final dialog message must have role user');
  return {
    text:dialog.length===1?dialog[0].text:JSON.stringify({conversation_history:dialog.slice(0,-1),current_user_message:dialog.at(-1).text}),
    customPrompt:instructions.join('\n\n')||null,
  };
}

export function createQuickClient(config) {
  const conversations=new Conversations(config.conversations);
  return async function* complete({messages,signal,principal='local',sessionId,revision,incremental=false}) {
    if(!config.cookie || !config.csrf) throw Object.assign(new Error('Quick login session is not configured'),{status:503});
    buildRequest(messages);
    const lease=conversations.acquire({messages,principal,sessionId,revision,incremental});
    try {
    const {text,customPrompt}=buildRequest(lease.delta);
    const threadId=lease.threadId, workingId=lease.workingId;
    yield {type:'session',id:lease.id,conversationId:threadId,revision:lease.revision,reused:lease.reused,sentChars:text.length};
    const url=new URL(config.wsUrl || `wss://quick.aws.com/sn/account/${config.accountId}/wsproxy/service/SpaceNeedleConversationService/operation/ChatBidirectionalStream`);
    for(const [k,v] of Object.entries({'wsproxy-protocol':'rpc-v2-cbor',awsAccountId:config.accountId,surfaceType:'WEB_EXPERIENCE',agentServiceType:'UNIFIED_QUICK',outpostId:'web0',workingSessionId:workingId,mbtc:decodeURIComponent(config.csrf)})) url.searchParams.set(k,v);
    const protocols=['subprotocol-json',encodeURIComponent(JSON.stringify({csrfToken:config.csrf}))];
    // Exported handshake protocols may be supplied explicitly when the upstream changes.
    const ws=new WebSocket(url, config.protocols || protocols, {
      agent:config.outboundProxy?new HttpsProxyAgent(config.outboundProxy):undefined,
      headers:{Origin:'https://quick.aws.com',Cookie:config.cookie,'User-Agent':'Mozilla/5.0'},
      handshakeTimeout:15000,maxPayload:16*1024*1024,perMessageDeflate:false,
    });
    const decoder=new EventDecoder();
    let queue=[],wake,failed,closed=false,closeInfo='',started=false,assistantId,output='';
    const notify=()=>{wake?.();wake=undefined;};
    const fail=e=>{failed=e;notify();};
    const timeout=setTimeout(()=>fail(Object.assign(new Error('Quick response timed out'),{status:504})),config.timeoutMs || 120000);
    const abort=()=>fail(Object.assign(new Error('Client disconnected'),{status:499}));
    signal?.addEventListener('abort',abort,{once:true});
    const features={appVersion:'qbiz-web-bridge',acp_first_text:1,user_notification:1,subtask_progress:1,external_agent_sign_in:1,recents_promotion:1,self_registering_connectors:1};
    const send=event=>ws.send(encodeEvent(event));
    ws.on('open',()=>send({type:'session_connect',payload:{session_id:threadId,focus_only:true,...features}}));
    ws.on('message',(data,binary)=>{
      if(!binary) {fail(new Error('Unexpected non-binary upstream message'));return;}
      try {queue.push(...decoder.push(data));if(queue.length>2048)throw new Error('Quick event queue overflow');notify();} catch(e) {fail(e);}
    });
    ws.on('error',()=>fail(new Error('Quick WebSocket connection failed')));
    ws.on('unexpected-response',(req,res)=>{res.resume();fail(Object.assign(new Error(`Quick authentication/handshake failed (HTTP ${res.statusCode})`),{status:res.statusCode===401||res.statusCode===302||res.statusCode===403?502:503}));ws.terminate();});
    ws.on('close',(code,reason)=>{closed=true;closeInfo=` (${code}${reason.length?': '+reason.toString().slice(0,160):''})`;notify();});
    try {
      if(signal?.aborted) abort();
      while(true) {
        if(failed) throw failed;
        if(!queue.length) {
          if(closed) throw new Error('Quick connection closed before completion'+closeInfo);
          await new Promise(r=>{wake=r;});continue;
        }
        const e=queue.shift();
        if(e.type==='connected'&&!started) {
          started=true;
          send({type:'user_message',payload:{
            traceId:randomUUID(),text,send_origin:'composer',had_physical_input:false,...features,
            message_id:'msg-'+randomUUID().slice(0,8),thread_id:threadId,agent_mode:'smart',thinking_effort:'off',
            user_timezone:config.timezone || 'Asia/Shanghai',user_locale:'zh-CN',custom_prompt:customPrompt,
            chat_agent_id:config.agentArn || `arn:aws:quicksight:${config.region || 'us-east-1'}:${config.accountId}:agent/SYSTEM`,
            auto_routing:false,web_search_enabled:false,direct_chat:false,voice_mode:false,voice_id:'matthew',tts_speed:1.1,
          }});
          continue;
        }
        // Ignore keepalives, other threads, tool activity, and unrelated messages.
        if(e.thread_id && e.thread_id!==threadId) continue;
        if(e.scope && e.scope!=='chat') continue;
        if(['error','message_error','turn_error'].includes(e.type)) {
          const detail=e.payload?.message||e.payload?.error?.message||e.payload?.error||e.message||e.error?.message||e.error||e.payload?.reason;
          const suffix=typeof detail==='string'?': '+detail.slice(0,240):'';
          throw new Error('Quick reported a conversation error'+suffix);
        }
        if(e.type==='message_start' && e.payload?.role==='assistant') assistantId=e.message_id;
        if(assistantId && e.message_id && e.message_id!==assistantId) continue;
        if(e.type==='text_delta' && typeof e.payload?.delta==='string') {
          output+=e.payload.delta;yield {type:'delta',text:e.payload.delta};
        }
        if(e.type==='message_complete') {
          if(e.payload?.tool_calls?.length) throw new Error('Quick requested a tool call; tool adaptation is not supported');
          const final=e.payload?.text;
          if(typeof final!=='string') throw new Error('Quick completed without a text response');
          if(final.startsWith(output)) {
            const remainder=final.slice(output.length);if(remainder) yield {type:'delta',text:remainder};
          } else throw new Error('Quick final text differs from streamed text');
          lease.commit(final);yield {type:'done',text:final};return;
        }
      }
    } finally {
      clearTimeout(timeout);signal?.removeEventListener('abort',abort);
      if(ws.readyState===WebSocket.OPEN) ws.close(1000);
      else if(ws.readyState!==WebSocket.CLOSED) ws.terminate();
      const force=setTimeout(()=>ws.terminate(),1500);force.unref();
    }
    } finally {lease.release();}
  };
}
