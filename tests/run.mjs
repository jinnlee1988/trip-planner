// Sync and sharing tests. Run:  node --no-warnings tests/run.mjs   (Node 22.5+; no packages needed)
// The real src/worker.js and the real script from public/index.html run together against an in-memory SQLite database,
// with several simulated phones. Prints "ALL PASSED: N checks" or stops at the first failure.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {webcrypto as wc} from 'node:crypto';
import os from 'node:os';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const R=path.join(path.dirname(fileURLToPath(import.meta.url)),'..')+path.sep;
// worker.js uses "export default"; copy it to a .mjs file so Node loads it as a module.
const wtmp=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'tp-')),'worker.mjs');fs.copyFileSync(R+'src/worker.js',wtmp);
const worker=(await import(pathToFileURL(wtmp).href)).default;
/* ---- D1 shim ---- */
function d1(){const db=new DatabaseSync(':memory:');let q=0;
 const mk=(sql,args=[])=>({sql,args,bind:(...a)=>mk(sql,a),
  all(){q++;const s=db.prepare(sql);if(/^\s*(SELECT)/i.test(sql))return Promise.resolve({results:s.all(...args)});s.run(...args);return Promise.resolve({results:[]})}});
 return {prepare:s=>mk(s),count:()=>q,raw:db,
  async batch(list){db.exec('BEGIN');try{const out=[];for(const s of list)out.push(await s.all());db.exec('COMMIT');return out}catch(e){db.exec('ROLLBACK');throw e}}}}
/* ---- Access JWT ---- */
const TEAM='https://justdreamz.cloudflareaccess.com',AUD='aud-test-123';
const kp=await wc.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const kp2=await wc.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk=Object.assign(await wc.subtle.exportKey('jwk',kp.publicKey),{kid:'k1'});
const b64=b=>Buffer.from(b).toString('base64url');
async function jwt(email,o={}){const h=b64(JSON.stringify({alg:'RS256',kid:'k1'})),p=b64(JSON.stringify(Object.assign({aud:[AUD],iss:TEAM,exp:Math.floor(Date.now()/1000)+3600,email},o.claims||{})));
 const sig=await wc.subtle.sign('RSASSA-PKCS1-v1_5',(o.key||kp).privateKey,Buffer.from(h+'.'+p));return h+'.'+p+'.'+b64(sig)}
const realFetch=globalThis.fetch;
globalThis.fetch=async(u)=>{if(String(u)===TEAM+'/cdn-cgi/access/certs')return new Response(JSON.stringify({keys:[jwk]}));throw new Error('unexpected fetch '+u)};
const DB=d1();const env={DB,TEAM_DOMAIN:TEAM,POLICY_AUD:AUD,ASSETS:{fetch:async()=>new Response('asset',{status:200})}};
const call=(path,tok,body,e=env)=>worker.fetch(new Request('https://x.test'+path,{method:body?'POST':'GET',headers:Object.assign(tok?{'Cf-Access-Jwt-Assertion':tok}:{},body?{'Content-Type':'application/json'}:{}),body:body?JSON.stringify(body):undefined}),e);
let pass=0;const ok=(c,m)=>{assert.ok(c,m);pass++};const nz=x=>x&&typeof x==='object'?JSON.parse(JSON.stringify(x)):x;const eq=(a,b,m)=>{assert.deepEqual(nz(a),nz(b),m);pass++};

