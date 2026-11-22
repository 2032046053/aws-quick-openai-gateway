import http from 'node:http';
import fs from 'node:fs';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createQuickClient,buildRequest} from './quick-client.mjs';

function authorized(header,key) {
  const a=Buffer.from(header||''),b=Buffer.from('Bearer '+key);
  return a.length===b.length&&timingSafeEqual(a,b);
}
function error(res,status,message,type='invalid_request_error') {
  if(res.destroyed)return;
  const body={error:{message,type,param:null,code:null}};
  if(res.headersSent) {res.end(`data: ${JSON.stringify(body)}\n\n`);return;}
  res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));
}
async function body(req) {
  const chunks=[];let size=0;
  for await(const chunk of req) {
    size+=chunk.length;if(size>1024*1024)throw Object.assign(new Error('Request body exceeds 1 MiB'),{status:413});
    chunks.push(chunk);
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw Object.assign(new Error('Invalid JSON request body'),{status:400});}
}
async function write(res,value) {
  if(res.destroyed)throw Object.assign(new Error('Client disconnected'),{status:499});
  if(res.write(value))return;
  await new Promise((resolve,reject)=>{
    const cleanup=()=>{res.off('drain',done);res.off('close',closed);res.off('error',closed);};
    const done=()=>{cleanup();resolve();};
    const closed=()=>{cleanup();reject(Object.assign(new Error('Client disconnected'),{status:499}));};
    res.once('drain',done);res.once('close',closed);res.once('error',closed);
  });
}
export function createApiServer({key,complete,maxConcurrent=2}) {
  if(typeof key!=='string'||key.length<24)throw new Error('PROXY_KEY must have at least 24 characters');
  let active=0;
  return http.createServer(async(req,res)=>{
    const path=req.url?.split('?')[0];
    if(path==='/health'&&req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});res.end('{"status":"ok"}');return;}
    if(!authorized(req.headers.authorization,key)){error(res,401,'Invalid API key','authentication_error');return;}
    if(path==='/v1/models'&&req.method==='GET') {
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({object:'list',data:[{id:'quick',object:'model',created:0,owned_by:'local-quick-adapter'}]}));return;
    }
    if(path!=='/v1/chat/completions'){error(res,404,'Unknown endpoint');return;}
    if(req.method!=='POST'){error(res,405,'Use POST');return;}
    if(active>=maxConcurrent){error(res,429,'Too many concurrent Quick requests','rate_limit_error');return;}
    active++;
    const controller=new AbortController();
    const abort=()=>controller.abort();req.once('aborted',abort);res.once('close',abort);
    try {
      const input=await body(req);
      if(!input||typeof input!=='object'||Array.isArray(input))throw Object.assign(new Error('Expected a JSON object'),{status:400});
      if(input.model!==undefined && input.model!=='quick')throw Object.assign(new Error('Unknown model; use quick'),{status:404});
      if(input.stream!==undefined && typeof input.stream!=='boolean')throw Object.assign(new Error('stream must be a boolean'),{status:400});
      if(input.n!==undefined&&input.n!==1)throw Object.assign(new Error('Only n=1 is supported'),{status:400});
      for(const field of ['tools','tool_choice','functions','function_call','stop','logprobs','top_logprobs','seed','temperature','top_p','max_tokens','max_completion_tokens','presence_penalty','frequency_penalty','modalities','audio','prediction']) {
        if(input[field]!==undefined && input[field]!==null)throw Object.assign(new Error(`${field} is not supported by this Quick adapter`),{status:400});
      }
      if(input.response_format && input.response_format.type!=='text')throw Object.assign(new Error('Only text response_format is supported'),{status:400});
      try{buildRequest(input.messages);}catch(e){e.status=400;throw e;}
      const model='quick',id='chatcmpl-'+randomUUID().replaceAll('-',''),created=Math.floor(Date.now()/1000);
      let text='',done=false,sse=false;
      const chunk=(delta,finish_reason=null)=>({id,object:'chat.completion.chunk',created,model,choices:[{index:0,delta,finish_reason}]});
      const start=async()=>{
        if(sse)return;sse=true;
        res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache','x-accel-buffering':'no'});res.flushHeaders();
        await write(res,`data: ${JSON.stringify(chunk({role:'assistant',content:''}))}\n\n`);
      };
      for await(const event of complete({messages:input.messages,signal:controller.signal})) {
        if(event.type==='delta') {
          text+=event.text;
          if(input.stream){await start();await write(res,`data: ${JSON.stringify(chunk({content:event.text}))}\n\n`);}
        }
        if(event.type==='done'){text=event.text;done=true;}
      }
      if(!done)throw new Error('Upstream ended before completion');
      if(input.stream) {
        await start();await write(res,`data: ${JSON.stringify(chunk({},'stop'))}\n\ndata: [DONE]\n\n`);res.end();
      }else{
        res.writeHead(200,{'content-type':'application/json; charset=utf-8'});
        res.end(JSON.stringify({id,object:'chat.completion',created,model,choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}]}));
      }
    }catch(e){
      if(!controller.signal.aborted)error(res,e.status||502,e.message,e.status===400?'invalid_request_error':'upstream_error');
    }finally{active--;req.off('aborted',abort);res.off('close',abort);}
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const session=process.env.QUICK_SESSION_FILE?JSON.parse(fs.readFileSync(process.env.QUICK_SESSION_FILE,'utf8')):{};
  const complete=createQuickClient({...session,
    accountId:process.env.QUICK_ACCOUNT_ID||session.accountId,
    cookie:process.env.QUICK_COOKIE||session.cookie,
    csrf:process.env.QUICK_CSRF||session.csrf,
    outboundProxy:process.env.QUICK_OUTBOUND_PROXY||session.outboundProxy,
    timeoutMs:Number(process.env.QUICK_TIMEOUT_MS||120000),
  });
  const server=createApiServer({key:process.env.PROXY_KEY,complete});
  server.listen(Number(process.env.PORT||8787),'127.0.0.1',()=>console.log(`OpenAI compatible API: http://127.0.0.1:${server.address().port}/v1`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close();server.closeAllConnections();});
}
