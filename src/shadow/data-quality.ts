/** Deterministic operational evidence-quality reduction, deliberately separate
 * from process liveness and frozen comparator/scientific performance rules. */
export type DataQualityState = 'GREEN' | 'DEGRADED' | 'AT_RISK' | 'UNKNOWN';
export interface DataQualityInput {
  recoveryRequired?: boolean; retryQueue?: number; indexInvalid?: boolean; racingIndexInvalid?: boolean;
  lastProgressUtc?: string | null; sourceProgressUtc?: Record<string, string | null>;
  restAtPageLimit?: boolean; restCompletenessUnproven?: boolean; unresolvedQuarantine?: number | null; nowUtc?: string;
  operationalSinkBroken?: boolean;
}
export function dataQuality(input: DataQualityInput): { state: DataQualityState; rules: string[] } {
  const now = Date.parse(input.nowUtc ?? new Date().toISOString());
  const stale = input.lastProgressUtc ? now - Date.parse(input.lastProgressUtc) > 180_000 : false;
  const rules: string[] = [];
  if (input.operationalSinkBroken) rules.push('EVIDENCE_SINK_FAILURE');
  if (input.indexInvalid || input.racingIndexInvalid) rules.push('evidence index invalid');
  if (input.recoveryRequired) rules.push('unresolved chain recovery proof');
  if ((input.unresolvedQuarantine ?? 0) >= 10) rules.push('unresolved quarantine count >= 10');
  if (stale) rules.push('observer progress stale > 180 seconds');
  if (rules.length) return {state:'AT_RISK',rules};
  if ((input.retryQueue ?? 0) > 0) rules.push('pending retry recovery');
  if (input.restAtPageLimit) rules.push('REST page at configured limit; completeness unproven; matched overlap alone is insufficient');
  if (input.restCompletenessUnproven) rules.push('REST pagination completeness unproven');
  if ((input.unresolvedQuarantine ?? 0) > 0) rules.push('unresolved quarantine exists');
  if (rules.length) return {state:'DEGRADED',rules};
  if (!input.lastProgressUtc) return {state:'UNKNOWN',rules:['no source progress timestamp']};
  return {state:'GREEN',rules:[]};
}
