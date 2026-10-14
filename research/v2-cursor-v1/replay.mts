import {analyze} from './replay.js';
console.log(JSON.stringify(analyze(process.argv[2]??'research/v2-cursor-v1/evidence',true),null,2));
