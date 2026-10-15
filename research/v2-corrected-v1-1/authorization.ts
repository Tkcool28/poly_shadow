/** Execution plumbing only. Public request semantics remain the merged adapter. */
export const CAMPAIGN='POLY_SHADOW_CORRECTED_V2_EVIDENCE_CAMPAIGN_V1_1';
export const LABEL='authorize-v2-evidence-v1-1';
export const BRANCH='test/corrected-v2-evidence-campaign-v1-1';
export const BASE='1f911ad00d2e98bfd553a0de7dd101746221e531';
export const OUTPUT='research/v2-corrected-v1-1/evidence';
export function authorize(env:NodeJS.ProcessEnv){
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_EVENT_NAME!=='pull_request'||env.GITHUB_EVENT_ACTION!=='labeled'||env.GITHUB_RUN_ATTEMPT!=='1'||env.CAMPAIGN_LABEL!==LABEL||env.CAMPAIGN_ID!==CAMPAIGN||env.GITHUB_HEAD_REF!==BRANCH||env.CAMPAIGN_BASE_SHA!==BASE)throw Error('EXPLICIT_CORRECTED_CAMPAIGN_ONLY');
 return OUTPUT;
}
