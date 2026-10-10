/** Selective, synchronous JSON streaming. No whole document buffer. */
import { openSync, readSync, closeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
export function archiveSchemaVersion(path:string):unknown {
  const cursor=new JsonCursor(path);let version:unknown;
  try {cursor.object(key=>{if(key==='manifest'){const manifest=cursor.value() as {schemaVersion?:unknown};version=manifest?.schemaVersion;}else cursor.skipValue();});cursor.finish();return version;}finally{cursor.close();}
}
export class JsonCursor {
  private fd:number;
  private block=Buffer.alloc(65536);
  private decoder=new StringDecoder('utf8');
  private text=''; private offset=0; private eof=false;
  constructor(path:string){this.fd=openSync(path,'r');}
  close():void{closeSync(this.fd);}
  private peek():string {
    while(this.offset>=this.text.length&&!this.eof){const n=readSync(this.fd,this.block,0,this.block.length,null);this.text=n?this.decoder.write(this.block.subarray(0,n)):this.decoder.end();this.offset=0;if(!n)this.eof=true;}
    return this.text[this.offset]??'';
  }
  private take():string {const c=this.peek();if(!c)throw new Error('archive: unexpected EOF');this.offset++;return c;}
  private ws():void{while(this.peek()&&/\s/.test(this.peek()))this.offset++;}
  expect(c:string):void{this.ws();if(this.take()!==c)throw new Error('archive: invalid JSON delimiter');}
  finish():void{this.ws();if(this.peek())throw new Error('archive: trailing JSON bytes');}
  *stringChunks():Generator<string>{
    this.expect('"');let out='';
    for(;;){let c=this.take();if(c==='"'){if(out)yield out;return;}
      if(c==='\\'){const escape=this.take();let token='\\'+escape;if(escape==='u')for(let i=0;i<4;i++)token+=this.take();c=JSON.parse('"'+token+'"') as string;}
      else if(c.charCodeAt(0)<32)throw new Error('archive: invalid control character');
      out+=c;
      if(out.length>=8192){const last=out.charCodeAt(out.length-1);if(last<0xd800||last>0xdbff){yield out;out='';}}
    }
  }
  value():unknown {
    this.ws();let raw='',depth=0,quoted=false,escape=false;
    for(;;){const c=this.peek();if(!c)break;if(!quoted&&depth===0&&(c===','||c===']'||c==='}'||/\s/.test(c)))break;
      raw+=this.take();
      if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;}
      else if(c==='"')quoted=true;else if(c==='{'||c==='[')depth++;else if(c==='}'||c===']')depth--;
      if(depth<0)throw new Error('archive: unbalanced JSON');
    }
    return JSON.parse(raw);
  }
  skipValue():void {
    this.ws();let depth=0,quoted=false,escape=false,seen=false;
    for(;;){const c=this.peek();if(!c)break;if(!quoted&&depth===0&&(c===','||c===']'||c==='}'||/\s/.test(c)))break;
      this.take();seen=true;
      if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;}
      else if(c==='"')quoted=true;else if(c==='{'||c==='[')depth++;else if(c==='}'||c===']')depth--;
    }
    if(!seen||depth||quoted)throw new Error('archive: incomplete JSON value');
  }
  object(field:(key:string)=>void):void {
    this.expect('{');this.ws();if(this.peek()==='}'){this.take();return;}const seen=new Set<string>();
    for(;;){let key='';for(const chunk of this.stringChunks())key+=chunk;if(seen.has(key))throw new Error('archive: duplicate JSON key');seen.add(key);this.expect(':');field(key);this.ws();const end=this.take();if(end==='}')return;if(end!==',')throw new Error('archive: invalid object');}
  }
  array(item:(value:unknown)=>void):void{
    this.expect('[');this.ws();if(this.peek()===']'){this.take();return;}
    for(;;){item(this.value());this.ws();const end=this.take();if(end===']')return;if(end!==',')throw new Error('archive: invalid array');}
  }
}
