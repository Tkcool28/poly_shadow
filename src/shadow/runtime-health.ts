import { dataQuality, type DataQualityInput } from './data-quality.js';
import type { OperationalEvidence } from './operational-evidence.js';

/** Shared composition for the entrypoint's operational runtime snapshot. */
export function runtimeHealthSnapshot(
  watcher: { memoryTelemetry(): DataQualityInput & Record<string, unknown> },
  racing: { indexTelemetry(): DataQualityInput & Record<string, unknown> },
  operational: OperationalEvidence,
  token: () => unknown,
) {
  const snapshot = { ...watcher.memoryTelemetry(), ...racing.indexTelemetry(),
    ...(operational.isUsable() ? { unresolvedQuarantine: operational.unresolvedQuarantineCount(), ...operational.restQuality(), restCompleteness: operational.restCompletenessState() }
      : { unresolvedQuarantine: null, restCompleteness: null }),
    operationalSinkBroken: !operational.isUsable(), operationalSink: operational.failureStatus(), token: token() };
  const failureClass=snapshot.operationalSinkBroken?'EVIDENCE_SINK_FAILURE'
    : (snapshot.unresolvedQuarantine ?? 0)>0 || snapshot.recoveryRequired?'SOURCE_FAILURE':null;
  return { ...snapshot, failureClass, dataQuality: dataQuality(snapshot) };
}
