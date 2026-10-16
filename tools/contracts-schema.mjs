// SPDX-License-Identifier: Apache-2.0
const METHODS=['get','post','put','patch','delete'];
const TYPES=['object','array','string','number','integer','boolean'];
const BODY='application/json';
const FORMAT_RE={'date-time':'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[^ ]*$','date':'^[0-9]{4}-[0-9]{2}-[0-9]{2}$','email':'^[^@ ]+@[^@ ]+[.][^@ ]+$','uuid':'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'};
const cap=s=>s.charAt(0).toUpperCase()+s.slice(1);
export function resolveRef(doc,ref){
if(typeof ref!=='string'||!ref.startsWith('#/'))throw new Error('unsupported ref: '+ref);
let cur=doc;
for(const part of ref.slice(2).split('/')){const key=part.replace(/~1/g,'/').replace(/~0/g,'~');
if(cur===null||typeof cur!=='object'||!(key in cur))throw new Error('unresolved $ref: '+ref);cur=cur[key];}
return cur;}
export function schemaNames(doc){return Object.keys(doc?.components?.schemas??{});}
export function operationsOf(doc){
const ops=[];
for(const[path,item]of Object.entries(doc?.paths??{}))
for(const method of METHODS){const op=item?.[method];if(!op)continue;
const params=[...(item.parameters??[]),...(op.parameters??[])].map(p=>p?.$ref?resolveRef(doc,p.$ref):p).filter(p=>p&&(p.in==='path'||p.in==='query'));
const code=Object.keys(op.responses??{}).find(c=>c.charAt(0)==='2');
ops.push({method,path,operationId:op.operationId,parameters:params,requestSchema:op.requestBody?.content?.[BODY]?.schema,responseSchema:code?op.responses[code]?.content?.[BODY]?.schema:undefined,status:code?Number(code):null});}
return ops;}
export function validateOpenApi(doc){
const errors=[];const ids=new Set();
const check=(s,where)=>{
if(!s||typeof s!=='object')return;
if(s.$ref){try{resolveRef(doc,s.$ref)}catch(e){errors.push(where+': '+e.message)}return;}
if(s.type!==undefined&&!TYPES.includes(s.type))errors.push(where+': unsupported type '+s.type);
for(const[k,v]of Object.entries(s.properties||{}))check(v,where+'.'+k);
if(s.items)check(s.items,where+'[]');};
for(const[path,item]of Object.entries(doc?.paths??{}))
for(const m of METHODS){const op=item?.[m];if(!op)continue;const where=m.toUpperCase()+' '+path;
if(!op.operationId)errors.push(where+': missing operationId');
else if(ids.has(op.operationId))errors.push(where+': duplicate operationId '+op.operationId);
else ids.add(op.operationId);
for(const p of op.parameters??[])check(p?.$ref?{$ref:p.$ref}:p?.schema,where+' parameter '+(p?.name??p?.$ref));
check(op.requestBody?.content?.[BODY]?.schema,where+' request');
for(const[code,r]of Object.entries(op.responses??{}))check(r?.content?.[BODY]?.schema,where+' response '+code);}
for(const n of schemaNames(doc))check(doc.components.schemas[n],'schema '+n);
return{ok:errors.length===0,errors};}
function tsType(s){
if(!s)return 'unknown';
if(s.$ref)return s.$ref.split('/').pop();
if(s.enum)return s.enum.map(v=>JSON.stringify(v)).join(' | ');
switch(s.type){
case 'string':return 'string';
case 'number':case 'integer':return 'number';
case 'boolean':return 'boolean';
case 'array':return '('+tsType(s.items)+')[]';
case 'object':{if(!s.properties)return 'Record<string, unknown>';const req=s.required||[];
return '{ '+Object.entries(s.properties).map(([k,v])=>JSON.stringify(k)+(req.includes(k)?'':'?')+': '+tsType(v)).join('; ')+' }';}
default:return 'unknown';}}
export function generateTypes(doc){
const out=['// Generated from the OpenAPI document. Do not edit.'];
for(const n of schemaNames(doc))out.push('export type '+n+' = '+tsType(doc.components.schemas[n])+';');
for(const op of operationsOf(doc)){const id=cap(op.operationId);
out.push('export type '+id+'Request = '+(op.requestSchema?tsType(op.requestSchema):'undefined')+';');
out.push('export type '+id+'Response = '+(op.responseSchema?tsType(op.responseSchema):'undefined')+';');}
return out.join('\n')+'\n';}
function rng(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
export function generateSeed(doc,{seed=1,count=5}={}){
const r=rng(seed),S=doc?.components?.schemas??{};
const hex=n=>Array.from({length:n},()=>Math.floor(r()*16).toString(16)).join('');
const str=(s,label)=>{const n=Math.floor(r()*1000);let v;
if(s.format==='uuid'){const h=hex(32);v=h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}
else if(s.format==='date-time')v=new Date(Date.UTC(2024,0,1)+Math.floor(r()*365)*86400000).toISOString();
else if(s.format==='date')v=new Date(Date.UTC(2024,0,1)+Math.floor(r()*365)*86400000).toISOString().slice(0,10);
else if(s.format==='email')v='user'+n+'@example.com';
else v=label+'-'+n;
if(s.maxLength!==undefined)v=v.slice(0,s.maxLength);
if(s.minLength!==undefined&&v.length<s.minLength)v=v.padEnd(s.minLength,'x');
return v;};
const gen=(s,label,depth)=>{
if(!s||depth>4)return null;
if(s.$ref)return gen(resolveRef(doc,s.$ref),s.$ref.split('/').pop(),depth+1);
if(s.enum)return s.enum[Math.floor(r()*s.enum.length)];
switch(s.type){
case 'object':{const o={};for(const[k,ps]of Object.entries(s.properties||{}))o[k]=gen(ps,k,depth+1);return o;}
case 'array':return Array.from({length:1+Math.floor(r()*2)},()=>gen(s.items,label,depth+1));
case 'string':return str(s,label);
case 'integer':{const lo=Math.ceil(s.minimum??0),hi=Math.floor(s.maximum??lo+1000);return lo+Math.floor(r()*(hi-lo+1));}
case 'number':{const lo=s.minimum??0,hi=s.maximum??lo+1000;return Math.min(hi,Math.max(lo,Math.round((lo+r()*(hi-lo))*100)/100));}
case 'boolean':return r()<0.5;
default:return null;}};
const out={};
for(const n of Object.keys(S))out[n]=Array.from({length:count},()=>gen(S[n],n,0));
return out;}
function makeChecker(S,FMT){
const F={};for(const k of Object.keys(FMT))F[k]=new RegExp(FMT[k]);
const chk=(v,s,p,e)=>{
if(!s)return;
if(s.$ref)return chk(v,S[s.$ref.split('/').pop()],p,e);
if(s.enum&&!s.enum.includes(v)){e.push(p+' must be one of '+s.enum.join(', '));return;}
const t=s.type;
if(t==='object'){
if(v===null||typeof v!=='object'||Array.isArray(v)){e.push(p+' must be an object');return;}
for(const k of s.required||[])if(!(k in v))e.push(p+'.'+k+' is required');
for(const k of Object.keys(s.properties||{}))if(k in v)chk(v[k],s.properties[k],p+'.'+k,e);}
else if(t==='array'){
if(!Array.isArray(v)){e.push(p+' must be an array');return;}
v.forEach((x,i)=>chk(x,s.items,p+'['+i+']',e));}
else if(t==='string'){
if(typeof v!=='string'){e.push(p+' must be a string');return;}
if(s.minLength!==undefined&&v.length<s.minLength)e.push(p+' is shorter than '+s.minLength);
if(s.maxLength!==undefined&&v.length>s.maxLength)e.push(p+' is longer than '+s.maxLength);
if(F[s.format]&&!F[s.format].test(v))e.push(p+' must be a '+s.format);}
else if(t==='number'||t==='integer'){
if(typeof v!=='number'||!Number.isFinite(v)){e.push(p+' must be a number');return;}
if(t==='integer'&&!Number.isInteger(v))e.push(p+' must be an integer');
if(s.minimum!==undefined&&v<s.minimum)e.push(p+' must be at least '+s.minimum);
if(s.maximum!==undefined&&v>s.maximum)e.push(p+' must be at most '+s.maximum);}
else if(t==='boolean'&&typeof v!=='boolean')e.push(p+' must be a boolean');};
return(n,v)=>{const e=[];chk(v,S[n],'value',e);return{ok:e.length===0,errors:e};};}
export function generateValidators(doc){
const S=doc?.components?.schemas??{},names=Object.keys(S);
return ['// Generated validators. Do not edit.','const S='+JSON.stringify(S)+';','const FMT='+JSON.stringify(FORMAT_RE)+';','const run=('+makeChecker.toString()+')(S,FMT);','export const validators={'+names.map(n=>JSON.stringify(n)+':v=>run('+JSON.stringify(n)+',v)').join(',')+'};'].concat(names.map(n=>'export const validate'+n+'=validators['+JSON.stringify(n)+'];')).join('\n')+'\n';}
