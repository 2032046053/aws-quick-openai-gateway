import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const hop = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
function clean(headers) {
  const skip = new Set([...hop, ...String(headers.connection || '').toLowerCase().split(',').map(s => s.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !skip.has(k.toLowerCase())));
}
function equal(a, b) {
  const aa = Buffer.from(a || ''), bb = Buffer.from(b || '');
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

// upstream override is for local integration tests; CLI always uses quick.aws.com.
export function createProxy({accountId, key, cookie = '', csrf = '', upstream = 'https://quick.aws.com'}) {
  if (!/^\d{12}$/.test(accountId || '') || !key) throw new Error('Set QUICK_ACCOUNT_ID (12 digits) and PROXY_KEY');
  const origin = new URL(upstream);
  const csrfQuery = csrf ? decodeURIComponent(csrf) : '';
  const prefix = `/sn/account/${accountId}`;
  const wsPath = `${prefix}/wsproxy/service/SpaceNeedleConversationService/operation/ChatBidirectionalStream`;
  const apiPrefix = `${prefix}/qbsproxy/quicksight/accounts/${accountId}/invocations/`;
  const transport = origin.protocol === 'https:' ? https : http;
  const active = new Set();
  function target(req, ws) {
    if (!equal(req.headers['x-proxy-key'], key)) return {error:401};
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return {error:400};
    const url = new URL(req.url, origin);
    if (url.origin !== origin.origin || url.hash) return {error:400};
    if (ws ? url.pathname !== wsPath : !url.pathname.startsWith(apiPrefix)) return {error:404};
    if (!ws && !['GET','POST','PUT','PATCH','DELETE','HEAD'].includes(req.method)) return {error:405};
    if (url.searchParams.has('awsAccountId') && url.searchParams.get('awsAccountId') !== accountId) return {error:400};
    if (csrf && !url.searchParams.has('mbtc')) url.searchParams.set('mbtc', csrfQuery);
    const headers = clean(req.headers);
    delete headers['x-proxy-key'];
    delete headers.authorization;
    headers.host = origin.host;
    headers.origin = origin.origin;
    headers.referer = `${origin.origin}${prefix}/start/chat`;
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-amzn-csrf-token'] = csrf;
    if (ws) {
      headers.connection = 'Upgrade';
      headers.upgrade = 'websocket';
    }
    return {url, headers};
  }
  function reject(socket, status) {
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  const server = http.createServer((req, res) => {
    const t = target(req, false);
    if (t.error) {res.writeHead(t.error); res.end(); return;}
    const outgoing = transport.request(t.url, {method:req.method, headers:t.headers}, remote => {
      const headers = clean(remote.headers);
      // Upstream cookies belong to AWS; never install them on the local proxy origin.
      delete headers['set-cookie'];
      delete headers['access-control-allow-origin'];
      delete headers['access-control-allow-credentials'];
      res.writeHead(remote.statusCode, headers);
      remote.on('error', () => res.destroy());
      remote.pipe(res);
    });
    outgoing.setTimeout(120000, () => outgoing.destroy(new Error('upstream timeout')));
    outgoing.on('error', () => {
      if (!res.headersSent) {res.writeHead(502); res.end('Upstream unavailable');}
      else res.destroy();
    });
    req.on('aborted', () => outgoing.destroy());
    res.on('close', () => outgoing.destroy());
    req.pipe(outgoing);
  });
  server.on('upgrade', (req, socket, head) => {
    const t = target(req, true);
    if (t.error) {reject(socket, t.error); return;}
    if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket') {reject(socket,400); return;}
    let remoteSocket;
    const outgoing = transport.request(t.url, {method:'GET',headers:t.headers});
    const timer = setTimeout(() => outgoing.destroy(new Error('handshake timeout')),15000);
    socket.on('error', () => outgoing.destroy());
    socket.on('close', () => {clearTimeout(timer); outgoing.destroy(); remoteSocket?.destroy();});
    outgoing.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      clearTimeout(timer);
      remoteSocket = upstreamSocket;
      const lines = [`HTTP/1.1 101 Switching Protocols`];
      for (let i=0;i<response.rawHeaders.length;i+=2) {
        if (response.rawHeaders[i].toLowerCase() !== 'set-cookie') lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i+1]}`);
      }
      socket.write(lines.join('\r\n')+'\r\n\r\n');
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      active.add(upstreamSocket);
      upstreamSocket.on('error', () => socket.destroy());
      upstreamSocket.on('close', () => {active.delete(upstreamSocket); socket.destroy();});
      // Raw tunnel preserves binary/text opcodes, masking, ping/pong, close and backpressure.
      socket.pipe(upstreamSocket).pipe(socket);
    });
    outgoing.on('response', response => {clearTimeout(timer); response.resume(); reject(socket,response.statusCode);});
    outgoing.on('error', () => {clearTimeout(timer); if (!remoteSocket) reject(socket,502); else socket.destroy();});
    outgoing.end();
  });
  server.on('close', () => {for (const socket of active) socket.destroy();});
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createProxy({accountId:process.env.QUICK_ACCOUNT_ID,key:process.env.PROXY_KEY,cookie:process.env.QUICK_COOKIE,csrf:process.env.QUICK_CSRF});
  server.listen(Number(process.env.PORT || 8787), '127.0.0.1', () => console.log('Quick proxy listening on http://127.0.0.1:'+server.address().port));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {server.close(); server.closeAllConnections();});
}
