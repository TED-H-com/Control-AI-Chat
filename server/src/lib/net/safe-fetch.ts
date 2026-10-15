import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import { PRODUCT_NAME } from '../../shared/brand.js';
import { APP_VERSION } from '../../version.js';

export class SafeFetchError extends Error {
  constructor(public readonly code:string,message=code,public readonly status?:number){super(message);this.name='SafeFetchError';}
}

const blocked=new net.BlockList();
for(const [network,prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],
  ['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],
  ['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4],['255.255.255.255',32],
] as const)blocked.addSubnet(network,prefix,'ipv4');
for(const [network,prefix] of [['::1',128],['::',128],['64:ff9b::',96],['64:ff9b:1::',48],['100::',64],['2001:db8::',32],['fc00::',7],['fec0::',10],['fe80::',10],['ff00::',8]] as const)
  blocked.addSubnet(network,prefix,'ipv6');

function mappedIpv4(address:string):string|null{
  const lower=address.toLowerCase().split('%',1)[0]!;
  const dotted=/^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(lower)?.[1];
  if(dotted&&net.isIP(dotted)===4)return dotted;
  const sides=lower.split('::');if(sides.length>2)return null;
  const left=sides[0]?sides[0].split(':'):[],right=sides[1]?sides[1].split(':'):[];
  const fill=sides.length===2?Array(Math.max(0,8-left.length-right.length)).fill('0') as string[]:[];
  const words=[...left,...fill,...right];
  if(words.length!==8||!words.every(word=>/^[0-9a-f]{1,4}$/u.test(word))||words.slice(0,5).some(word=>Number.parseInt(word,16)!==0)||Number.parseInt(words[5]!,16)!==0xffff)return null;
  const value=(Number.parseInt(words[6]!,16)*65536+Number.parseInt(words[7]!,16))>>>0;
  return `${value>>>24}.${value>>>16&255}.${value>>>8&255}.${value&255}`;
}

function sixToFourIpv4(address:string):string|null{
  const lower=address.toLowerCase().split('%',1)[0]!,sides=lower.split('::');if(sides.length>2)return null;
  const left=sides[0]?sides[0].split(':'):[],right=sides[1]?sides[1].split(':'):[],fill=sides.length===2?Array(Math.max(0,8-left.length-right.length)).fill('0') as string[]:[];
  const words=[...left,...fill,...right];if(words.length!==8||!words.every(word=>/^[0-9a-f]{1,4}$/u.test(word))||Number.parseInt(words[0]!,16)!==0x2002)return null;
  const value=(Number.parseInt(words[1]!,16)*65536+Number.parseInt(words[2]!,16))>>>0;
  return`${value>>>24}.${value>>>16&255}.${value>>>8&255}.${value&255}`;
}

export function isBlockedIp(address:string):boolean{
  const family=net.isIP(address);
  if(family===4)return blocked.check(address,'ipv4');
  if(family===6){const embedded=mappedIpv4(address)??sixToFourIpv4(address);return embedded!==null?blocked.check(embedded,'ipv4'):blocked.check(address.split('%',1)[0]!,'ipv6');}
  return true;
}

/** Pin both the legacy single-address and modern `all:true` lookup shapes to the checked IP. */
export function pinnedLookup(address:string):net.LookupFunction {
  const family=net.isIP(address);
  return (_hostname,options,callback)=>{
    if(options.all)callback(null,[{address,family}]);
    else callback(null,address,family);
  };
}

function decodeEntities(text:string):string{return text
  .replace(/&(amp|lt|gt|quot|#39|nbsp);/giu,match=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'",'&nbsp;':' '}[match.toLowerCase()]??match))
  .replace(/&#(\d+);/gu,(match,digits:string)=>{const point=Number(digits);return Number.isInteger(point)&&point>=0&&point<=0x10ffff?String.fromCodePoint(point):match;});}

function normalizeText(text:string):string{return decodeEntities(text).replace(/\r\n?/gu,'\n').replace(/[\t\f\v ]+/gu,' ').replace(/ *\n */gu,'\n').replace(/\n{3,}/gu,'\n\n').trim().slice(0,12_000);}

export function stripHtml(html:string):string{return normalizeText(html
  .replace(/<!--[^]*?-->/gu,' ')
  .replace(/<(script|style|svg)\b[^>]*>[^]*?<\/\1\s*>/giu,' ')
  .replace(/<[^>]*>/gu,' '));}

interface Options {maxBytes?:number;timeoutMs?:number;maxRedirects?:number}

function checkedUrl(raw:string):URL{
  let url:URL;try{url=new URL(raw);}catch{throw new SafeFetchError('host_forbidden');}
  if(url.protocol!=='http:'&&url.protocol!=='https:')throw new SafeFetchError('scheme_forbidden');
  if(url.username||url.password)throw new SafeFetchError('credentials_forbidden');
  if(!url.hostname||url.hostname.toLowerCase().endsWith('.local'))throw new SafeFetchError('host_forbidden');
  if(url.port&&url.port!=='80'&&url.port!=='443')throw new SafeFetchError('port_forbidden');
  return url;
}

export function validateProviderBaseUrl(raw:string):string{
  const url=checkedUrl(raw.trim());
  if(url.protocol!=='https:')throw new SafeFetchError('scheme_forbidden');
  const host=url.hostname.replace(/^\[/u,'').replace(/\]$/u,'');
  if(net.isIP(host)&&isBlockedIp(host))throw new SafeFetchError('private_address');
  return url.toString().replace(/\/$/u,'');
}

/** HTTPS request with DNS pinning for administrator-controlled provider endpoints. */
export async function safeProviderFetch(raw:string,init:RequestInit):Promise<Response>{
  const url=new URL(validateProviderBaseUrl(raw)),host=url.hostname.replace(/^\[/u,'').replace(/\]$/u,'');
  if(new Set(['api.openai.com','api.anthropic.com','generativelanguage.googleapis.com','api.x.ai','openrouter.ai','api.venice.ai','integrate.api.nvidia.com']).has(host.toLowerCase()))return fetch(raw,init);
  let addresses;try{addresses=await dns.lookup(host,{all:true,verbatim:true});}catch{throw new SafeFetchError('dns_error');}
  if(!addresses.length||addresses.some(item=>isBlockedIp(item.address)))throw new SafeFetchError('private_address');
  const pinnedIp=addresses[0]!.address;
  return new Promise((resolve,reject)=>{
    const headers=Object.fromEntries(new Headers(init.headers).entries());
    const req=https.request(url,{method:init.method??'GET',headers,signal:init.signal??undefined,lookup:pinnedLookup(pinnedIp)},incoming=>{
      const responseHeaders=new Headers();for(const [name,value] of Object.entries(incoming.headers)){if(Array.isArray(value))for(const item of value)responseHeaders.append(name,item);else if(value!==undefined)responseHeaders.set(name,value);}
      resolve(new Response(Readable.toWeb(incoming) as ReadableStream,{status:incoming.statusCode??500,statusText:incoming.statusMessage??'',headers:responseHeaders}));
    });
    req.on('error',reject);if(init.body!==undefined&&init.body!==null){if(typeof init.body!=='string'&&!Buffer.isBuffer(init.body))return reject(new TypeError('Provider request body must be a string or Buffer'));req.write(init.body);}req.end();
  });
}

async function requestOnce(url:URL,pinnedIp:string,opts:Required<Options>,signal:AbortSignal):Promise<{status:number;headers:http.IncomingHttpHeaders;body:string}>{
  const transport=url.protocol==='https:'?https:http;
  return new Promise((resolve,reject)=>{
    const req=transport.request(url,{method:'GET',signal,lookup:pinnedLookup(pinnedIp),headers:{'User-Agent':`Mozilla/5.0 (compatible; ${PRODUCT_NAME}/${APP_VERSION})`,'Accept':'text/html,text/plain'}},response=>{
      const chunks:Buffer[]=[];let size=0,settled=false;
      response.on('data',(chunk:Buffer|string)=>{const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>opts.maxBytes){settled=true;response.destroy();req.destroy();reject(new SafeFetchError('too_large'));return;}chunks.push(bytes);});
      response.on('end',()=>{if(!settled)resolve({status:response.statusCode??0,headers:response.headers,body:Buffer.concat(chunks).toString('utf8')});});
      response.on('error',error=>{if(!settled)reject(error);});
    });
    req.setTimeout(opts.timeoutMs,()=>req.destroy(new SafeFetchError('timeout')));
    req.on('error',reject);req.end();
  });
}

async function fetchHop(raw:string,opts:Required<Options>,redirectsLeft:number):Promise<{finalUrl:string;contentType:string;text:string}>{
  const url=checkedUrl(raw);
  const host=url.hostname.replace(/^\[/u,'').replace(/\]$/u,'');
  let addresses;try{addresses=await dns.lookup(host,{all:true,verbatim:true});}catch{throw new SafeFetchError('dns_error');}
  if(!addresses.length||addresses.some(item=>isBlockedIp(item.address)))throw new SafeFetchError('private_address');
  const pinnedIp=addresses[0]!.address,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),opts.timeoutMs);
  try{
    const response=await requestOnce(url,pinnedIp,opts,controller.signal);
    if(response.status>=300&&response.status<400&&response.headers.location){
      if(redirectsLeft===0)throw new SafeFetchError('too_many_redirects');
      return fetchHop(new URL(response.headers.location,url).toString(),opts,redirectsLeft-1);
    }
    if(response.status>=400)throw new SafeFetchError('http_error','http_error',response.status);
    const contentType=String(response.headers['content-type']??'').toLowerCase();
    if(!['text/html','text/plain','application/xhtml+xml'].some(type=>contentType.startsWith(type)))throw new SafeFetchError('content_type');
    return{finalUrl:url.toString(),contentType,text:contentType.startsWith('text/plain')?normalizeText(response.body):stripHtml(response.body)};
  }catch(error){if(controller.signal.aborted&&!(error instanceof SafeFetchError))throw new SafeFetchError('timeout');throw error;}finally{clearTimeout(timer);}
}

export async function safeFetchText(url:string,opts:Options={}):Promise<{finalUrl:string;contentType:string;text:string}>{
  const resolved={maxBytes:opts.maxBytes??2_000_000,timeoutMs:opts.timeoutMs??8_000,maxRedirects:opts.maxRedirects??3};
  return fetchHop(url,resolved,resolved.maxRedirects);
}
