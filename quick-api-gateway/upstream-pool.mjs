const RETRYABLE=new Set([401,403,429]);
export function normalizeKeys(keys){
 if(!Array.isArray(keys)||!keys.length||keys.length>32)throw new Error('Configure 1-32 internal upstream API keys');
 if(keys.some(k=>typeof k!=='string'||!k.trim()||/\s/.test(k.trim())||k.length>4096))throw new Error('Invalid internal upstream API key configuration');
 return [...new Set(keys.map(k=>k.trim()))];
}
export function createUpstreamPool({keys,keyHeader='authorization',maxAttempts=4,retryStatuses=[401,403,429],fetchImpl=fetch,now=Date.now,authCooldownMs=60000,rateCooldownMs=10000,maxCooldownMs=300000}){
 const entries=normalizeKeys(keys).map((key,i)=>({key,slot:'upstream-'+(i+1),until:0}));
 if(!['authorization','x-api-key'].includes(keyHeader))throw new Error('Invalid upstream key header');
 if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>32)throw new Error('Upstream max attempts must be 1-32');
 if(!Array.isArray(retryStatuses)||retryStatuses.some(s=>!RETRYABLE.has(s)))throw new Error('Upstream retry statuses may only include 401,403,429');
 if([authCooldownMs,rateCooldownMs,maxCooldownMs].some(ms=>!Number.isFinite(ms)||ms<1))throw new Error('Invalid upstream cooldown');
 const retryable=new Set(retryStatuses);let cursor=0;
 const cooldown=(entry,response)=>{
  const raw=response.headers.get('retry-after');let requested=0;
  if(raw!==null){const numeric=Number(raw);requested=Number.isFinite(numeric)&&numeric>=0?numeric*1000:Math.max(0,Date.parse(raw)-now())||0;}
  const delay=Math.min(maxCooldownMs,Math.max(response.status===429?rateCooldownMs:authCooldownMs,requested));
  entry.until=Math.max(entry.until,now()+delay);
 };
 return {
  get size(){return entries.length;},
  get available(){return entries.filter(e=>e.until<=now()).length;},
  async fetch(url,init={},onAttempt=()=>{}){
   // Reserve an ordered list once per request. Concurrent requests cannot make
   // a retry select the same key twice by advancing a shared cursor.
   const order=entries.map((_,i)=>entries[(cursor+i)%entries.length]);cursor=(cursor+1)%entries.length;
   let attempts=0;
   for(let i=0;i<order.length&&attempts<maxAttempts;i++){
    init.signal?.throwIfAborted();
    const entry=order[i];if(entry.until>now())continue;
    const headers=new Headers(init.headers);headers.delete('authorization');headers.delete('x-api-key');
    headers.set(keyHeader,keyHeader==='authorization'?'Bearer '+entry.key:entry.key);
    // The caller's AbortSignal covers selection, every attempt AND body reading.
    // Transport errors are ambiguous for POST and are deliberately not replayed.
    const response=await fetchImpl(url,{...init,headers,redirect:'error'});attempts++;
    onAttempt({keySlot:entry.slot,attempt:attempts,status:response.status,poolSize:entries.length});
    if(retryable.has(response.status)){
     cooldown(entry,response);
     if(attempts<maxAttempts&&order.slice(i+1).some(e=>e.until<=now())){
      // Release the rejected response before opening the next connection.
      try{await response.body?.cancel();}catch{}
      continue;
     }
    }
    return {response,attempts,keySlot:entry.slot};
   }
   const retryAfter=Math.max(1,Math.ceil((Math.min(...entries.map(e=>e.until))-now())/1000));
   throw Object.assign(new Error('All configured upstream keys are temporarily unavailable'),{status:503,retryAfter});
  },
 };
}