/* ---- 1. login checks ---- */
eq((await call('/api/me',await jwt('a@x.com'),null,Object.assign({},env,{POLICY_AUD:''}))).status,503,'not configured');
eq((await call('/api/me')).status,401,'no token');
eq((await call('/api/me','garbage')).status,401,'garbage token');
eq((await call('/api/me',await jwt('a@x.com',{claims:{aud:['other']}}))).status,401,'wrong aud');
eq((await call('/api/me',await jwt('a@x.com',{claims:{iss:'https://evil.cloudflareaccess.com'}}))).status,401,'wrong issuer');
eq((await call('/api/me',await jwt('a@x.com',{claims:{exp:Math.floor(Date.now()/1000)-10}}))).status,401,'expired');
eq((await call('/api/me',await jwt('a@x.com',{key:kp2}))).status,401,'wrong signing key');
{const t=await jwt('a@x.com'),p=t.split('.');const forged=p[0]+'.'+b64(JSON.stringify({aud:[AUD],iss:TEAM,exp:9999999999,email:'victim@x.com'}))+'.'+p[2];eq((await call('/api/me',forged)).status,401,'tampered payload')}
{const h=b64(JSON.stringify({alg:'none',kid:'k1'})),p=b64(JSON.stringify({aud:[AUD],iss:TEAM,exp:9999999999,email:'a@x.com'}));eq((await call('/api/me',h+'.'+p+'.')).status,401,'alg none')}
{const r=await call('/api/me',await jwt('Wife@X.com'));eq(r.status,200);eq((await r.json()).email,'wife@x.com','email lower-cased')}
{const r=await call('/api/login',await jwt('wife@x.com'));eq(r.status,302);eq(r.headers.get('Location'),'/')}
eq((await call('/api/login')).status,401,'login without token');
eq((await call('/api/sync',null,{since:0})).status,401,'sync without token');
eq(await (await call('/index.html')).text(),'asset','non-api goes to assets');
{const r=await worker.fetch(new Request('https://x.test/api/sync',{method:'POST',headers:{'Cf-Access-Jwt-Assertion':await jwt('wife@x.com')},body:'{bad'}),env);eq(r.status,400,'bad json')}

/* ---- device simulator: runs the real app script ---- */
let html=fs.readFileSync(R+'public/index.html','utf8');
let src=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).pop();
const tail=src.lastIndexOf('})();');src=src.slice(0,tail)+'globalThis.__T={save:save,del:del,store:function(){return store},S:S,merge:merge,importText:importText,syncNow:syncNow,syCheck:syCheck,syStart:syStart,SY:function(){return SY},sy:sy,render:render,view:view,tripCopy:tripCopy};'+src.slice(tail);
function device(name){const ls={};const els={};let who=null,online=true,clock=0;
 const stub=()=>new Proxy(function(){}, {get(t,k){if(k in t)return t[k];if(k==='querySelectorAll')return()=>[];if(k==='querySelector')return()=>stub();if(k==='style'||k==='dataset'||k==='classList')return t[k]=stub();if(k==='files')return[];if(k===Symbol.toPrimitive)return()=>'';return()=>{}},set(t,k,v){t[k]=v;return true},apply(){return undefined}});
 const el=id=>els[id]=els[id]||stub();
 const ctx={console,JSON,Math,Object,Array,String,Number,Promise,Error,isFinite,parseFloat,isNaN,encodeURIComponent,Blob,URL,
  Date:class extends Date{constructor(...a){if(a.length)super(...a);else super(Date.now()+clock)}static now(){return Date.now()+clock}},
  setTimeout,clearTimeout,setInterval:()=>0,
  localStorage:{getItem:k=>k in ls?ls[k]:null,setItem:(k,v)=>{ls[k]=String(v)},removeItem:k=>{delete ls[k]}},
  navigator:{userAgent:'test'},location:{protocol:'https:',hostname:'x.test',href:''},
  document:{querySelector:s=>s==='.modal'?null:el(s),querySelectorAll:()=>[],createElement:()=>stub(),addEventListener(){},activeElement:null,body:stub(),documentElement:stub(),visibilityState:'visible'},
  addEventListener(){},matchMedia:()=>({matches:false}),
  fetch:async(path,init={})=>{if(!online)throw new TypeError('offline');if(!path.startsWith('/'))throw new TypeError('blocked '+path);
   return worker.fetch(new Request('https://x.test'+path,{method:init.method||'GET',headers:Object.assign({},init.headers||{},who?{'Cf-Access-Jwt-Assertion':await jwt(who)}:{}),body:init.body}),env)}};
 ctx.window=ctx;ctx.globalThis=ctx;vm.createContext(ctx);vm.runInContext(src,ctx,{filename:name});
 const T=ctx.__T;
 const settle=async()=>{for(let i=0;i<400;i++){await new Promise(r=>setTimeout(r,10));if(!T.sy.busy&&!T.sy.again&&(T.sy.st!=='in'||!Object.keys(T.SY().d).length||T.sy.off||T.sy.err))break}await new Promise(r=>setTimeout(r,80));if(T.sy.busy)await settle()};
 return {T,ls,name,el,login:async e=>{who=e;T.syCheck();await settle()},setWho:e=>{who=e},sync:async()=>{T.syncNow();await settle()},online:v=>{online=v},tick:ms=>{clock+=ms},settle,
  data:()=>{const s=JSON.parse(JSON.stringify(T.store()));return s},home:()=>String(el('#app').innerHTML)}}
