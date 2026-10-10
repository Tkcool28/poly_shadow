/**
 * REST source pollers — Phase 3 independent sources:
 *   REST_TRADES   — Data API GET /trades?user=…&takerOnly=false
 *   REST_ACTIVITY — Data API GET /activity?user=…
 *
 * Independence rules (handoff §4/§7):
 * - Each poll preserves RAW payload + per-request telemetry (timing, cache
 *   headers, newest source timestamp, new/duplicate counts, errors).
 * - NO freshness rejection: a late record is still recorded; its lateness
 *   is measured (sourceTs vs firstSeenUtc), never used to discard.
 * - Dedup identity is source-native (racing.ts), seeded from durable
 *   storage at startup — restart delivery is idempotent.
 * - Polling cadence is independently chosen (config), never Poly2's.
 */

import { restGet } from './egress.js';
import { randomUUID, createHash } from 'node:crypto';
import type {
  ActivityPayload, RacingStore, Reconciler, RestRawRow,
} from './racing.js';
import { activityIdentity, normalizeRestRaw, tradesIdentity } from './racing.js';
import { OperationalEvidence } from './operational-evidence.js';
import type { TradesPayload } from './racing.js';

type FetchFn = typeof restGet;

/** Only bounded page validation failures qualify for wallet-local isolation.
 * Index, publication and receipt failures must never inherit this marker. */
class RecoverableRestPageError extends Error {}

export interface RestPollerOpts {
  source: 'REST_TRADES' | 'REST_ACTIVITY';
  endpoint: 'trades' | 'activity';
  baseUrl: string;
  wallets: ReadonlySet<string>;
  intervalMs: number;
  limit?: number;
  /** Prospective acquisition amendment only; production wiring leaves disabled. */
  pagination?: { maxPages: number; overlap: number };
}

export class RestPoller {
  private timer: ReturnType<typeof setInterval> | null = null;

  private polling = false;
  private activeWallets = new Set<string>();

  constructor(
    private opts: RestPollerOpts,
    private store: RacingStore,
    private reconciler: Reconciler,
    private nowIso: () => string = () => new Date().toISOString(),
    private fetchFn: FetchFn = restGet,
    private operational?: OperationalEvidence,
  ) {
    if((opts.source==='REST_TRADES')!==(opts.endpoint==='trades'))throw Error('REST source endpoint mismatch');
    const limit=opts.limit ?? 100;
    const cap=opts.endpoint==='trades'?10000:500;
    if(!Number.isInteger(limit)||limit<1||limit>cap)throw Error('invalid REST page limit');
    const paging=opts.pagination;
    if(paging&&(!Number.isInteger(paging.maxPages)||paging.maxPages<1||paging.maxPages>16||!Number.isInteger(paging.overlap)||paging.overlap<1||paging.overlap>=limit))throw Error('invalid bounded REST pagination budget');
    const sink=this.operational;
    if(sink){this.store.gatePublications(()=>sink.assertUsable());sink.onBroken(() => this.stop());}
    // Restart idempotence: previously committed identities are never
    // re-recorded after a process restart.
    // Exact disk-backed identity lookup; no startup arrays or lifetime sets.
  }

  start(): void {
    this.operational?.assertUsable();
    if (this.timer) return;
    void this.runPollCycle();
    this.timer = setInterval(() => void this.runPollCycle(), this.opts.intervalMs);
  }

