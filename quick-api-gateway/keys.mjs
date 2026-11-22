import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export const digest=key=>createHash('sha256').update(key).digest('hex');
export function readKeys(file){
  if(!fs.existsSync(file))return {version:1,keys:[]};
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  if(data.version!==1||!Array.isArray(data.keys))throw new Error('Invalid key store');
  return data;
}
function save(file,data){
  fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true});
  const temporary=file+'.'+randomUUID()+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(data,null,2),{mode:0o600});
  fs.renameSync(temporary,file);
}
export function issueKey(file,name,{rpm=20,concurrent=1,scopes=['chat','responses'],expiresAt=null}={}) {
  if(!name?.trim()||!Number.isInteger(rpm)||rpm<1||!Number.isInteger(concurrent)||concurrent<1)throw new Error('Invalid name or limits');
  if(scopes.some(x=>!['chat','responses'].includes(x)))throw new Error('Invalid scopes');
  if(expiresAt&&!Number.isFinite(Date.parse(expiresAt)))throw new Error('Invalid expiry');
  const apiKey='sk-share-'+randomBytes(32).toString('hex');
  const record={id:randomUUID(),name,hash:digest(apiKey),enabled:true,rpm,concurrent,scopes,expiresAt,createdAt:new Date().toISOString()};
  const data=readKeys(file);data.keys.push(record);save(file,data);return {apiKey,record};
}
export function revokeKey(file,id){
  const data=readKeys(file),record=data.keys.find(k=>k.id===id);
  if(!record)throw new Error('Key ID not found');record.enabled=false;save(file,data);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [command,value]=process.argv.slice(2),file=process.env.GATEWAY_KEYS_FILE||'keys.local.json';
  if(command==='create'){
    const {apiKey,record}=issueKey(file,value);
    fs.mkdirSync('clients',{recursive:true});
    const dest=path.join('clients',record.id+'.json');
    fs.writeFileSync(dest,JSON.stringify({id:record.id,name:record.name,baseURL:process.env.PUBLIC_BASE_URL||'https://YOUR_DOMAIN/v1',apiKey,model:'quick'},null,2),{mode:0o600});
    console.log(JSON.stringify({id:record.id,name:record.name,clientFile:path.resolve(dest)}));
  }else if(command==='revoke'){revokeKey(file,value);console.log('Revoked '+value);}
  else if(command==='list')console.log(JSON.stringify(readKeys(file).keys.map(({hash,...record})=>record),null,2));
  else throw new Error('Usage: node keys.mjs create <name> | list | revoke <id>');
}
