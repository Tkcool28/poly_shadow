/** One bounded diagnostic invocation, called by the existing status publisher. No loop. */
import {LiveMonitor,unavailable} from './live-monitor.js';
import {boundedJson} from './stage1-approval.js';
const [, ,configPath,cacheDirectory,now,mode]=process.argv;
let monitor:LiveMonitor|undefined;
try{
 if(!configPath||!cacheDirectory)throw Error('Explicit monitor configuration/private cache required');
 monitor=new LiveMonitor(boundedJson(configPath),cacheDirectory);
 const value=JSON.stringify(monitor.refresh(now,mode==='--checkpoint'));console.log(Buffer.byteLength(value)<=131072?value:JSON.stringify(unavailable('MONITOR_OUTPUT_BOUND')));
}catch(error){console.log(JSON.stringify({...unavailable(),error:String(error).slice(0,200)}));process.exitCode=2;}
finally{monitor?.close();}
