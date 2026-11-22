import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import WebSocket, {WebSocketServer} from 'ws';
import {createProxy} from './server.mjs';

test('HTTP and binary WebSocket tunnel, authentication and route isolation', async () => {
  const accountId='123456789012', key='local-test-secret';
  const base=`/sn/account/${accountId}`;
  let seen;
  const upstream=http.createServer((req,res) => {
    seen={url:req.url,headers:req.headers};
    res.setHeader('content-type','application/octet-stream');
    req.pipe(res);
  });
  const wss=new WebSocketServer({server:upstream});
  wss.on('connection',(ws,req) => {
    seen={url:req.url,headers:req.headers};
    ws.send(Buffer.from([0,255,1])); // immediate data during upgrade
    ws.on('message',(data,isBinary) => ws.send(data,{binary:isBinary}));
    ws.on('error',()=>{});
  });
  upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
  const proxy=createProxy({accountId,key,cookie:'test=session',csrf:'abc%2Fdef%3D',upstream:`http://127.0.0.1:${upstream.address().port}`});
  proxy.listen(0,'127.0.0.1'); await once(proxy,'listening');
  const address=`127.0.0.1:${proxy.address().port}`;
  try {
    const path=`${base}/qbsproxy/quicksight/accounts/${accountId}/invocations/api/ws-rpc`;
    assert.equal((await fetch(`http://${address}${path}`)).status,401);
    assert.equal((await fetch(`http://${address}/forbidden`,{headers:{'x-proxy-key':key}})).status,404);
    const response=await fetch(`http://${address}${path}?_method=POST`,{method:'POST',headers:{'x-proxy-key':key},body:'payload'});
    assert.equal(await response.text(),'payload');
    assert.equal(seen.headers.cookie,'test=session');
    assert.equal(seen.headers['x-proxy-key'],undefined);
    assert.equal(new URL(seen.url,'http://test').searchParams.get('mbtc'),'abc/def=');
    const ws=new WebSocket(`ws://${address}${base}/wsproxy/service/SpaceNeedleConversationService/operation/ChatBidirectionalStream?wsproxy-protocol=rpc-v2-cbor`,{headers:{'x-proxy-key':key}});
    const immediate=once(ws,'message');
    await once(ws,'open');
    assert.deepEqual((await immediate)[0],Buffer.from([0,255,1]));
    let reply=once(ws,'message');
    const bytes=Buffer.from([0,1,128,255,42]); ws.send(bytes);
    let [data,binary]=await reply; assert.deepEqual(data,bytes); assert.equal(binary,true);
    reply=once(ws,'message'); ws.send('text');
    [data,binary]=await reply; assert.equal(data.toString(),'text'); assert.equal(binary,false);
    const pong=once(ws,'pong'); ws.ping('heartbeat'); await pong;
    ws.close(1000,'done'); const [code]=await once(ws,'close'); assert.equal(code,1000);
  } finally {
    for (const ws of wss.clients) ws.terminate();
    proxy.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>wss.close(r))]);
    await new Promise(r=>upstream.close(r));
  }
});