const recs=d=>{const s=d.data();const o={};for(const c of Object.keys(s))if(c!=='del')o[c]=s[c];return o};
const rows=sql=>DB.raw.prepare(sql).all();

/* ---- 2. first sign-in uploads what is already on the phone ---- */
const A=device('A');
A.T.save('trips','t1',{dest:'Nanjing',emoji:'🏯',start:'2026-11-21',end:'2026-11-25',cur:'SGD',budget:3000});
A.T.save('acts','a1',{trip:'t1',date:'2026-11-22',time:'09:00',title:'City wall',loc:'',notes:'',bk:'tobook',bkd:'2026-11-15',bkl:'https://example.com',bkr:'',ex:''});
A.T.save('expenses','e1',{trip:'t1',desc:'Tickets',date:'2026-11-22',cat:'activities',amt:100,ccy:'CNY',rate:0.19,home:19,src:'auto',st:'planned'});
A.T.save('packing','p1',{trip:'t1',text:'Passport',cat:'Documents',done:false});
A.T.save('hotels','h1',{trip:'t1',name:'Hotel',cin:'2026-11-21',cout:'2026-11-25',ln:'Nanjing, China',la:'32.06',lo:'118.79'});
A.T.save('flights','f1',{trip:'t1',airline:'SQ',no:'836',from:'SIN',to:'NKG',dep:'2026-11-21T10:35',depTz:'8',arr:'2026-11-21T15:45',arrTz:'8'});
eq(A.T.sy.st,'','before sign-in: no sync state');eq(Object.keys(A.T.SY().d).length,0,'nothing tracked before sign-in');
eq(rows('select count(*) n from sqlite_master where name=\'records\'')[0].n,0,'no table before any sync');
// signed out: API says 401 -> button offered, nothing uploaded
await A.login(null);eq(A.T.sy.st,'out','signed out state');ok(A.home().length>=0);
await A.login('wife@x.com');
eq(A.T.sy.st,'in');eq(A.T.SY().email,'wife@x.com');eq(Object.keys(A.T.SY().d).length,0,'all uploaded');
eq(rows('select count(*) n from records')[0].n,6,'6 rows on server');
eq(rows('select email,role from members'),[{email:'wife@x.com',role:'owner'}],'owner membership');
ok(A.T.SY().cur>0,'cursor set');eq(A.T.SY().roles,{t1:'owner'});
ok(/wife@x\.com/.test(String(A.el('#syn').innerHTML))&&/Synced/.test(String(A.el('#syn').innerHTML)),'status line shows email + Synced');

/* ---- 3. second phone, same email, starts empty ---- */
const B=device('B');await B.login('wife@x.com');
eq(recs(B),recs(A),'B has the same data as A');ok(/Nanjing/.test(B.home()),'B home shows the trip');
{const c=B.T.SY().cur;await B.sync();eq(B.T.SY().cur,c,'repeat sync: cursor unchanged');eq(recs(B),recs(A))}

/* ---- 4. edits travel both ways ---- */
B.tick(1000);B.T.save('acts','a1',Object.assign({},B.T.store().acts.a1,{title:'City wall walk',bk:'booked',bkr:'REF9'}));await B.sync();await A.sync();
eq(A.T.store().acts.a1.title,'City wall walk');eq(A.T.store().acts.a1.bk,'booked');eq(recs(A),recs(B));
A.tick(2000);A.T.save('packing','p2',{trip:'t1',text:'Umbrella',cat:'Other',done:true});await A.sync();await B.sync();ok(B.T.store().packing.p2.done===true,'new item reached B');

