/**
 * Poly-Shadow entrypoint — read-only MULTI-SOURCE trade-discovery shadow.
 * No orders, no signing, no keys, no Poly2 connection. Observation only.
 *
 * Sources (independent — no source validates another; handoff §4):
 *   CHAIN         Polygon V2 event watcher (Phase 2)
 *   REST_TRADES   Data API /trades poller (takerOnly=false: maker+taker)
 *   REST_ACTIVITY Data API /activity poller (separate population)
 * The reconciliation layer (racing.ts) records economic-trade candidate
 * groups, first-source winners, and later corroboration. Unmatched and
 * ungrouped records stay visible.
 *
 * WebSocket trade source: investigated and REJECTED for watched-wallet
 * discovery — see docs/shadow/WS_FEASIBILITY.md.
 */
import { loadConfig } from './config.js';
import { ShadowStore } from './storage.js';
import { ChainWatcher } from './watcher.js';
import { RacingStore, Reconciler, publishChainObservation } from './racing.js';
import { RestPoller } from './rest-poller.js';
import { startMemoryPublisher } from './runtime-memory.js';
import { selfToken } from './memory.js';
import { OperationalEvidence } from './operational-evidence.js';
import { runtimeHealthSnapshot } from './runtime-health.js';
import { assertPrelaunchDisk, storageTelemetry } from './storage-budget.js';
import { installSinkFailureControl, reportSinkFailureControl } from './operational-control.js';

async function main(): Promise<void> {
  const cfg = loadConfig(); // fail-closed: throws on any credential material
  let operational:OperationalEvidence;
  try { operational = new OperationalEvidence(cfg.dataDir); }
  catch (error) {
    reportSinkFailureControl(cfg.dataDir,error,{state:'BROKEN',code:'EVIDENCE_SINK_FAILURE',file:null,error:String(error)},()=>{process.exitCode=74;});
    throw error;
  }
  const startedAt=Date.now();
  try {assertPrelaunchDisk(cfg.dataDir);}catch(error){operational.close();throw error;}
  const store = new ShadowStore(cfg.dataDir);
  const racing = new RacingStore(cfg.dataDir,()=>operational.assertUsable());
  const reconciler = new Reconciler(racing);

  // CHAIN source: each committed observation also enters the racer with its
  // own arrival timestamp. Chain timing evidence is never overwritten.
  const watcher = new ChainWatcher(cfg, store, undefined, undefined, (obs) => {
    operational.assertUsable();
    publishChainObservation(racing, reconciler, obs);
  }, operational);

  let trades: RestPoller | undefined;
  let activity: RestPoller | undefined;
  let stopMemory=()=>{};
  installSinkFailureControl(operational,cfg.dataDir,()=>{
    process.exitCode=74;
    // Reserved operational failure exit is independent of diagnostic disk IO.
    setImmediate(()=>process.exit(74));
    stopMemory(); watcher.stop(); trades?.stop(); activity?.stop();
  });
  const initializePollers=()=>{
    trades = new RestPoller({
      source: 'REST_TRADES', endpoint: 'trades',
      baseUrl: cfg.dataApiBaseUrl, wallets: cfg.watchedWallets,
      intervalMs: cfg.tradesPollMs,
    }, racing, reconciler, undefined, undefined, operational);
    activity = new RestPoller({
      source: 'REST_ACTIVITY', endpoint: 'activity',
      baseUrl: cfg.dataApiBaseUrl, wallets: cfg.watchedWallets,
      intervalMs: cfg.activityPollMs,
    }, racing, reconciler, undefined, undefined, operational);
  };

  console.log('[poly-shadow] starting multi-source observation-only shadow', {
    wallets: [...cfg.watchedWallets].map((w) => w.slice(0, 10) + '…'),
    sources: ['CHAIN', 'REST_TRADES', 'REST_ACTIVITY'],
    tradesPollMs: cfg.tradesPollMs, activityPollMs: cfg.activityPollMs,
    dataDir: cfg.dataDir,
  });

  // Operational mutable snapshot, separate from arrival/scientific evidence.
  let lastAuditAt=0;
  const memoryPublisher=startMemoryPublisher(cfg.dataDir,()=>({...runtimeHealthSnapshot(watcher,racing,operational,selfToken),storage:storageTelemetry(cfg.dataDir,(Date.now()-startedAt)/1000)}), undefined, (snapshot)=>{
    operational.telemetry(snapshot as Record<string, unknown>);
    if (Date.now()-lastAuditAt >= 10*60_000) { lastAuditAt=Date.now(); operational.auditSnapshot({processHealth:'ALIVE',dataQuality:(snapshot as {dataQuality?:unknown}).dataQuality ?? 'UNKNOWN',telemetry:snapshot}); }
  }, (err)=>{ operational.quarantine({component:'PUBLISHER',source:null,sourceIdentity:null,rawEvidenceRef:null,rpcRequestId:null,errorClass:'PUBLICATION_ERROR',reason:`memory publisher: ${String(err).slice(0,256)}`,eventIdentityKnown:false,wallet:null,txHash:null,logIdentity:null,affectedRange:null,scientificImpactPossible:true}); }, ()=>{stopMemory();});
  stopMemory=memoryPublisher.stop;
  const publishMemory=memoryPublisher.publish;

  const shutdown = () => {
    try {
      memoryPublisher.finish(()=>{trades?.stop();activity?.stop();watcher.stop();});
    } finally { process.exit(operational.isUsable()?0:74); }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    operational.assertUsable();
    await store.initializeIndex();
    operational.assertUsable();
    await racing.initializeIndex();
    operational.assertUsable();
    initializePollers();
    publishMemory();
    watcher.start();
    trades!.start();
    activity!.start();
  } catch (err) {
    // Operational evidence exists before index initialization; preserve startup
    // failure context without attempting any source or live action.
    try {
      operational.assertUsable(); // do not recursively quarantine a broken sink
      operational.quarantine({component:'STARTUP',source:null,sourceIdentity:null,rawEvidenceRef:null,rpcRequestId:null,errorClass:'INDEX_ERROR',reason:`startup index/reconciliation failure: ${String(err).slice(0,256)}`,eventIdentityKnown:false,wallet:null,txHash:null,logIdentity:null,affectedRange:null,scientificImpactPossible:true});
    } catch (sinkError) { err=sinkError; } // retain the first latched sink exception
    stopMemory();
    trades?.stop(); activity?.stop(); watcher.stop();
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
    store.close(); racing.close();
    throw err;
  }
}

void main().catch(err => { console.error('[poly-shadow] startup failed', err); process.exitCode ||= 1; });
