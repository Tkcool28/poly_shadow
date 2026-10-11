/** Deterministic operational evidence-quality reduction, deliberately separate
 * from process liveness and frozen comparator/scientific performance rules. */
export type DataQualityState = 'GREEN' | 'DEGRADED' | 'AT_RISK' | 'UNKNOWN';
export interface DataQualityInput {
  recoveryRequired?: boolean; retryQueue?: number; indexInvalid?: boolean; racingIndexInvalid?: boolean;
  lastProgressUtc?: string | null; sourceProgressUtc?: Record<string, string | null>;
  restAtPageLimit?: boolean; restCompletenessUnproven?: boolean; unresolvedQuarantine?: number | null; nowUtc?: string;
  operationalSinkBroken?: boolean; unresolvedRpc?: number;
}
export function dataQuality(input: DataQualityInput): { state: DataQualityState; rules: string[] } {
  const now = Date.parse(input.nowUtc ?? new Date().toISOString());
  const progress = input.lastProgressUtc ? Date.parse(input.lastProgressUtc) : NaN;
  const stale = Number.isFinite(progress) && now-progress>180_000;
  const rules: string[] = [];
  for(const [source,stamp] of Object.entries(input.sourceProgressUtc??{})){const t=stamp?Date.parse(stamp):NaN;if(Number.isFinite(t)&&now-t>180000)rules.push(source+' progress stale > 180 seconds');}
  if (input.operationalSinkBroken) rules.push('EVIDENCE_SINK_FAILURE');
  if (input.indexInvalid || input.racingIndexInvalid) rules.push('evidence index invalid');
  if (input.recoveryRequired) rules.push('unresolved chain recovery proof');
  if ((input.unresolvedQuarantine ?? 0) >= 10) rules.push('unresolved quarantine count >= 10');
  if ((input.unresolvedRpc ?? 0) >= 10) rules.push('unresolved RPC count >= 10');
  if (stale) rules.push('observer progress stale > 180 seconds');
  if (rules.length) return {state:'AT_RISK',rules};
  if ((input.retryQueue ?? 0) > 0) rules.push('pending retry recovery');
  if (input.restAtPageLimit) rules.push('REST page at configured limit; completeness unproven; matched overlap alone is insufficient');
  if (input.restCompletenessUnproven) rules.push('REST pagination completeness unproven');
  if ((input.unresolvedRpc ?? 0) > 0) rules.push('unresolved RPC exists');
  if ((input.unresolvedQuarantine ?? 0) > 0) rules.push('unresolved quarantine exists');
  if (rules.length) return {state:'DEGRADED',rules};
  if (!Number.isFinite(progress)||progress>now||!Number.isFinite(now)) return {state:'UNKNOWN',rules:['no valid source progress timestamp']};
  return {state:'GREEN',rules:[]};
}