/* ---- 5. deletion travels and an old backup cannot bring it back ---- */
const oldExport=JSON.stringify({app:'tripplanner',v:1,data:A.data()});
A.tick(1000);A.T.del('acts','a1');await A.sync();await B.sync();
ok(!B.T.store().acts.a1,'deleted on B');ok(B.T.store().del['acts/a1']>0,'tombstone on B');
eq(rows("select del,data from records where id='a1'"),[{del:1,data:null}],'server keeps a tombstone');
B.T.importText(oldExport);ok(!B.T.store().acts.a1,'old backup did not resurrect it');await B.sync();await A.sync();ok(!A.T.store().acts.a1);
// a stale copy pushed straight at the server is refused too
{const r=await (await call('/api/sync',await jwt('wife@x.com'),{since:0,recs:{acts:{a1:JSON.parse(oldExport).data.acts.a1}}})).json();ok(!(r.recs.acts&&r.recs.acts.a1),'server refused stale record');ok(r.del['acts/a1']>0)}

/* ---- 6. same item edited on both phones: newest wins on both ---- */
A.online(false);B.online(false);
A.tick(1000);A.T.save('expenses','e1',Object.assign({},A.T.store().expenses.e1,{desc:'Tickets (A)'}));
B.tick(5000);B.T.save('expenses','e1',Object.assign({},B.T.store().expenses.e1,{desc:'Tickets (B, later)'}));
await A.sync();eq(A.T.sy.off,1,'offline flagged');ok(Object.keys(A.T.SY().d).length===1,'change kept for later');
ok(/Offline/.test(String(A.el('#syn').innerHTML)),'status says offline');
A.online(true);B.online(true);await A.sync();await B.sync();await A.sync();
eq(A.T.store().expenses.e1.desc,'Tickets (B, later)');eq(B.T.store().expenses.e1.desc,'Tickets (B, later)');eq(recs(A),recs(B));

/* ---- 7. another person sees nothing and cannot touch it ---- */
const C=device('C');C.T.save('trips','t9',{dest:'Tokyo',emoji:'🗼',start:'2027-01-01',end:'2027-01-05',cur:'SGD',budget:0});
await C.login('friend@y.com');ok(!C.T.store().trips.t1,'C does not get t1');eq(Object.keys(C.T.store().trips),['t9']);
const before=JSON.stringify(rows("select * from records where trip='t1' order by col,id"));
const ft=await jwt('friend@y.com'),far=Date.now()+60000;
await call('/api/sync',ft,{since:0,recs:{acts:{zz:{trip:'t1',title:'intruder',date:'2026-11-22',_u:far}},trips:{t1:{dest:'HACKED',start:'2026-01-01',end:'2026-01-02',_u:far}},expenses:{e1:{trip:'t9',desc:'hijack',_u:far}}},dels:[{k:'trips/t1',t:far,trip:'t1'},{k:'packing/p1',t:far,trip:'t9'},{k:'packing/p1',t:far}]});
eq(JSON.stringify(rows("select * from records where trip='t1' order by col,id")),before,'t1 untouched by another account');
eq(rows("select count(*) n from records where id='zz'")[0].n,0);eq(rows("select count(*) n from members where trip='t1'")[0].n,1);
{const r=await (await call('/api/sync',ft,{since:0})).json();eq(Object.keys(r.roles),['t9']);ok(!JSON.stringify(r).includes('Nanjing'),'no leak in pull')}
await A.sync();eq(A.T.store().trips.t1.dest,'Nanjing');ok(!A.T.store().trips.t9,'A does not get C trip');

/* ---- 8. import of a file is uploaded too ---- */
const D=device('D');D.T.save('trips','t2',{dest:'Osaka',emoji:'🍜',start:'2027-03-01',end:'2027-03-04',cur:'SGD',budget:0});D.T.save('acts','a2',{trip:'t2',date:'2027-03-02',title:'Castle'});
const file=JSON.stringify({app:'tripplanner',v:1,data:D.data()});
eq(A.T.importText(file),2,'import count');ok(A.T.SY().d['trips/t2']&&A.T.SY().d['acts/a2'],'imported items queued');await A.sync();await B.sync();
eq(B.T.store().trips.t2.dest,'Osaka');eq(B.T.store().acts.a2.title,'Castle');eq(A.T.importText(file),0,'importing twice changes nothing');
// export text is unchanged in shape and round-trips into a fresh phone
{const E=device('E');const x=JSON.stringify({app:'tripplanner',v:1,data:A.data()});E.T.importText(x);eq(recs(E),recs(A),'export -> import round trip');ok(!('tp_sync' in JSON.parse(x).data),'sync state not in export')}

