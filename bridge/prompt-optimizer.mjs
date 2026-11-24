// Only recognizable client metadata is reduced. User prose, code, tool arguments,
// tool results and unknown formats are never passed through section filtering.
export const CODING_TOOLS=['Read','Write','Edit','Bash','Glob','Grep','NotebookEdit','Agent','Skill','WebSearch','WebFetch','AskUserQuestion','mcp__claude-vscode__getDiagnostics'];
const protectedText=/\b(?:approval|permission|confirm(?:ation)?|consent|security|safety|must|never|only|avoid|credentials?|confidential|prohibit(?:ed)?|do\s+not|don't|cannot|may\s+not|ask\s+before)\b|审批|权限|确认|安全|禁止|不得|必须|密钥/iu;
const uiTool=/^mcp__(?:ccd_|Claude_Browser__|scheduled-tasks__)/;
const uiTitles=new Set(['starting other sessions','task list and wrap-up','task list and wrap-up (this app)']);
const bytes=x=>Buffer.byteLength(JSON.stringify(x));
const plain=x=>x.replace(/\s+/g,' ').trim();
const sentence=x=>plain(x).match(/^.*?[.!?。！？](?:\s|$)/u)?.[0]?.trim()||plain(x).split(/\b(?:Triggers?|Use when|When to use)\s*:/i)[0].trim();
function shortenDescription(value){
 const lines=value.split('\n'),first=sentence(lines.find(x=>x.trim())||'');
 const constraints=lines.filter(x=>protectedText.test(x)&&!first.includes(x.trim()));
 return [first,...constraints].filter(Boolean).join('\n');
}
function compactSkills(body){
 if(/^\s*(?:`{3,}|~{3,})/m.test(body))return body;
 // XML catalog entries: retain every name and all non-description metadata.
 if(body.includes('<skill>')){
  const entries=[...body.matchAll(/<skill>[\s\S]*?<\/skill>/g)];
  if(!entries.length||entries.some(([x])=>!/<name>[^<>]+<\/name>/.test(x)))return body;
  return body.replace(/<skill>[\s\S]*?<\/skill>/g,entry=>entry.replace(/<description>([\s\S]*?)<\/description>/g,(_,description)=>'<description>'+shortenDescription(description)+'</description>'));
 }
 // Bullet catalogs only: do not reinterpret arbitrary prose as skill entries.
 const lines=body.split('\n'),entry=/^[-*] (?:\*\*|`)?([\w:.-]+)(?:\*\*|`)?:\s+/;
 const starts=lines.map((x,i)=>entry.test(x)?i:-1).filter(i=>i>=0);
 if(!starts.length||lines.slice(0,starts[0]).some(x=>x.trim()))return body;
 const out=[];
 for(let j=0;j<starts.length;j++){
  const block=lines.slice(starts[j],starts[j+1]??lines.length),match=block[0].match(/^([-*] (?:\*\*|`)?[\w:.-]+(?:\*\*|`)?:\s+)(.*)$/);
  if(block.slice(1).some(x=>x.trim()&&!/^\s+/.test(x)))return body;
  out.push(match[1]+shortenDescription([match[2],...block.slice(1)].join('\n')));
 }
 return out.join('\n')+'\n';
}
function outsideCode(text,transform){
 let result='',plainText='',fence=null;
 const flush=()=>{result+=transform(plainText);plainText='';};
 for(const line of text.split(/(?<=\n)/)){
  const mark=line.match(/^\s*(`{3,}|~{3,})/);
  if(!fence&&mark){flush();fence=mark[1];result+=line;}
  else if(fence){result+=line;if(mark&&mark[1][0]===fence[0]&&mark[1].length>=fence.length)fence=null;}
  else plainText+=line;
 }
 flush();return result;
}
function sections(text){
 const lines=text.split(/(?<=\n)/),out=[];let fence=null;
 for(const line of lines){
  const mark=line.match(/^\s*(`{3,}|~{3,})/);
  if(mark){if(!fence)fence=mark[1][0];else if(fence===mark[1][0])fence=null;}
  const heading=!fence&&line.match(/^(#{1,6}) ([^\n]+)\s*\n?$/);
  const catalog=!fence&&line.match(/^(TOOLS:|Deferred tools:|Starting other sessions:?|Task list and wrap-up(?: \(this app\))?:?|The following deferred tools are now available[^\n]*|Available agent types:?|While auto mode[^\n]*|Today's date[^\n]*|The following skills are available[^\n]*:?)\s*\n$/i);
  if(heading||catalog)out.push({header:line,title:(heading?.[2]||catalog?.[1]).replace(/:$/,'').trim().toLowerCase(),body:''});
  else if(out.length)out.at(-1).body+=line;else out.push({header:'',title:'',body:line});
 }
 return out;
}
function redundantCatalog(body,definitions){
 const s=body.trim();
 try{
  const parsed=JSON.parse(s);
  if(Array.isArray(parsed)&&parsed.length&&parsed.every(t=>definitions.some(d=>JSON.stringify(d)===JSON.stringify(t))))return true;
 }catch{}
 const names=new Set(definitions.map(t=>t.name));
 const rows=s.split('\n').filter(x=>x.trim());
 return rows.length>0&&rows.every(row=>{
  const name=row.trim().replace(/^[-*] /,'').replace(/^`([^`]+)`$/,'$1');
  return names.has(name);
 });
}
function optimizeSystem(text,definitions,active,stats){
 const hasSkill=active.some(t=>t.name==='Skill');
 text=outsideCode(text,part=>{
  if(hasSkill)part=part.replace(/<skills>([\s\S]*?)<\/skills>/g,(all,body)=>{const reduced=compactSkills(body);if(reduced!==body)stats.skillSections++;return '<skills>'+reduced+'</skills>';});
  return part.replace(/<available-deferred-tools>([\s\S]*?)<\/available-deferred-tools>/g,(all,body)=>{if(redundantCatalog(body,definitions)){stats.catalogSections++;return '';}return all;});
 });
 return sections(text).map(section=>{
  const {title,body,header}=section;
  if((['tools','deferred tools','available deferred tools'].includes(title)||title.startsWith('the following deferred tools are now available'))&&redundantCatalog(body,definitions)){
   stats.catalogSections++;return '';
  }
  // Require a known, removed UI tool reference, not just a familiar heading.
  const references=[...body.matchAll(/\bmcp__[a-zA-Z0-9_-]+/g)].map(x=>x[0]);
  if(uiTitles.has(title)&&references.length&&references.every(n=>uiTool.test(n)&&definitions.some(t=>t.name===n)&&!active.some(t=>t.name===n))&&!protectedText.test(body)){
   stats.uiSections++;return '';
  }
  if(hasSkill&&/^the following skills are available\b/.test(title)){
   const reduced=compactSkills(body);if(reduced!==body)stats.skillSections++;
   return header+reduced;
  }
  return header+body;
 }).join('');
}
// Match only standalone metadata blocks outside code fences and quoted prose.
function metadataSpans(text){
 const spans=[];let fence=null,offset=0,start=null,tag=null;
 for(const line of text.split(/(?<=\n)/)){
  const mark=line.match(/^\s*(`{3,}|~{3,})/);
  if(mark){if(!fence)fence=mark[1][0];else if(fence===mark[1][0])fence=null;}
  if(!fence){
   if(start===null){const match=line.match(/^<(system-reminder|environment_context)>/);if(match){start=offset;tag=match[1];}}
   if(start!==null&&new RegExp('</'+tag+'>\\s*$').test(line)){
    spans.push({start,end:offset+line.length,value:text.slice(start,offset+line.length).trim(),tag});start=null;tag=null;
   }
  }
  offset+=line.length;
 }
 return spans;
}
export function optimizeMessages(body,{profile='coding',extraTools=[]}={}){
 if(!['coding','all'].includes(profile))throw new Error('Invalid Claude tool profile: '+profile);
 const stats={profile,catalogSections:0,skillSections:0,uiSections:0,duplicateReminders:0,duplicateEnvironments:0};
 // Full validation still occurs in fromMessages before any definitions are used.
 const definitions=body.tools||[];
 if(!Array.isArray(definitions))return {body,stats};
 const allowed=new Set([...CODING_TOOLS,...extraTools]);
 const active=profile==='all'?definitions:definitions.filter(t=>allowed.has(t?.name));
 if(body.tool_choice?.type==='tool'&&definitions.some(t=>t?.name===body.tool_choice.name)&&!active.some(t=>t?.name===body.tool_choice.name))throw Object.assign(new Error('Requested tool is disabled by the Claude '+profile+' profile: '+body.tool_choice.name),{status:400});
 const result={...body,tools:active,messages:body.messages?.map(m=>({...m,content:Array.isArray(m.content)?m.content.map(c=>({...c})):m.content}))};
 const slots=[];
 const add=(get,set,scope)=>{if(typeof get()!=='string')return;if(scope==='system')set(optimizeSystem(get(),definitions,active,stats));slots.push({get,set,scope});};
 if(typeof body.system==='string')add(()=>result.system,x=>result.system=x,'system');
 else if(Array.isArray(body.system)){
  result.system=body.system.map(c=>({...c}));
  for(const c of result.system)if(c.type==='text')add(()=>c.text,x=>c.text=x,'system');
 }
 for(const m of result.messages||[]){
  if(!['user','assistant','system'].includes(m.role))continue;
  if(typeof m.content==='string')add(()=>m.content,x=>m.content=x,m.role);
  else if(Array.isArray(m.content))for(const c of m.content)if(c.type==='text')add(()=>c.text,x=>c.text=x,m.role);
 }
 const seen=new Set();
 for(const slot of slots.reverse()){
  let text=slot.get();const spans=metadataSpans(text);
  for(const span of spans.reverse()){
   const identity=slot.scope+'\0'+span.value;
   if(seen.has(identity)){
    text=text.slice(0,span.start)+text.slice(span.end);
    if(span.tag==='system-reminder')stats.duplicateReminders++;else stats.duplicateEnvironments++;
   }else seen.add(identity);
  }
  slot.set(text);
 }
 stats.toolsBefore=definitions.length;stats.toolsAfter=active.length;
 stats.droppedTools=definitions.filter(t=>!active.includes(t)).map(t=>t?.name);
 stats.beforeBytes=bytes(body);stats.afterBytes=bytes(result);
 return {body:result,stats};
}
