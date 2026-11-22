import http from 'node:http';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {digest,readKeys} from './keys.mjs';

export function createGateway({keysFile,chatURL,responsesURL,upstreamKey,maxConcurrent=2,timeoutMs=150000,publicPrefix='',log=()=>{}}){
  for(const address of [chatURL,responsesURL]){
    const url=new URL(address);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error('Upstream must be an explicit loopback HTTP URL');
  }
  if(!upstreamKey)throw new Error('Missing internal upstream key');
  const owners=new Map(),limits=new Map();let totalActive=0;
  return http.createServer(async(req,res)=>{
    const started=Date.now();let principal,state,occupied=false,controller,timer,received=0;
    const sendError=(status,message)=>{
      if(res.headersSent){res.destroy();return;}
      res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      res.end(JSON.stringify({error:{type:'gateway_error',message}}));
    };
    const disconnected=()=>controller?.abort();
    try{
      const route=publicPrefix&&req.url?.startsWith(publicPrefix+'/')?req.url.slice(publicPrefix.length):req.url;
      const routes={'/v1/models':['GET','models'],'/v1/chat/completions':['POST','chat'],'/v1/responses':['POST','responses']};
      const entry=routes[route];
      if(!entry){sendError(404,'Unknown API endpoint');return;}
      const token=/^Bearer (\S+)$/.exec(req.headers.authorization||'')?.[1];
      if(!token){sendError(401,'Invalid API key');return;}
      const hash=digest(token);
      principal=readKeys(keysFile).keys.find(k=>k.enabled&&k.hash===hash&&(!k.expiresAt||Date.parse(k.expiresAt)>Date.now()));
      if(!principal){sendError(401,'Invalid API key');return;}
      if(req.method!==entry[0]){sendError(405,'Method not allowed');return;}
      if(entry[1]!=='models'&&!principal.scopes.includes(entry[1])){sendError(403,'API key is not permitted to use this endpoint');return;}
      const minute=Math.floor(Date.now()/60000);
      state=limits.get(principal.id)||{minute,count:0,active:0};limits.set(principal.id,state);
      if(state.minute!==minute){state.minute=minute;state.count=0;}
      if(state.count>=principal.rpm||state.active>=principal.concurrent||totalActive>=maxConcurrent){res.setHeader('retry-after','10');sendError(429,'Request or concurrency limit exceeded');return;}
      state.count++;state.active++;totalActive++;occupied=true;
      controller=new AbortController();timer=setTimeout(()=>controller.abort(),timeoutMs);
      res.once('close',disconnected);req.once('aborted',disconnected);
      let payload;
      if(req.method==='POST'){
        const chunks=[];
        for await(const chunk of req){received+=chunk.length;if(received>4*1024*1024){sendError(413,'Request exceeds 4 MiB');return;}chunks.push(chunk);}
        try{payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{sendError(400,'Invalid JSON');return;}
        if(!payload||typeof payload!=='object'||Array.isArray(payload)){sendError(400,'Expected a JSON object');return;}
        if(entry[1]==='responses'&&payload.previous_response_id){
          if(owners.get(payload.previous_response_id)!==principal.id){sendError(400,'Previous response unavailable for this API key; resend your full history');return;}
        }
      }
      const base=entry[1]==='responses'?responsesURL:chatURL;
      const suffix=entry[1]==='chat'?'/chat/completions':entry[1]==='responses'?'/responses':'/models';
      const upstream=await fetch(base.replace(/\/$/,'')+suffix,{
        method:req.method,headers:{authorization:'Bearer '+upstreamKey,'x-quick-principal':principal.id,...(payload?{'content-type':'application/json'}:{})},
        body:payload?JSON.stringify(payload):undefined,signal:controller.signal,redirect:'error',
      });
      // Never forward callers' keys, cookies, arbitrary upstream URLs or response cookies.
      const headers={'content-type':upstream.headers.get('content-type')||'application/json','cache-control':'no-store','x-accel-buffering':'no'};
      if(upstream.headers.has('retry-after'))headers['retry-after']=upstream.headers.get('retry-after');
      for(const name of ['x-quick-conversation-id','x-quick-reused','x-quick-sent-chars'])if(upstream.headers.has(name))headers[name]=upstream.headers.get(name);
      res.writeHead(upstream.status,headers);
      const remember=data=>{
        if(entry[1]!=='responses'||!upstream.ok)return;
        const id=data?.response?.id||(data?.object==='response'?data.id:null);
        if(typeof id==='string'&&/^resp_[a-zA-Z0-9_-]{1,160}$/.test(id)){
          const old=owners.get(id);if(old&&old!==principal.id)throw new Error('Response ownership conflict');
          owners.set(id,principal.id);while(owners.size>1000)owners.delete(owners.keys().next().value);
        }
      };
      const isSSE=headers['content-type'].includes('text/event-stream');
      const decoder=new TextDecoder();let buffer='',responseBytes=0;
      const parseSSE=()=>{
        let index;
        while((index=buffer.indexOf('\n\n'))>=0){
          const event=buffer.slice(0,index);buffer=buffer.slice(index+2);
          const data=event.split('\n').filter(s=>s.startsWith('data:')).map(s=>s.slice(5).trimStart()).join('\n');
          if(data&&data!=='[DONE]'){let parsed;try{parsed=JSON.parse(data);}catch{continue;}remember(parsed);}
        }
      };
      if(upstream.body)for await(const chunk of upstream.body){
        responseBytes+=chunk.length;if(responseBytes>32*1024*1024)throw new Error('Response limit exceeded');
        if(entry[1]==='responses'){
          buffer+=decoder.decode(chunk,{stream:true});
          if(isSSE){buffer=buffer.replace(/\r\n/g,'\n');parseSSE();}
          if(buffer.length>8*1024*1024)throw new Error('Response tracking limit exceeded');
        }
        if(!res.write(chunk))await new Promise((resolve,reject)=>{
          const clear=()=>{res.off('drain',done);res.off('close',closed);};
          const done=()=>{clear();resolve();};const closed=()=>{clear();reject(new Error('Disconnected'));};
          res.once('drain',done);res.once('close',closed);
        });
      }
      if(entry[1]==='responses'&&!isSSE){let parsed;try{parsed=JSON.parse(buffer);}catch{}remember(parsed);}
      res.end();
    }catch(e){
      if(!res.destroyed)sendError(controller?.signal.aborted?504:502,'Gateway could not complete the upstream request');
    }finally{
      clearTimeout(timer);res.off('close',disconnected);req.off('aborted',disconnected);
      // Also cancel upstream reads when the downstream body was rejected or disconnected.
      controller?.abort();
      if(occupied){state.active--;totalActive--;}
      log({at:new Date().toISOString(),keyId:principal?.id||null,path:['/v1/models','/v1/chat/completions','/v1/responses'].includes(req.url)?req.url:'unknown',status:res.statusCode,requestBytes:received,durationMs:Date.now()-started});
      // Expired rate-window entries without active requests are disposable.
      if(limits.size>1000)for(const[id,item]of limits)if(!item.active&&item.minute<Math.floor(Date.now()/60000)-1)limits.delete(id);
    }
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const clientFile=process.env.QUICK_CLIENT_FILE;
  if(!clientFile)throw new Error('Set QUICK_CLIENT_FILE to the existing internal client.local.json');
  const client=JSON.parse(fs.readFileSync(clientFile,'utf8'));
  const server=createGateway({keysFile:process.env.GATEWAY_KEYS_FILE||'keys.local.json',chatURL:'http://127.0.0.1:8787/v1',responsesURL:'http://127.0.0.1:8788/v1',upstreamKey:client.apiKey,publicPrefix:'/quick',log:entry=>console.log(JSON.stringify(entry))});
  server.listen(Number(process.env.GATEWAY_PORT||8789),'127.0.0.1',()=>console.log('Gateway ready at http://127.0.0.1:'+(process.env.GATEWAY_PORT||8789)+'/v1'));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close();server.closeAllConnections();});
}