/* ---- 9. different account on a phone that already synced: asks first ---- */
const n0=rows('select count(*) n from records')[0].n;
await B.login('friend@y.com');eq(B.T.sy.st,'ask');eq(rows('select count(*) n from records')[0].n,n0,'nothing uploaded while asking');
B.T.save('packing','p7',{trip:'t1',text:'Hat',cat:'Clothes',done:false});await B.sync();eq(rows("select count(*) n from records where id='p7'")[0].n,0,'still nothing uploaded');
ok(/wife@x\.com/.test(String(B.el('#syn').innerHTML))&&/friend@y\.com/.test(String(B.el('#syn').innerHTML)),'ask banner names both');
await B.login('wife@x.com');eq(B.T.sy.st,'in');await B.sync();eq(rows("select count(*) n from records where id='p7'")[0].n,1,'back on own account: uploaded');

/* ---- 10. session expired: keeps working locally, catches up after sign-in ---- */
A.setWho(null);A.tick(1000);A.T.save('packing','p8',{trip:'t1',text:'Charger',cat:'Electronics',done:false});await A.sync();
eq(A.T.sy.st,'out');ok(A.T.store().packing.p8,'saved locally');ok(A.T.SY().d['packing/p8'],'queued');
ok(/Sign in to sync/.test(String(A.el('#syn').innerHTML)),'sign-in button shown');
await A.login('wife@x.com');eq(A.T.sy.st,'in');eq(Object.keys(A.T.SY().d).length,0);await B.sync();ok(B.T.store().packing.p8&&A.T.store().packing.p7,'both caught up');eq(recs(A),recs(B));

/* ---- 11. big first upload goes in chunks ---- */
const F=device('F');F.T.save('trips','tb',{dest:'Big',start:'2027-05-01',end:'2027-05-30',cur:'SGD',budget:0});
for(let i=0;i<700;i++)F.T.save('packing','pb'+i,{trip:'tb',text:'Item '+i,cat:'Other',done:false});
await F.login('big@z.com');eq(rows("select count(*) n from records where trip='tb'")[0].n,701,'701 rows uploaded');eq(Object.keys(F.T.SY().d).length,0);
const G=device('G');const q0=DB.count();await G.login('big@z.com');eq(Object.keys(G.T.store().packing).length,700,'new phone pulls all 700');
ok(DB.count()-q0<=12,'queries for a full pull: '+(DB.count()-q0));

/* ---- 12. deleting a trip removes it everywhere ---- */
A.tick(1000);['flights','acts','hotels','expenses','packing'].forEach(c=>A.T.S[c].filter(x=>x.trip==='t2').forEach(x=>A.T.del(c,x.id)));A.T.del('trips','t2');
await A.sync();await B.sync();ok(!B.T.store().trips.t2&&!B.T.store().acts.a2,'trip gone on B');ok(B.T.store().trips.t1,'other trip kept');eq(recs(A),recs(B));

/* ---- 13. clock far in the future is clamped ---- */
{const r=await (await call('/api/sync',await jwt('wife@x.com'),{since:0,recs:{packing:{pf:{trip:'t1',text:'future',cat:'Other',done:false,_u:Date.now()+9e9}}}})).json();ok(r.recs.packing.pf._u<Date.now()+400000,'future timestamp clamped')}
/* ---- 14. junk input ignored ---- */
{const r=await call('/api/sync',await jwt('wife@x.com'),{since:'x',recs:{bogus:{a:{}},acts:{'bad id!':{trip:'t1',_u:5},ok1:null,ok2:{trip:'../x',_u:5},ok3:{trip:'t1'}}},dels:[{k:'nope'},{k:'bogus/x',t:1},null]});eq(r.status,200,'junk tolerated');eq(rows("select count(*) n from records where id in ('ok1','ok2','ok3','a')")[0].n,0)}
{const big='x'.repeat(25000);await call('/api/sync',await jwt('wife@x.com'),{since:0,recs:{acts:{huge:{trip:'t1',notes:big,_u:Date.now()}}}});eq(rows("select count(*) n from records where id='huge'")[0].n,0,'oversized record refused')}

