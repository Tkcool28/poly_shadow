import { afterEach, expect, it, vi } from 'vitest';
import { restGet, REST_MAX_BODY_BYTES } from '../src/shadow/egress.js';
afterEach(()=>vi.unstubAllGlobals());
it('bounded transport retains HTTP and cache metadata on malformed JSON',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{bad',{status:200,headers:{age:'3',etag:'tag','cache-control':'max-age=5',date:'date'}})));
 const res=await restGet('https://data-api.polymarket.com/trades');expect(res).toMatchObject({status:200,body:null,headers:{age:'3',etag:'tag',cacheControl:'max-age=5',date:'date'}});expect(res.parseError).toContain('malformed REST JSON');
});
it('transport cancels oversized body before JSON parsing and retains failure HTTP status',async()=>{
 let sent=0,cancelled=false;const stream=new ReadableStream<Uint8Array>({pull(c){sent++;c.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}});
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(stream,{status:503})));
 const res=await restGet('https://data-api.polymarket.com/activity');expect(res).toMatchObject({status:503,body:null});expect(res.parseError).toContain('byte limit');expect(cancelled).toBe(true);expect(sent).toBeLessThanOrEqual(REST_MAX_BODY_BYTES/(1024*1024)+2);
});
it('valid bounded JSON is decoded without changing the payload',async()=>{
 const body=[{timestamp:1,asset:'a'}];vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(body))));expect((await restGet('https://data-api.polymarket.com/trades')).body).toEqual(body);
});
it('body-read timeout remains a timeout, never parse-null empty success',async()=>{
 const error=new DOMException('timeout','TimeoutError');const stream=new ReadableStream({start(c){c.error(error);}});vi.stubGlobal('fetch',vi.fn(async()=>new Response(stream)));
 const res=await restGet('https://data-api.polymarket.com/trades');expect(res).toMatchObject({status:200,body:null,bodyError:{outcome:'TIMEOUT',message:String(error)}});
});
