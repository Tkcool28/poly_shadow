import { dataQuality, type DataQualityInput } from './data-quality.js';
import type { OperationalEvidence } from './operational-evidence.js';

/** Shared composition for the entrypoint's operational runtime snapshot. */
export function runtimeHealthSnapshot(
  watcher: { memoryTelemetry(): DataQualityInput & Record<string, unknown> },
  racing: { indexTelemetry(): DataQualityInput & Record<string, unknown> },
  operational: OperationalEvidence,
  token: () => unknown,
) {
  const evidence=operational.isUsable()?operational.operationalSnapshot():null;
  const snapshot = { ...watcher.memoryTelemetry(), ...racing.indexTelemetry(), operationalEvidence:evidence,
    ...(operational.isUsable() ? { unresolvedQuarantine: operational.unresolvedQuarantineCount(), ...operational.restQuality(), restCompleteness: operational.restCompletenessState() }
      : { unresolvedQuarantine: null, restCompleteness: null }),
    operationalSinkBroken: !operational.isUsable(), operationalSink: operational.failureStatus(), token: token() };
  const failureClass=snapshot.operationalSinkBroken?'EVIDENCE_SINK_FAILURE'
    : (snapshot.unresolvedQuarantine ?? 0)>0 || snapshot.recoveryRequired?'SOURCE_FAILURE':null;
  const sourceHealth=evidence?[
    {source:'CHAIN',quality:dataQuality({lastProgressUtc:snapshot.lastProgressUtc,recoveryRequired:snapshot.recoveryRequired,indexInvalid:snapshot.indexInvalid,racingIndexInvalid:snapshot.racingIndexInvalid,retryQueue:snapshot.retryQueue,operationalSinkBroken:snapshot.operationalSinkBroken,unresolvedQuarantine:evidence.chain.unresolvedQuarantine,unresolvedRpc:evidence.chain.unresolved})},
    ...evidence.rest.map(s=>({source:s.source,quality:s.consecutiveFailures>=10?{state:'AT_RISK',rules:['consecutive poll failures >= 10']}:s.lastPollUtc&&Date.now()-Date.parse(s.lastPollUtc)>180000?{state:'AT_RISK',rules:['source poll stale > 180 seconds']}:{state:'UNKNOWN',rules:['REST cross-poll coverage UNKNOWN_UNPROVEN',...(s.pageLimitEver?['sticky page-limit uncertainty']:[])]}})),
  ]:[];
  const quality=dataQuality({...snapshot,sourceProgressUtc:Object.fromEntries((evidence?.rest??[]).map(s=>[s.source,s.lastPollUtc]))});
  const failedSources=sourceHealth.filter(s=>s.quality.state==='AT_RISK');
  return { ...snapshot, sourceHealth, failureClass, dataQuality:failedSources.length?{state:'AT_RISK' as const,rules:[...quality.rules,...failedSources.flatMap(s=>s.quality.rules.map(r=>s.source+': '+r))]}:quality };
}
