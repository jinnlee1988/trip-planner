// Home screen: phone and desktop, signed out / signed in / never signed in.
// Run:  node tests/screens/home.js   (needs Playwright with Chromium). Screenshots go to tests/screens/out/.
const path=require('path');const OUT=path.join(__dirname,'out');require('fs').mkdirSync(OUT,{recursive:true});
const {chromium}=require('playwright');const fs=require('fs');
const html=fs.readFileSync(path.join(__dirname,'..','..','public','index.html'),'utf8');
(async()=>{const b=await chromium.launch();
 const data={trips:{t1:{dest:'Nanjing, China',emoji:'🗺️✈️🍂',start:'2026-11-21',end:'2026-11-28',cur:'SGD',budget:0,_u:1}},flights:{},acts:{},hotels:{},expenses:{},packing:{},del:{}};
 for(const [name,w,hgt,mode,theme] of [['m-out',390,700,'out','light'],['m-in',390,700,'in','dark'],['m-new',390,500,'new','light'],['d-out',900,600,'out','light']]){
  const ctx=await b.newContext({viewport:{width:w,height:hgt},deviceScaleFactor:1,colorScheme:theme});const pg=await ctx.newPage();
  const errs=[];pg.on('pageerror',e=>errs.push(e.message));
  await pg.route('**/*',r=>{const u=new URL(r.request().url());
   if(u.pathname==='/api/me')return mode==='in'?r.fulfill({json:{ok:true,email:'me@example.com'}}):r.fulfill({status:401,json:{error:'signed-out'}});
   if(u.pathname==='/api/sync')return r.fulfill({json:{ok:true,email:'me@example.com',cursor:5,recs:{},del:{},roles:{t1:'editor'},denied:[]}});
   if(u.pathname==='/'||u.pathname==='/index.html')return r.fulfill({contentType:'text/html',body:html});return r.fulfill({status:404,body:''})});
  await pg.addInitScript(([d,mode])=>{const k=Object.keys(localStorage);if(!localStorage.getItem('__s')){localStorage.setItem('__s','1');window.__d=d;window.__m=mode}},[data,mode]);
  await pg.goto('http://x.test/');
  const K='tp_data';
  await pg.evaluate(([K,d,mode])=>{localStorage.setItem(K,JSON.stringify(d));if(mode!=='new')localStorage.setItem('tp_sync',JSON.stringify({email:'me@example.com',cur:5,d:{},dt:{},no:{},roles:{t1:'editor'},at:Date.now()}))},[K,data,mode]);
  await pg.reload();await pg.waitForTimeout(900);
  console.log(name,'K=',K,'errors:',errs.length?errs:'none','scrollW',await pg.evaluate(()=>document.documentElement.scrollWidth),'exp visible:',await pg.locator('#exp').isVisible(),'thm:',await pg.locator('#thm').isVisible());
  await pg.screenshot({path:path.join(OUT,name+'.png')});await ctx.close()}
 await b.close()})();
