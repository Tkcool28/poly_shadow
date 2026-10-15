import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {audit} from './audit.js';
const dir=process.argv[2]??'research/v2-corrected-v1-1/evidence',out=process.argv[3]??'research/v2-corrected-v1-1/audit-output';
const d=resolve(dir),o=resolve(out);if(!relative(d,o).startsWith('..')||!relative(o,d).startsWith('..'))throw Error('AUDIT_OUTPUT_OVERLAPS_EVIDENCE');
const a=audit(dir);mkdirSync(out,{recursive:true});writeFileSync(join(out,'audit.json'),JSON.stringify(a.result,null,2)+'\n');writeFileSync(join(out,'timing.ndjson'),a.timings.map(r=>JSON.stringify(r)).join('\n')+'\n');console.log(JSON.stringify(a.result,null,2));
