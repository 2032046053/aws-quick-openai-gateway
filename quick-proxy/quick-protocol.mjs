import {EventStreamCodec} from '@smithy/eventstream-codec';
import {toUtf8, fromUtf8} from '@smithy/util-utf8';
import {Encoder, Decoder} from 'cbor-x';

const eventstream = new EventStreamCodec(toUtf8, fromUtf8);
const cbor = new Encoder({useRecords:false, tagUint8Array:false, mapsAsObjects:true});
const decoder = new Decoder({mapsAsObjects:true});
export function encodeEvent(json, type='rawInputEvent') {
  return eventstream.encode({headers:{
    ':event-type':{type:'string',value:type},
    ':content-type':{type:'string',value:'application/cbor'},
    ':message-type':{type:'string',value:'event'},
  },body:cbor.encode({payload:Buffer.from(JSON.stringify(json))})});
}
export class EventDecoder {
  pending=Buffer.alloc(0);
  push(chunk) {
    this.pending=Buffer.concat([this.pending,Buffer.from(chunk)]);
    const result=[];
    while (this.pending.length>=12) {
      const size=this.pending.readUInt32BE();
      if(size<16 || size>16*1024*1024) throw new Error('Invalid EventStream frame size');
      if(this.pending.length<size) break;
      const message=eventstream.decode(this.pending.subarray(0,size));
      this.pending=this.pending.subarray(size);
      const type=message.headers[':event-type']?.value;
      const kind=message.headers[':message-type']?.value;
      if(kind==='exception' || kind==='error') {
        const name=String(type || message.headers[':exception-type']?.value || 'unknown');
        let detail;
        try{const decoded=decoder.decode(message.body);detail=decoded.message||decoded.Message;}catch{}
        const error=new Error('Quick upstream exception: '+name+(typeof detail==='string'?': '+detail.slice(0,240):''));
        error.code=/limitExceeded|throttl/i.test(name)?'quick_limit_exceeded':'quick_upstream_exception';
        error.status=error.code==='quick_limit_exceeded'?429:502;throw error;
      }
      if(type==='initial-response') continue;
      const body=decoder.decode(message.body);
      if(body.payload == null) continue;
      result.push(JSON.parse(typeof body.payload==='string' ? body.payload : Buffer.from(body.payload).toString('utf8')));
    }
    if(this.pending.length>16*1024*1024) throw new Error('EventStream buffer overflow');
    return result;
  }
}
