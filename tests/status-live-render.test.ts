/** Execute the shipped dashboard script with deterministic DOM/clock/fetch fixtures. */
import {expect,it} from 'vitest';
import {readFileSync,existsSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createContext,runInContext} from 'node:vm';
const now='2030-01-01T00:40:00Z';
function fixture(){
 const r=spawnSync('python3',['-B','-c',`import json,types\nfrom pathlib import Path\np=Path('scripts/status/collector.py');m=types.ModuleType('fixture');m.__file__=str(p.resolve());exec(compile(p.read_bytes(),str(p),'exec'),m.__dict__)\ns=m.unbound_status(m.epoch('${now}'),'NO_ACTIVE_RUN')\nprint(json.dumps(s))`],{encoding:'utf8'});
 expect(r.status,r.stderr).toBe(0);return JSON.parse(r.stdout);
}
class Element {
 children:Element[]=[];value='';style:Record<string,string>={};className='';hidden=false;
 classList={add:()=>{},remove:()=>{}};
 set textContent(value:string){this.value=value;this.children=[];}
 get textContent():string{return this.value+this.children.map(c=>c.textContent).join('');}
 append(...children:Element[]){this.children.push(...children);}
 replaceChildren(...children:Element[]){this.value='';this.children=children;}
 setAttribute(){}
}
async function dashboard(data:any){
 const elements=new Map<string,Element>();
 const document={getElementById:(id:string)=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)!;},createElement:()=>new Element()};
 const context=createContext({document,Date:class extends Date{static now(){return Date.parse(now);}},AbortSignal,setInterval:()=>{},fetch:async()=>({ok:true,json:async()=>data})});
 const script=readFileSync('scripts/status/index.html','utf8').split('<script>')[1]!.split('</script>')[0]!;
 runInContext(script,context);await new Promise(r=>setImmediate(r));
 expect(document.getElementById('connection').hidden).toBe(true); // real refresh/render completed, not caught JS failure
 return {context,document,state:()=>document.getElementById('live-match-state').textContent};
}
it('fresh unbound unauthorized publisher JSON renders its state rather than stale',async()=>{
 const data=fixture();const page=await dashboard(data);
 expect(data.stage1LiveMatches.generatedUtc).toBe(data.generatedUtc);
 expect(page.state()).toContain('COMPARISON_NOT_AUTHORIZED');expect(page.state()).not.toContain('STALE / UNAVAILABLE');
 expect(page.document.getElementById('live-match-counts').textContent).toContain('unavailable');
 expect(JSON.stringify(data)).not.toMatch(/\/opt\/|\/var\/|\/workspace\//);
});
it.each([undefined,'invalid','2030-01-01T00:38:29Z','2030-01-01T00:40:01Z'])('authorized missing/invalid/stale/future projection %s still warns',async stamp=>{
 const data=fixture();data.stage1LiveMatches={...data.stage1LiveMatches,authorization:true,state:'ACTIVE',generatedUtc:stamp};
 const page=await dashboard(data);expect(page.state()).toContain('STALE / UNAVAILABLE');
});
it('a fresh authorized projection still ages out at the unchanged 90-second boundary',async()=>{
 const data=fixture();data.stage1LiveMatches={...data.stage1LiveMatches,authorization:true,state:'ACTIVE',generatedUtc:'2030-01-01T00:38:30Z'};
 const page=await dashboard(data);expect(page.state()).toContain('ACTIVE');
 runInContext(`snapshot.stage1LiveMatches.generatedUtc='2030-01-01T00:38:29Z';clock()`,page.context);
 expect(page.state()).toContain('STALE / UNAVAILABLE');
});
it('fresh unavailable projection never renders fabricated counts or confirmation',async()=>{
 const data=fixture();data.stage1LiveMatches={...data.stage1LiveMatches,state:'MONITOR_UNAVAILABLE',generatedUtc:now};
 const page=await dashboard(data);expect(page.state()).toContain('MONITOR_UNAVAILABLE');
 expect(page.document.getElementById('live-match-rows').children).toHaveLength(0);
 expect(page.document.getElementById('live-match-counts').textContent).toContain('unavailable');
});

// GitHub's Ubuntu image supplies Chrome. CI must execute a real browser; local
// hosts without one still run the script/DOM tests above, without claiming browser QA.
const chrome=['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync);
it.skipIf(!chrome&&!process.env.CI)('headless Chrome renders unauthorized and preserves stale/unavailable warnings',()=>{
 expect(chrome,'CI requires its preinstalled Chrome for real dashboard rendering').toBeTruthy();
 const root=mkdtempSync(join(tmpdir(),'status-browser-'));
 try{
  for(const kind of ['unauthorized','stale-authorized','missing-authorized','unavailable']){
   const data=fixture();if(kind!=='unauthorized')data.stage1LiveMatches={...data.stage1LiveMatches,authorization:kind!=='unavailable',state:kind==='unavailable'?'MONITOR_UNAVAILABLE':'ACTIVE',generatedUtc:kind==='missing-authorized'?undefined:kind==='stale-authorized'?'2030-01-01T00:38:29Z':now};
   const prelude=`<script>Date.now=()=>${Date.parse(now)};window.setInterval=()=>0;window.fetch=async()=>({ok:true,json:async()=>(${JSON.stringify(data)})});</script>`;
   const probe=`<script>setTimeout(()=>{const p=document.createElement('pre');p.id='browser-probe';p.textContent=JSON.stringify({state:document.getElementById('live-match-state').textContent,rows:document.getElementById('live-match-rows').children.length,counts:document.getElementById('live-match-counts').textContent,failed:!document.getElementById('connection').hidden});document.body.append(p)},0)</script>`;
   const file=join(root,kind+'.html');writeFileSync(file,readFileSync('scripts/status/index.html','utf8').replace('<script>',prelude+'<script>').replace('</body>',probe+'</body>'));
   const result=spawnSync(chrome!,['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--no-proxy-server','--user-data-dir='+join(root,kind+'-profile'),'--dump-dom','--virtual-time-budget=1000',pathToFileURL(file).href],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
   expect(result.status,result.stderr).toBe(0);const probeText=result.stdout.match(/<pre id="browser-probe">([\s\S]*?)<\/pre>/)?.[1];expect(probeText).toBeTruthy();
   const report=JSON.parse(probeText!.replaceAll('&quot;','"').replaceAll('&amp;','&'));expect(report.failed).toBe(false);expect(report.rows).toBe(0);expect(report.counts).toContain('unavailable');
   expect(report.state).toContain(kind==='unauthorized'?'COMPARISON_NOT_AUTHORIZED':kind==='unavailable'?'MONITOR_UNAVAILABLE':'STALE / UNAVAILABLE');
   if(kind==='unauthorized')expect(report.state).not.toContain('STALE / UNAVAILABLE');
  }
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