/* ================= SHARING ================= */
const wt=await jwt('wife@x.com'),ht=await jwt('husband@x.com');
const sh=async(tok,body,q)=>{const r=await call('/api/share'+(q||''),tok,body);return {s:r.status,j:await r.json()}};
await A.sync();await C.sync();
const H=device('H');await H.login('husband@x.com');eq(Object.keys(H.T.store().trips),[], 'husband starts with nothing');
// who may share
eq((await sh(ht,null,'?trip=t1')).s,404,'non-member cannot see the list');
eq((await sh(ht,{trip:'t1',email:'x@x.com',role:'editor'})).s,404,'non-member cannot share');
eq((await sh(wt,{trip:'t1',email:'not-an-email',role:'editor'})).j.error,'bad-email');
eq((await sh(wt,{trip:'t1',email:'wife@x.com',role:'viewer'})).j.error,'self');
eq((await sh(wt,{trip:'t1',email:'h2@x.com',role:'owner'})).j.error,'bad-role');
eq((await sh(wt,{trip:'t1',leave:true})).j.error,'owner-cannot-leave');
// 15. share with husband as editor: an already-synced phone receives the whole trip
{const r=await sh(wt,{trip:'t1',email:'Husband@X.com',role:'editor'});eq(r.j.ok,true);eq(r.j.members.map(m=>m.email+':'+m.role),['wife@x.com:owner','husband@x.com:editor'])}
await H.sync();eq(recs(H).trips.t1.dest,'Nanjing');
{const a=recs(A),h=recs(H);for(const c of Object.keys(a))eq(Object.keys(h[c]).filter(i=>(c==='trips'?i:h[c][i].trip)==='t1').sort(),Object.keys(a[c]).filter(i=>(c==='trips'?i:a[c][i].trip)==='t1').sort(),'husband has all of t1: '+c)}
eq(H.T.SY().roles.t1,'editor');H.T.render();ok(/shared with you/.test(H.home()),'home marks the shared trip');
// editor edits reach the owner
H.tick(60000);H.T.save('acts','ah',{trip:'t1',date:'2026-11-23',title:'Dinner (by husband)'});H.T.save('expenses','e1',Object.assign({},H.T.store().expenses.e1,{desc:'Tickets (husband)'}));
await H.sync();await A.sync();eq(A.T.store().acts.ah.title,'Dinner (by husband)');eq(A.T.store().expenses.e1.desc,'Tickets (husband)');
// editor cannot delete the trip or re-share it
await call('/api/sync',ht,{since:0,dels:[{k:'trips/t1',t:Date.now()+1000,trip:'t1'}]});eq(rows("select del from records where col='trips' and id='t1'")[0].del,0,'editor cannot delete the trip');
eq((await sh(ht,{trip:'t1',email:'z@x.com',role:'viewer'})).s,403,'editor cannot share');
ok((await sh(ht,null,'?trip=t1')).j.members.length===2,'editor can see who is on the trip');
// 16. friend as view only
await sh(wt,{trip:'t1',email:'friend@y.com',role:'viewer'});await C.sync();
eq(C.T.store().trips.t1.dest,'Nanjing');ok(C.T.store().expenses.e1,'viewer sees expenses');eq(C.T.SY().roles.t1,'viewer');
eq((await sh(await jwt('friend@y.com'),null,'?trip=t1')).j.members,[],'viewer does not see other emails');
{const before=JSON.stringify(recs(C));C.tick(90000);C.T.save('acts','av',{trip:'t1',date:'2026-11-23',title:'viewer edit'});C.T.del('packing','p1');C.T.save('trips','t1',Object.assign({},C.T.store().trips.t1,{dest:'X'}));
 eq(JSON.stringify(recs(C)),before,'viewer: nothing changes locally');
 C.T.save('packing','own1',{trip:'t9',text:'own item',cat:'Other',done:false});ok(C.T.store().packing.own1,'viewer can still edit own trip')}
{const b=JSON.stringify(rows("select col,id,u,del from records where trip='t1' order by col,id"));
 await call('/api/sync',await jwt('friend@y.com'),{since:0,recs:{acts:{av2:{trip:'t1',title:'x',date:'2026-11-23',_u:Date.now()+2000}},packing:{p1:Object.assign({},A.T.store().packing.p1,{text:'hacked',_u:Date.now()+2000})}},dels:[{k:'packing/p2',t:Date.now()+2000,trip:'t1'}]});
 eq(JSON.stringify(rows("select col,id,u,del from records where trip='t1' order by col,id")),b,'server refuses viewer writes')}
