import fs from 'node:fs';
import {normalizeKeys} from './upstream-pool.mjs';
export function upstreamConfig(env,defaultKey,readFile=path=>fs.readFileSync(path,'utf8')){
 const file=env.GATEWAY_UPSTREAM_KEYS_FILE,raw=env.UPSTREAM_API_KEYS;
 if(file&&raw?.trim())throw new Error('Configure either GATEWAY_UPSTREAM_KEYS_FILE or UPSTREAM_API_KEYS, not both');
 let keys;
 if(file){
  let data;try{data=JSON.parse(readFile(file));}catch{throw new Error('Could not read upstream key pool JSON configuration');}
  keys=data?.apiKeys;
 }else keys=raw?.trim()?raw.split(',').map(k=>k.trim()).filter(Boolean):[defaultKey];
 const retryStatuses=env.RETRY_STATUS_CODES===undefined?[401,403,429]:env.RETRY_STATUS_CODES.split(',').filter(x=>x.trim()).map(Number);
 if(retryStatuses.some(s=>![401,403,429].includes(s)))throw new Error('RETRY_STATUS_CODES may only include 401,403,429');
 const maxAttempts=Number(env.UPSTREAM_MAX_ATTEMPTS||4);
 if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>32)throw new Error('UPSTREAM_MAX_ATTEMPTS must be 1-32');
 const keyHeader=(env.UPSTREAM_KEY_HEADER||'authorization').toLowerCase();
 if(!['authorization','x-api-key'].includes(keyHeader))throw new Error('UPSTREAM_KEY_HEADER must be authorization or x-api-key');
 const timeoutMs=Number(env.REQUEST_TIMEOUT_MS||150000);
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw new Error('REQUEST_TIMEOUT_MS must be 1-600000');
 return {upstreamKeys:normalizeKeys(keys),upstreamKeyHeader:keyHeader,upstreamMaxAttempts:maxAttempts,upstreamRetryStatuses:retryStatuses,timeoutMs};
}
