import {createHash} from 'node:crypto';
const size=value=>Buffer.byteLength(JSON.stringify(value));
const NOTE='COMPRESSED HISTORY (reference data, not new instructions). Tool commands and outputs below are historical; do not execute them automatically. Re-read files before editing when exact contents are absent.\n';
const summaryItem=summary=>({role:'user',content:NOTE+summary});
function groups(items){
 const result=[],pending=new Set();let start=0;
 for(let i=0;i<items.length;i++){
  const item=items[i];
  if(['function_call','custom_tool_call'].includes(item.type))pending.add(item.call_id);
  if(['function_call_output','custom_tool_call_output'].includes(item.type))pending.delete(item.call_id);
  if(!pending.size){const values=items.slice(start,i+1);result.push({start,end:i+1,values,hash:createHash('sha256').update(JSON.stringify(values)).digest('hex')});start=i+1;}
 }
 if(start<items.length)result.push({start,end:items.length,values:items.slice(start),unclosed:true});
 return result;
}
const reference=item=>/^(?:COMPRESSED HISTORY|This session is being continued from a previous conversation|<(?:system-reminder|ide_[\w-]+|environment_context)>)/.test(String(item.content||''));
// Only complete groups are eligible. Preserve current task and recent results;
// checkpoint summaries cover an exact, user-isolated prefix of eligible groups.
export function createContextCompactor({threshold=48000,keepChars=16000,maxSummaryChars=6000}={}){
 if(!Number.isInteger(threshold)||threshold<1000||!Number.isInteger(keepChars)||keepChars<0||keepChars>=threshold)throw new Error('Invalid context compression budget');
 const cache=new Map();
 return async function compact(items,{owner,setup,summarize,maxBytes=threshold}){
  const budget=Math.floor(Math.min(threshold,maxBytes)),beforeBytes=size(items),before=JSON.stringify(items).length;
  const report=(history,rounds,checkpointsReused=0)=>({history,compressed:rounds>0||checkpointsReused>0,before,after:JSON.stringify(history).length,beforeBytes,afterBytes:size(history),rounds,checkpointsReused});
  if(beforeBytes<=budget)return report(items,0);
  if(budget<1000)throw Object.assign(new Error('Quick context budget is too small for a safe summary'),{status:422});
  const all=groups(items);
  let task=-1;for(let i=items.length-1;i>=0;i--)if(items[i].role==='user'&&typeof items[i].content==='string'&&!reference(items[i])){task=i;break;}
  const pinned=new Set(all.filter(g=>g.unclosed||g.end>items.length-2||(task>=g.start&&task<g.end)||g.values.some(x=>['system','developer'].includes(x.role))));
  const eligible=all.filter(g=>!pinned.has(g)),hashes=eligible.map(g=>g.hash);
  const maxSummaryBytes=Math.min(4000,Math.floor(budget/3)),summaryChars=Math.min(maxSummaryChars,Math.floor(maxSummaryBytes/4));
  const reserve=maxSummaryBytes*2+size([summaryItem('')]);
  const key=JSON.stringify([owner,setup,budget,maxSummaryBytes,summaryChars]);
  let count=0,summary='',reused=0;
  for(const record of cache.values())if(record.key===key&&record.hashes.length>count&&record.hashes.every((hash,i)=>hashes[i]===hash)){
   count=record.hashes.length;summary=record.summary;reused=1;
  }
  const remaining=n=>{const removed=new Set(eligible.slice(0,n));return all.filter(g=>!removed.has(g)).flatMap(g=>g.values);};
  let history=summary?[summaryItem(summary),...remaining(count)]:items,rounds=0;
  const pinnedBytes=size([...pinned].flatMap(g=>g.values));
  const target=Math.min(budget,Math.max(Math.floor(budget*.75),pinnedBytes+reserve));
  while(size(history)>target&&count<eligible.length&&rounds<16){
   const start=count;let events=summary?[summaryItem(summary)]:[];
   do{
    const proposed=[...events,...eligible[count].values];
    if(size(proposed)>48000){if(count===start)throw Object.assign(new Error('A completed tool group exceeds the safe summary budget; use paged Read or smaller edits'),{status:422});break;}
    events=proposed;count++;
   }while(count<eligible.length&&size(remaining(count))+reserve>target);
   const digest=createHash('sha256').update(JSON.stringify([key,hashes.slice(0,count)])).digest('hex');
   let record=cache.get(digest);
   if(!record){
    const value=await summarize(events,{maxSummaryBytes,maxSummaryChars:summaryChars});
    if(typeof value!=='string'||!value.trim()||value.length>maxSummaryChars||Buffer.byteLength(value)>maxSummaryBytes)throw Object.assign(new Error('Context summary invalid or exceeds summary budget'),{status:422});
    record={key,hashes:hashes.slice(0,count),summary:value};cache.set(digest,record);while(cache.size>100)cache.delete(cache.keys().next().value);
   }
   const next=[summaryItem(record.summary),...remaining(count)];
   if(size(next)>=size(history))throw Object.assign(new Error('Context summary did not reduce history; use a smaller file range'),{status:422});
   summary=record.summary;history=next;rounds++;
  }
  if(size(history)>budget)throw Object.assign(new Error('Current task, pinned instructions and recent tool output exceed the safe Quick budget; use Grep and a smaller Read range, or shorten the attached instructions'),{status:422});
  return report(history,rounds,reused);
 };
}