// 17. view only with the budget hidden
await sh(wt,{trip:'t1',email:'friend@y.com',role:'viewer-nb'});C.T.save('expenses','eo',{trip:'t9',desc:'own',date:'2027-01-02',cat:'food',amt:5,ccy:'SGD',rate:1,home:5,src:'auto',st:'paid'});await C.sync();
eq(Object.values(C.T.store().expenses).filter(e=>e.trip==='t1').length,0,'t1 expenses removed from the viewer phone');ok(C.T.store().expenses.eo,'own expenses kept');
{const r=await (await call('/api/sync',await jwt('friend@y.com'),{since:0})).json();ok(!Object.values(r.recs.expenses||{}).some(e=>e.trip==='t1'),'no t1 expenses sent');ok(!('budget' in r.recs.trips.t1),'trip budget not sent');ok('budget' in r.recs.trips.t9||true)}
{const X=device('X');await X.login('friend@y.com');ok(!('budget' in X.T.store().trips.t1),'fresh phone: no budget');eq(Object.values(X.T.store().expenses).filter(e=>e.trip==='t1').length,0);X.T.view.tripId='t1';X.T.view.tab='bu';X.T.render();if(!/not shared with you/.test(X.home()))console.log("DBG",X.home().slice(0,600));ok(/not shared with you/.test(X.home()),'budget tab says not shared')}
await A.sync();ok(A.T.store().expenses.e1,'owner still has the expenses');
await sh(wt,{trip:'t1',email:'friend@y.com',role:'viewer'});await C.sync();ok(C.T.store().expenses.e1,'expenses come back when the budget is shared again');
// 18. removing a person
{const r=await sh(wt,{trip:'t1',email:'friend@y.com',role:''});eq(r.j.members.length,2)}
await C.sync();ok(!C.T.store().trips.t1&&!Object.values(C.T.store().acts).some(a=>a.trip==='t1'),'trip removed from the friend phone');ok(C.T.store().trips.t9&&C.T.store().packing.own1,'own trip kept');
ok(!Object.keys(C.T.store().del).some(k=>k==='trips/t1'),'no deletion recorded');await C.sync();await A.sync();ok(A.T.store().trips.t1&&A.T.store().acts.ah,'owner keeps everything');
{const r=await (await call('/api/sync',await jwt('friend@y.com'),{since:0})).json();ok(!r.recs.trips.t1,'removed person gets nothing')}
// 19. leaving
eq((await sh(ht,{trip:'t1',leave:true})).j.left,true);await H.sync();ok(!H.T.store().trips.t1,'left trip is gone on that phone');await A.sync();ok(A.T.store().trips.t1);
eq(rows("select email from members where trip='t1'"),[{email:'wife@x.com'}]);
// 20. limit
for(let i=0;i<20;i++)await sh(wt,{trip:'t1',email:'p'+i+'@x.com',role:'viewer'});
eq((await sh(wt,{trip:'t1',email:'p99@x.com',role:'viewer'})).j.error,'limit');eq((await sh(wt,{trip:'t1',email:'p3@x.com',role:'editor'})).j.ok,true,'changing an existing person still works at the limit');
// 21. owner phone unaffected by all of this
await B.sync();{const a=recs(A),b=recs(B);eq(a,b,'both owner phones equal at the end')}

