import {randomUUID} from 'node:crypto';

const fault=(message,code)=>Object.assign(new Error(message),{status:409,code});
export function stable(value){
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,stable(value[k])]));
  return value;
}
export const canonical=value=>JSON.stringify(stable(value));
const normalize=messages=>messages.map(m=>({role:m.role,content:Array.isArray(m.content)?m.content.map(p=>p.text).join('\n'):m.content}));
export function isPrefix(prefix,items){return prefix.length<items.length&&prefix.every((p,i)=>canonical(p)===canonical(items[i]));}

// A lease serializes one native conversation. Failed/cancelled turns invalidate it.
export class Conversations {
  constructor({max=100,ttlMs=30*60*1000,now=Date.now}={}){this.entries=new Map();this.max=max;this.ttlMs=ttlMs;this.now=now;}
  acquire({principal='local',sessionId,revision,incremental=false,messages}){
    for(const [key,e] of this.entries)if(!e.busy&&this.now()-e.touched>this.ttlMs)this.entries.delete(key);
    const normalized=normalize(messages);let e;
    if(incremental){
      if(!sessionId||!Number.isInteger(revision)||revision<0)throw fault('Incremental requests require a session and revision','quick_session_invalid');
      e=this.entries.get(principal+':'+sessionId);
      if(!e&&revision!==0)throw fault('Quick session expired; bootstrap full history','quick_session_missing');
      if(e&&e.revision!==revision)throw fault('Quick session revision changed; fork this history','quick_session_conflict');
    }else{
      const matches=[...this.entries.values()].filter(x=>x.principal===principal&&!x.explicit&&isPrefix(x.history,normalized));
      const longest=Math.max(-1,...matches.map(x=>x.history.length));
      const best=matches.filter(x=>x.history.length===longest);
      if(best.length===1)e=best[0]; // ambiguous identical histories never share a thread
    }
    if(e?.busy)throw fault('Quick conversation already has an active turn','quick_session_busy');
    const reused=!!e;
    if(!e){
      while(this.entries.size>=this.max){const idle=[...this.entries].find(([,x])=>!x.busy);if(!idle)throw Object.assign(new Error('Quick conversation store is busy'),{status:429});this.entries.delete(idle[0]);}
      e={principal,id:sessionId||randomUUID(),threadId:randomUUID(),workingId:randomUUID(),revision:0,explicit:incremental,history:[],touched:this.now()};
      this.entries.set(principal+':'+e.id,e);
    }
    e.busy=true;e.touched=this.now();
    const delta=incremental?messages:messages.slice(reused?e.history.length:0);
    let committed=false;
    return {
      id:e.id,threadId:e.threadId,workingId:e.workingId,revision:e.revision+1,reused,delta,
      commit:answer=>{e.revision++;e.history=incremental?[]:[...normalized,{role:'assistant',content:answer}];e.touched=this.now();committed=true;},
      release:()=>{e.busy=false;if(!committed)this.entries.delete(principal+':'+e.id);},
    };
  }
}
