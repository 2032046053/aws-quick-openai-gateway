// Import explicitly captured local files; never discover browser credentials automatically.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
const [harPath,cookiePath,outboundProxy]=process.argv.slice(2);
if(!harPath||!cookiePath)throw new Error('Usage: node import-session.mjs <capture.har> <cookie.txt> [outbound-proxy]');
const entries=JSON.parse(fs.readFileSync(harPath,'utf8')).log.entries;
const entry=entries.findLast(e=>e.request.url.includes('/operation/ChatBidirectionalStream'));
if(!entry)throw new Error('No Quick conversation WebSocket found in HAR');
const url=new URL(entry.request.url);
if(url.hostname!=='quick.aws.com'||url.protocol!=='wss:')throw new Error('Unexpected Quick host');
const accountId=url.searchParams.get('awsAccountId');
if(!/^\d{12}$/.test(accountId||''))throw new Error('Invalid account ID');
const cookie=fs.readFileSync(cookiePath,'utf8').replace(/^\uFEFF/,'').trim();
if(!cookie || /[\r\n]/.test(cookie))throw new Error('Cookie must be a single header value');
const session={accountId,cookie,csrf:encodeURIComponent(url.searchParams.get('mbtc')),outboundProxy:outboundProxy||undefined};
if(!url.searchParams.get('mbtc'))throw new Error('Missing CSRF parameter');
fs.writeFileSync('session.local.json',JSON.stringify(session,null,2),{mode:0o600});
if(!fs.existsSync('.env')) {
  const apiKey='sk-quick-'+randomBytes(24).toString('hex');
  fs.writeFileSync('.env',`PROXY_KEY=${apiKey}\nQUICK_SESSION_FILE=./session.local.json\nPORT=8787\n`,{mode:0o600});
  fs.writeFileSync('client.local.json',JSON.stringify({baseURL:'http://127.0.0.1:8787/v1',apiKey,model:'quick'},null,2),{mode:0o600});
}
console.log('Imported current session locally. Client settings: '+path.resolve('client.local.json'));
