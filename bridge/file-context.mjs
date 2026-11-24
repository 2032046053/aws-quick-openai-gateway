import {createHash} from 'node:crypto';
const binary=/\.(?:pdf|ipynb|png|jpe?g|gif|webp|svg|bmp|ico|mp[34]|wav|ogg|zip|gz|tar|exe|dll)$/i;
// Apply only to the standard text Read schema. Arbitrary MCP tools and binary
// document readers keep their original arguments and validation behavior.
export function pageReadAction(action,tools,limit=120){
 if(!limit||action.type!=='tool_call'||action.name!=='Read')return action;
 const p=tools.find(t=>t.name==='Read')?.parameters?.properties,a=action.arguments;
 if(!p?.file_path||!p.offset||!p.limit||!['integer','number'].includes(p.offset.type)||!['integer','number'].includes(p.limit.type))return action;
 if(typeof a.file_path!=='string'||binary.test(a.file_path)||a.pages!==undefined)return action;
 if(a.limit!==undefined&&a.limit<=limit)return action;
 return {...action,arguments:{...a,offset:a.offset??1,limit}};
}
function excerpt(value,limit){
 if(Buffer.byteLength(value)<=limit)return value;
 const digest=createHash('sha256').update(value).digest('hex').slice(0,16);
 let head=Buffer.from(value).subarray(0,Math.max(0,limit-600)).toString('utf8').replace(/\uFFFD$/,'');
 const newline=head.lastIndexOf('\n');if(newline>head.length/2)head=head.slice(0,newline+1);
 const numbered=[...head.matchAll(/^\s*(\d+)(?:→|\t)/gm)];
 const next=numbered.length?Number(numbered.at(-1)[1])+1:null;
 return head+'\n[READ EXCERPT: '+(Buffer.byteLength(value)-Buffer.byteLength(head))+' UTF-8 bytes omitted; original result sha256='+digest+'. This is NOT the complete file. '+(next?'Continue with Read offset='+next+' and a smaller limit. ':'Use Grep to locate the relevant lines, then Read a smaller range. ')+'Re-read exact lines before editing; do not reconstruct omitted code.]';
}
export function boundReadResults(items,{maxBytes=12000}={}){
 const calls=new Map();let reduced=0,beforeBytes=0,afterBytes=0;
 const history=items.map(item=>{
  if(item?.type==='function_call'){
   let args;try{args=JSON.parse(item.arguments);}catch{}
   calls.set(item.call_id,{name:item.name,args});return item;
  }
  if(item?.type==='function_call_output'){
   const call=calls.get(item.call_id);
   if(call?.name==='Read'&&typeof item.output==='string'&&!item.output.startsWith('TOOL ERROR:')&&!binary.test(call.args?.file_path||'')){
    const output=excerpt(item.output,maxBytes);if(output!==item.output){reduced++;beforeBytes+=Buffer.byteLength(item.output);afterBytes+=Buffer.byteLength(output);return {...item,output};}
   }
  }
  return item;
 });
 return {history,reduced,beforeBytes,afterBytes};
}