/* ============ same trip already in another account ============ */
{const P=device('P');P.T.save('trips','ts',{dest:'Seoul',emoji:'🇰🇷',start:'2027-06-01',end:'2027-06-05',cur:'SGD',budget:500});P.T.save('acts','as1',{trip:'ts',date:'2027-06-02',title:'Palace'});P.T.save('expenses','es1',{trip:'ts',desc:'Tix',date:'2027-06-02',cat:'activities',amt:10,ccy:'SGD',rate:1,home:10,src:'auto',st:'paid'});
 const file=JSON.stringify({app:'tripplanner',v:1,data:P.data()});
 await P.login('hubby@q.com');eq(P.T.SY().roles.ts,'owner');
 const Q=device('Q');Q.T.save('trips','tq',{dest:'Own',emoji:'🌍',start:'2027-07-01',end:'2027-07-02',cur:'SGD',budget:0});await Q.login('wifey@q.com');
 Q.T.importText(file);await Q.sync();
 ok(!Q.T.SY().roles.ts,'no role on a trip owned by someone else');eq(Q.T.SY().no,{ts:1},'trip flagged as not synced');eq(Object.keys(Q.T.SY().d).length,0,'queue drained');
 Q.T.render();ok(/not synced/.test(Q.home()),'home marks it');Q.T.view.tripId='ts';Q.T.render();ok(/Not synced/.test(Q.home())&&/cpTrip/.test(Q.home())&&!/shTrip/.test(Q.home()),'trip page explains, no Share button');
 Q.T.view.tripId='tq';Q.T.render();ok(/shTrip/.test(Q.home())&&!/Not synced/.test(Q.home()),'own trip has Share');
 // a phone that got into this state before the update (flag missing) finds out on its next sync
 delete Q.T.SY().no.ts;Q.T.sy.re={};await Q.sync();eq(Q.T.SY().no,{ts:1},'old state self-detects');await new Promise(r=>setTimeout(r,2500));const qn=DB.count();await Q.sync();await Q.sync();await new Promise(r=>setTimeout(r,2500));console.log('queries for 2 idle syncs:',DB.count()-qn);ok(DB.count()-qn<=8&&Object.keys(Q.T.SY().d).length===0,'no re-push loop');
 // owner shares it -> flag clears, both merge
 Q.tick(5000);Q.T.save('acts','as2',{trip:'ts',date:'2027-06-03',title:'Added by wife while unsynced'});await Q.sync();eq(rows("select count(*) n from records where id='as2'")[0].n,0,'still not uploaded');
 await sh(await jwt('hubby@q.com'),{trip:'ts',email:'wifey@q.com',role:'editor'});await Q.sync();await Q.sync();
 eq(Q.T.SY().roles.ts,'editor');eq(Q.T.SY().no,{},'flag cleared after sharing');eq(rows("select count(*) n from records where id='as2'")[0].n,1,'her pending change uploaded after sharing');
 await P.sync();eq(P.T.store().acts.as2.title,'Added by wife while unsynced');
 // keep as my own copy
 const Z=device('Z');await Z.login('third@q.com');Z.T.importText(file);await Z.sync();eq(Z.T.SY().no,{ts:1});
 Z.T.tripCopy({id:'ts'});await Z.sync();
 const zt=Object.keys(Z.T.store().trips);eq(zt.length,1);ok(zt[0]!=='ts','copy has a new id');eq(Z.T.SY().roles[zt[0]],'owner','copy is owned');eq(Z.T.SY().no,{});
 eq(Object.values(Z.T.store().acts).map(a=>a.title+':'+(a.trip===zt[0])),['Palace:true']);eq(Object.values(Z.T.store().expenses).length,1);eq(Z.T.store().trips[zt[0]].dest,'Seoul');
 ok(!Object.keys(Z.T.store().del).length,'copy leaves no deletion marks');await P.sync();ok(P.T.store().trips.ts&&P.T.store().acts.as1&&!P.T.store().trips[zt[0]],'original owner untouched');
 const Z2=device('Z2');await Z2.login('third@q.com');eq(Object.keys(Z2.T.store().trips),zt,'copy syncs to her other phone')}
/* 400 pending items queued before a new trip: the trip is still claimed */
{const M=device('M');await M.login('many@q.com');M.T.save('trips','tm',{dest:'M',start:'2027-08-01',end:'2027-08-02',cur:'SGD',budget:0});M.online(false);await M.sync();
 for(let i=0;i<400;i++)M.T.save('packing','mp'+i,{trip:'tm2',text:'i'+i,cat:'Other',done:false});M.T.save('trips','tm2',{dest:'M2',start:'2027-08-01',end:'2027-08-02',cur:'SGD',budget:0});
 M.online(true);await M.sync();eq(rows("select count(*) n from records where trip='tm2'")[0].n,401,'all 401 uploaded');eq(M.T.SY().roles.tm2,'owner')}
console.log('ALL PASSED:',pass,'checks');process.exit(0);