  private async runPollCycle(): Promise<void> {
    // pollAll isolates only proven receipted page failures. Anything escaping
    // that boundary is unsafe or unclassified: retire the scheduled source.
    try { await this.pollAll(); } catch { this.stop(); }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Number of source-native identities already committed (tests). */
  get seenCount(): number { return this.store.identityCount(this.opts.source); }

  private url(wallet: string, offset=0): string {
    const base = `${this.opts.baseUrl}/${this.opts.endpoint}?user=${wallet}`
      + `&limit=${this.opts.limit ?? 100}`;
    // takerOnly=false: /trades otherwise defaults to taker-only, which would
    // silently drop the maker population this project exists to study.
    const legacy=this.opts.endpoint === 'trades' ? `${base}&takerOnly=false` : base;
    return this.opts.pagination ? `${legacy}&offset=${offset}` : legacy;
  }

  async pollAll(): Promise<void> {
    this.operational?.assertUsable();
    if (this.polling) {
      for(const wallet of this.opts.wallets)this.skipped(wallet.toLowerCase(), 'SOURCE_POLL_IN_FLIGHT');
      return;
    } // never overlap polls of the same source
    this.polling = true;
    try {
      for (const wallet of this.opts.wallets) {
        try { await this.pollWallet(wallet.toLowerCase()); }
        catch (err) {
          // Rejection arrives only after the page and final-poll receipts have
          // succeeded. No sink means no durable receipt proof; fail closed.
          if (!(err instanceof RecoverableRestPageError) || !this.operational) throw err;
          this.operational.assertUsable();
          this.store.assertUsable();
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private skipped(wallet:string,reason:string):void {
    this.operational?.assertUsable();
    this.operational?.restReceipt({recordType:'REST_POLL',pollId:randomUUID(),source:this.opts.source,wallet,
      outcome:'SKIPPED',reason,requestStartUtc:null,responseUtc:null,httpStatus:null,requestParams:null,
      requestUrl:null,cacheHeaders:null,pageCount:0,itemCount:0,alreadySeen:0,newIdentities:0,
      orderingEvidence:'NO_REQUEST',firstIdentity:null,lastIdentity:null,firstTimestamp:null,lastTimestamp:null,identityVectorSha256:null,identityVectorComplete:false,quarantineIds:[],
      publication:'NOT_ATTEMPTED',nextCursor:null,nextOffset:null,pagination:'UNKNOWN_UNPROVEN'});
  }

  /** Bounded legacy offset traversal. Observed overlap is diagnostic, never a
   * snapshot/watermark proof. No source timestamp is used to backdate arrival. */
  async pollWallet(wallet: string): Promise<void> {
    this.operational?.assertUsable();
    wallet=wallet.toLowerCase();
    let configured=false;for(const member of this.opts.wallets)if(member.toLowerCase()===wallet)configured=true;
    if(!configured)throw Error('REST wallet outside configured cohort');
    if(this.activeWallets.has(wallet)){this.skipped(wallet,'WALLET_POLL_IN_FLIGHT');return;}
    this.activeWallets.add(wallet);
    const pollId=randomUUID(),limit=this.opts.limit ?? 100,paging=this.opts.pagination;
    let pages=0,totalItems=0,totalNew=0,totalSeen=0,offset=0;
    let outcome='SKIPPED',stopReason='INDEX_PREFLIGHT',pollError:unknown=null;
    let previousTail:string[]=[];
    let lastReceipt:Record<string,unknown>={};
    const quarantineIds:string[]=[];
    const recordQuarantine=(identity:string|null,errorClass:Parameters<OperationalEvidence['quarantine']>[0]['errorClass'],reason:string,id:string)=>{const q=this.quarantine(wallet,identity,errorClass,reason,id);if(q)quarantineIds.push(q);};
    try {
      try { this.store.assertUsable(); await this.store.initializeIndex(); }
      catch(err){outcome='PUBLICATION_FAILURE';recordQuarantine(null,'INDEX_ERROR',`index preflight: ${String(err)}`,pollId);throw err;}
      this.operational?.assertUsable();
      const budget=paging?.maxPages ?? 1,overlap=paging?.overlap ?? 0;
      for(let page=0;page<budget;page++){
        this.operational?.assertUsable();
        const quarantineStart=quarantineIds.length;
        const requestUrl=this.url(wallet,offset),requestStartUtc=this.nowIso();
        const requestParams=Object.fromEntries(new URL(requestUrl).searchParams);
        let status:number|null=null,responseUtc:string|null=null;
        let headers:Record<string,unknown>={age:null,cacheControl:null,etag:null,date:null};
        let items:unknown[]=[],error:string|null=null,thrown:unknown=null;
        let newCount=0,dupCount=0,published=0,newestTs:number|null=null;
        let pageOutcome='SUCCESS_EMPTY',publication='NOT_ATTEMPTED';
        let overlapState=page===0?'NOT_APPLICABLE':'UNVERIFIED';
        let identityVectorComplete=false;
        const ids:string[]=[];
        try {
          const res=await this.fetchFn(requestUrl);
          responseUtc=this.nowIso();status=res.status;headers={...headers,...res.headers};
          if(status!==200){pageOutcome='HTTP_FAILURE';error=`HTTP ${status}`;}
          else if(res.bodyError){pageOutcome=res.bodyError.outcome;error=res.bodyError.message;}
          else if(!Array.isArray(res.body)){pageOutcome='PARSE_FAILURE';error=res.parseError??'malformed REST non-array body';}
          else {items=res.body;pageOutcome=items.length?'SUCCESS_NONEMPTY':'SUCCESS_EMPTY';}
        } catch(err){responseUtc=this.nowIso();error=String(err);pageOutcome=OperationalEvidence.errorClass(err)==='TIMEOUT'?'TIMEOUT':err instanceof SyntaxError?'PARSE_FAILURE':'HTTP_FAILURE';}
        this.operational?.assertUsable();
        if(error)recordQuarantine(null,status===429?'HTTP_429':status===503?'HTTP_503':pageOutcome==='TIMEOUT'?'TIMEOUT':pageOutcome==='PARSE_FAILURE'?'MALFORMED_PAYLOAD':'HTTP_FAILURE',error,pollId);
        // Validate the entire bounded page before publication. A malformed item
        // cannot masquerade as an empty success or a partial identity vector.
        if(!error){
          try {
            if(items.length>limit)throw Error('malformed REST overflow page');
            for(const value of items){
              if(!value||typeof value!=='object'||Array.isArray(value))throw Error('malformed REST item');
              const item=value as Record<string,unknown>;
              if(typeof item.transactionHash!=='string'||!item.transactionHash||typeof item.proxyWallet!=='string'||!item.proxyWallet||typeof item.timestamp!=='number'||!Number.isFinite(item.timestamp)||typeof item.size!=='number'||!Number.isFinite(item.size))throw Error('malformed REST item identity fields');
              if(this.opts.source==='REST_TRADES'&&(typeof item.asset!=='string'||typeof item.price!=='number'||!Number.isFinite(item.price)))throw Error('malformed REST trade identity fields');
              if(this.opts.source==='REST_ACTIVITY'&&typeof item.type!=='string')throw Error('malformed REST activity identity fields');
              const identity=this.opts.source==='REST_TRADES'?tradesIdentity(item as TradesPayload):activityIdentity(item as ActivityPayload);
              ids.push(identity);
              const ts=typeof item.timestamp==='number'?item.timestamp:null;
              if(ts!==null&&(newestTs===null||ts>newestTs))newestTs=ts;
            }
            identityVectorComplete=true;
          }catch(err){error=String(err);thrown=new RecoverableRestPageError(error,{cause:err});pageOutcome='PARSE_FAILURE';recordQuarantine(null,'MALFORMED_PAYLOAD',error,pollId);}
        }
        if(!error&&page>0){
          overlapState=previousTail.length===overlap&&previousTail.every((id,i)=>ids[i]===id)?'MATCHED':'MISSING_OR_MOVED';
        }
        if(!error){
          publication='SUCCESS';
          for(let i=0;i<items.length;i++){
            const item=items[i] as Record<string,unknown>,identity=ids[i]!;
            try {
              if(this.store.hasRestPublication(this.opts.source,identity))dupCount++;
              else {
                this.commit(wallet,identity,item,typeof item.timestamp==='number'?item.timestamp:null,
                  {requestStartUtc,responseUtc:responseUtc!,httpStatus:status!,ageHeader:headers.age as string|null,cacheControl:headers.cacheControl as string|null});
                newCount++;published++;
              }
              // A durable exact publication is the only recovery authority,
              // including restart-repaired publication; no empty poll recovery.
              this.operational?.resolveQuarantinesForRaw(`rest:${this.opts.source}:${identity}`,'RECOVERED',`source:${this.opts.source}:${identity}`,'PUBLICATION_CONFIRMED',false);
            }catch(err){
              this.operational?.assertUsable();
              error=String(err);thrown=err;pageOutcome='PUBLICATION_FAILURE';publication='FAILURE';
              recordQuarantine(identity,'PUBLICATION_ERROR',error,pollId);break;
            }
          }
        }
        try {
          this.store.appendPollTelemetry({source:this.opts.source,wallet,requestStartUtc,responseUtc,httpStatus:status,
            ageHeader:headers.age as string|null,cacheControl:headers.cacheControl as string|null,newestSourceTs:newestTs,
            returned:items.length,newIdentities:newCount,duplicates:dupCount,intervalMs:this.opts.intervalMs,error,atUtc:this.nowIso()});
        }catch(err){
          this.operational?.assertUsable();
          // A broken scientific index following an already quarantined item
          // is the same failure, not a second failed poll.
          if(!thrown){recordQuarantine(null,'PUBLICATION_ERROR',`poll telemetry publication: ${String(err)}`,pollId);thrown=err;}
          error=String(thrown);pageOutcome='PUBLICATION_FAILURE';publication='FAILURE';
        }
        pages++;totalItems+=items.length;totalNew+=newCount;totalSeen+=dupCount;outcome=pageOutcome;
        const capped=items.length>=limit;
        const proposedOffset=offset+limit-overlap;
        const offsetCap=this.opts.endpoint==='trades'?10000:5000;
        stopReason=error?'FAILURE':overlapState==='MISSING_OR_MOVED'?'UNSTABLE_OVERLAP':!capped?'SHORT_PAGE':!paging?'PAGINATION_DISABLED':page+1>=budget?'REQUEST_BUDGET_EXHAUSTED':proposedOffset>offsetCap?'OFFSET_CAP_EXHAUSTED':'CONTINUE';
        const nextOffset=stopReason==='CONTINUE'?proposedOffset:null;
        if(capped||stopReason==='UNSTABLE_OVERLAP')recordQuarantine(null,'OTHER',`REST completeness UNPROVEN: ${stopReason}; limit ${limit}`,pollId);
        lastReceipt={recordType:'REST_PAGE',pollId,pageIndex:page,source:this.opts.source,wallet,
          requestUrl,requestParams,offset,limit,requestStartUtc,responseUtc,httpStatus:status,cacheHeaders:headers,
          outcome:pageOutcome,error,itemCount:items.length,atApiLimit:capped,orderingEvidence:'Returned order only; no snapshot or cross-poll watermark proof',
          overlap:overlapState,firstIdentity:ids[0]??null,lastIdentity:ids.at(-1)??null,
          firstTimestamp:(items[0] as Record<string,unknown>|null)?.timestamp??null,lastTimestamp:(items.at(-1) as Record<string,unknown>|null)?.timestamp??null,
          identityVectorComplete,identityVectorSha256:createHash('sha256').update(ids.join('\n')).digest('hex'),
          alreadySeen:dupCount,newIdentities:newCount,published,publication,nextCursor:null,nextOffset,
          quarantineIds:quarantineIds.slice(quarantineStart),pagination:'UNKNOWN_UNPROVEN',stopReason};
        this.operational?.restReceipt(lastReceipt);
        if(thrown)throw thrown;
        if(nextOffset===null)break;
        previousTail=ids.slice(-overlap);offset=nextOffset;
      }
    }catch(err){pollError=err;throw err;}
    finally {
      this.activeWallets.delete(wallet);
      // Never recurse into a broken operational sink. An unreceipted request
      // after sink failure is fatal, not a manufactured success receipt.
      if(!this.operational||this.operational.isUsable())this.operational?.restReceipt({requestUrl:null,requestParams:null,requestStartUtc:null,responseUtc:null,httpStatus:null,cacheHeaders:null,firstIdentity:null,lastIdentity:null,firstTimestamp:null,lastTimestamp:null,identityVectorSha256:null,identityVectorComplete:false,...lastReceipt,recordType:'REST_POLL',pollId,source:this.opts.source,wallet,
        quarantineIds,vectorScope:'LAST_PAGE_ONLY; per-page vector hashes and first/last identity/timestamp metadata are in linked REST_PAGE receipts; full vectors are not stored',outcome,error:pollError?String(pollError):lastReceipt.error??null,pageCount:pages,itemCount:totalItems,newIdentities:totalNew,alreadySeen:totalSeen,
        publication:outcome==='PUBLICATION_FAILURE'?'FAILURE':pages?'SEE_PAGE_RECEIPTS':'NOT_ATTEMPTED',stopReason,nextCursor:null,nextOffset:null,
        pagination:'UNKNOWN_UNPROVEN'});
    }
  }

  private quarantine(wallet:string,identity:string|null,errorClass:Parameters<OperationalEvidence['quarantine']>[0]['errorClass'],reason:string,pollId:string):string|undefined {
    this.operational?.assertUsable();
    return this.operational?.quarantine({pollId,component:this.opts.source,source:this.opts.source,sourceIdentity:identity,
      rawEvidenceRef:identity?`rest:${this.opts.source}:${identity}`:null,rpcRequestId:null,errorClass,
      reason:`poll ${pollId}: ${reason}`.slice(0,512),eventIdentityKnown:identity!==null,wallet,txHash:null,logIdentity:null,
      affectedRange:null,scientificImpactPossible:true}).quarantineId;
  }

  /** Commit one raw evidence row + one normalized source observation +
   *  reconciliation membership. Order: raw first (evidence before meaning). */
  private commit(
    wallet: string,
    identity: string,
    item: Record<string, unknown>,
    sourceTs: number | null,
    http: { requestStartUtc: string; responseUtc: string; httpStatus: number; ageHeader: string | null; cacheControl: string | null },
  ): void {
    this.operational?.assertUsable();
    const firstSeenUtc = this.nowIso();
    const raw: RestRawRow = {
      source: this.opts.source as RestRawRow['source'], wallet, identity,
      payload: item, requestStartUtc: http.requestStartUtc,
      responseUtc: http.responseUtc, httpStatus: http.httpStatus,
      ageHeader: http.ageHeader, cacheControl: http.cacheControl,
      sourceTs, firstSeenUtc, completedUtc:this.nowIso(),
    };
    const savedRaw=this.store.restRawIdentity(this.opts.source,identity);
    if(!savedRaw) this.store.appendRestRaw(raw);
    const observation=this.store.sourceIdentity(this.opts.source,identity) ?? normalizeRestRaw(savedRaw ?? raw);
    if(!this.store.hasIdentity(this.opts.source,identity)) this.store.appendSourceObservation(observation);
    this.reconciler.record(this.opts.source,identity,observation.groupKey,observation.sourceFirstSeenUtc);
  }
}
