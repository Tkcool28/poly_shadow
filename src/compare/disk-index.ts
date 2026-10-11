/** Disposable derived state. Never authority: rebuilt from complete journal. */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const activeIndexes=new Map<object,{db:DatabaseSync;directory:string}>();
function retire(token:object):void {const owned=activeIndexes.get(token);if(!owned)return;activeIndexes.delete(token);try{owned.db.close();}finally{rmSync(owned.directory,{recursive:true,force:true});}}
const finalizer=new FinalizationRegistry<object>(retire);
process.once('exit',()=>{for(const token of activeIndexes.keys())try{retire(token);}catch{/* process already exiting */}});
export class DiskIndex {
  readonly directory = mkdtempSync(join(tmpdir(), 'poly2-derived-'));
  readonly db = new DatabaseSync(join(this.directory, 'index.sqlite'));
  private token={};
  constructor() {
    this.db.exec('PRAGMA cache_size=-2048; PRAGMA synchronous=OFF; PRAGMA journal_mode=MEMORY;');
    activeIndexes.set(this.token,{db:this.db,directory:this.directory});
    finalizer.register(this,this.token,this.token);
  }
  private closed=false;
  close(): void { if(this.closed)return; this.closed=true; finalizer.unregister(this.token);retire(this.token); }
}
export class DiskMap<K extends string | number,V> {
  constructor(readonly index: DiskIndex, readonly table: string) {
    if (!/^[a-z_]+$/.test(table)) throw new Error('invalid derived table');
    index.db.exec(`CREATE TABLE ${table}(key TEXT PRIMARY KEY, body TEXT NOT NULL, ordinal INTEGER NOT NULL); CREATE INDEX ${table}_ordinal ON ${table}(ordinal); CREATE TABLE ${table}_meta(n INTEGER NOT NULL); INSERT INTO ${table}_meta VALUES(0); CREATE TRIGGER ${table}_insert AFTER INSERT ON ${table} BEGIN UPDATE ${table}_meta SET n=n+1; END; CREATE TRIGGER ${table}_delete AFTER DELETE ON ${table} BEGIN UPDATE ${table}_meta SET n=n-1; END`);
  }
  get size(): number { return Number(this.index.db.prepare(`SELECT n FROM ${this.table}_meta`).get()!.n); }
  get(key:K): V | undefined { const r=this.index.db.prepare(`SELECT body FROM ${this.table} WHERE key=?`).get(JSON.stringify(key)); return r ? JSON.parse(String(r.body)) as V : undefined; }
  has(key:K): boolean { return !!this.index.db.prepare(`SELECT 1 FROM ${this.table} WHERE key=?`).get(JSON.stringify(key)); }
  set(key:K,value:V): this {
    this.index.db.prepare(`INSERT INTO ${this.table} VALUES(?,?,(SELECT coalesce(max(ordinal),0)+1 FROM ${this.table})) ON CONFLICT(key) DO UPDATE SET body=excluded.body`).run(JSON.stringify(key),JSON.stringify(value)); return this;
  }
  delete(key:K): boolean { return Number(this.index.db.prepare(`DELETE FROM ${this.table} WHERE key=?`).run(JSON.stringify(key)).changes)>0; }
  *values(): Generator<V> { for (const r of this.index.db.prepare(`SELECT body FROM ${this.table} ORDER BY ordinal`).iterate()) yield JSON.parse(String(r.body)) as V; }
  *keys(): Generator<K> { for (const r of this.index.db.prepare(`SELECT key FROM ${this.table} ORDER BY ordinal`).iterate()) yield JSON.parse(String(r.key)) as K; }
}
export class DiskSet {
  readonly map: DiskMap<string,boolean>;
  constructor(index:DiskIndex, table:string) { this.map=new DiskMap(index,table); }
  get size():number {return this.map.size;}
  has(key:string):boolean {return this.map.has(key);}
  add(key:string):this {this.map.set(key,true); return this;}
  delete(key:string):boolean {return this.map.delete(key);}
  [Symbol.iterator]():Generator<string> {return this.map.keys();}
}
/** Physical UTF-8 lines, one bounded I/O block plus one complete frame. */
export function* journalLines(path:string):Generator<string> {
  const fd=openSync(path,'r'), decoder=new StringDecoder('utf8'), block=Buffer.alloc(65536);
  let pending='';
  try {
    for (;;) {
      const n=readSync(fd,block,0,block.length,null);
      if (!n) break;
      pending+=decoder.write(block.subarray(0,n));
      let end:number;
      while ((end=pending.indexOf('\n'))>=0) {yield pending.slice(0,end); pending=pending.slice(end+1);}
    }
    pending+=decoder.end();
    if (pending) throw new Error('capture: torn journal; immutable bytes preserved, recovery refused');
  } finally {closeSync(fd);}
}
