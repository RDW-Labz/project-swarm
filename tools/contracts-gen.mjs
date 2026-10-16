// SPDX-License-Identifier: Apache-2.0
import{resolveRef,operationsOf,schemaNames,generateValidators,generateSeed,generateTypes,validateOpenApi}from'./contracts-schema.mjs';
const refName=s=>s&&s.$ref?String(s.$ref).split('/').pop():null;
const esc=s=>s.replace(/[.*+?^${}()|[\]\\\/]/g,'\\$&');
const hasId=(doc,s)=>{try{const r=s&&s.$ref?resolveRef(doc,s.$ref):s;return!!(r&&r.properties&&'id' in r.properties);}catch{return false;}};
function routesOf(doc){return operationsOf(doc).map(op=>{const chunks=op.path.split('{');let re='^'+esc(chunks[0]);const names=[];for(const c of chunks.slice(1)){const k=c.indexOf('}');names.push(c.slice(0,k));re+='([^/]+)'+esc(c.slice(k+1));}re+='/?$';const res=op.responseSchema,arr=res&&res.type==='array',m=op.method;const kind=m==='delete'?'delete':m==='get'?(names.length?'item':arr?'list':'first'):'write';return{method:m,re,names,kind,data:refName(arr?res.items:res),req:refName(op.requestSchema),status:m==='delete'?204:(op.status??200),id:hasId(doc,arr?res.items:res)};});}
const CLIENT_RT=`export function createClient({baseUrl,fetchImpl=fetch}={}){
let base=String(baseUrl);while(base.endsWith('/'))base=base.slice(0,-1);
const call=id=>async({path={},query,body}={})=>{
const op=OPS[id];
const p=op.path.split('/').map(seg=>{if(seg[0]!=='{'||seg.at(-1)!=='}')return seg;const k=seg.slice(1,-1);if(path[k]===undefined)throw new Error('missing path parameter '+k);return encodeURIComponent(String(path[k]));}).join('/');
const qs=new URLSearchParams();
for(const[k,v]of Object.entries(query||{}))if(v!==undefined&&v!==null)qs.set(k,String(v));
const q=qs.toString();
const init={method:op.method,headers:{accept:'application/json'}};
if(body!==undefined){init.body=JSON.stringify(body);init.headers['content-type']='application/json';}
const res=await fetchImpl(base+p+(q?'?'+q:''),init);
const text=await res.text();
let out=text;try{out=text?JSON.parse(text):undefined;}catch{}
return{status:res.status,body:out};};
const api={};for(const id of Object.keys(OPS))api[id]=call(id);
return api;}
`;
export function generateClient(doc){
const ops=Object.fromEntries(operationsOf(doc).map(o=>[o.operationId,{method:o.method.toUpperCase(),path:o.path}]));
return['// Generated client. Do not edit.','const OPS='+JSON.stringify(ops)+';',CLIENT_RT].join('\n')+'\n';}
const MOCK_IMPORTS=`import{createServer}from'node:http';
import{validators as VAL}from'./validators.mjs';
`;
const MOCK_RT=`const send=(res,code,obj)=>{const b=obj===undefined?'':JSON.stringify(obj);res.writeHead(code,b?{'content-type':'application/json'}:{});res.end(b);};
const readBody=req=>new Promise((ok,bad)=>{let d='';req.setEncoding('utf8');req.on('data',c=>{d+=c;if(d.length>1e6){bad(new Error('body too large'));req.destroy();}});req.on('end',()=>ok(d));req.on('error',bad);});
const rows=n=>(n&&SEED[n])||[];
const RX=ROUTES.map(r=>new RegExp(r.re));
export function createMockServer({port=0}={}){
const server=createServer(async(req,res)=>{
try{
const path=new URL(req.url,'http://localhost').pathname;
let hit=null,params={};
for(let i=0;i<ROUTES.length&&!hit;i++){const r=ROUTES[i];if(r.method!==req.method.toLowerCase())continue;const m=path.match(RX[i]);if(m){hit=r;m.slice(1).forEach((v,j)=>{params[r.names[j]]=decodeURIComponent(v);});}}
if(!hit)return send(res,404,{error:'not found'});
if(hit.kind==='delete')return send(res,204);
if(hit.kind==='write'){
const raw=await readBody(req);let body;
try{body=raw?JSON.parse(raw):undefined;}catch{return send(res,400,{errors:['body is not valid JSON']});}
if(hit.req&&VAL[hit.req]){const v=VAL[hit.req](body);if(!v.ok)return send(res,400,{errors:v.errors});}
if(hit.status===204)return send(res,204);
let out=body;
if(hit.id&&out&&typeof out==='object'&&!Array.isArray(out))out={...out,id:out.id??params[hit.names.at(-1)]??globalThis.crypto.randomUUID()};
return send(res,hit.status,out);}
const key=hit.names.at(-1);
if(hit.kind==='item'){const r=rows(hit.data).find(x=>String(x[key])===params[key]);return r?send(res,hit.status,r):send(res,404,{error:'not found'});}
if(hit.kind==='list')return send(res,hit.status,rows(hit.data));
return send(res,hit.status,rows(hit.data)[0]??{});
}catch(e){send(res,500,{error:String(e&&e.message)});}
});
return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{const url='http://127.0.0.1:'+server.address().port;resolve({server,url,close:()=>new Promise(r=>{server.closeAllConnections?.();server.close(()=>r());})});});});
}
`;
export function generateMockServer(doc,{seedData={}}={}){
return['// Generated mock server. Do not edit.',MOCK_IMPORTS,'const SEED='+JSON.stringify(seedData)+';','const ROUTES='+JSON.stringify(routesOf(doc))+';',MOCK_RT].join('\n')+'\n';}
const TEST_IMPORTS=`import{test}from'node:test';
import assert from'node:assert/strict';
import{createClient}from'./client.mjs';
import{validators}from'./validators.mjs';
`;
const TEST_RT=`const BASE=process.env.CONTRACT_BASE_URL;
const client=BASE?createClient({baseUrl:BASE}):null;
for(const c of CASES){
test(c.id,{skip:!BASE},async()=>{
const r=await client[c.id]({path:c.path,query:c.query,body:c.body});
assert.equal(r.status,c.status);
if(c.check&&r.status!==204){const items=c.array?r.body:[r.body];assert.ok(Array.isArray(items),'expected an array');for(const it of items){const v=validators[c.check](it);assert.ok(v.ok,c.id+': '+v.errors.join('; '));}}
});
}
`;
export function generateContractTests(doc){
const seed=generateSeed(doc,{seed:1,count:1});const known=new Set(schemaNames(doc));
const cases=operationsOf(doc).map(op=>{
const res=op.responseSchema,arr=res&&res.type==='array';
const check=refName(arr?res.items:res);
const row=((check&&seed[check])||[])[0]||{};
const path={};for(const p of op.parameters)if(p.in==='path')path[p.name]=row[p.name]??'sample';
const query={};for(const p of op.parameters)if(p.in==='query'&&p.required)query[p.name]=(p.schema&&(p.schema.type==='integer'||p.schema.type==='number'))?1:'sample';
const reqName=refName(op.requestSchema);
const body=reqName?(seed[reqName]||[])[0]:undefined;
return{id:op.operationId,method:op.method,path,query,body,status:op.method==='delete'?204:(op.status??200),check:known.has(check)?check:null,array:!!arr};});
return['// Generated contract tests. Do not edit.',TEST_IMPORTS,'const CASES='+JSON.stringify(cases)+';',TEST_RT].join('\n')+'\n';}
export function contractFiles(doc,options={}){
const v=validateOpenApi(doc);if(!v.ok)throw new Error('invalid OpenAPI document: '+v.errors.join('; '));
const seedData=generateSeed(doc,{seed:options.seed??1,count:options.count??5});
return{'contracts/types.d.ts':generateTypes(doc),'contracts/validators.mjs':generateValidators(doc),'contracts/client.mjs':generateClient(doc),'contracts/mock-server.mjs':generateMockServer(doc,{seedData}),'contracts/seed.json':JSON.stringify(seedData,null,2)+'\n','contracts/contract.test.mjs':generateContractTests(doc)};}
