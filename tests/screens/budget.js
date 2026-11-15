// Budget: order of expenses inside a category.
// Run:  node tests/screens/budget.js   (needs Playwright with Chromium). Screenshots go to tests/screens/out/.
const path=require('path');const OUT=path.join(__dirname,'out');require('fs').mkdirSync(OUT,{recursive:true});
const {chromium}=require('playwright');const fs=require('fs');
const html=fs.readFileSync(path.join(__dirname,'..','..','public','index.html'),'utf8');
(async()=>{const b=await chromium.launch();const E=(id,desc,date,st,u,cat)=>[id,{trip:'t1',desc,date,cat:cat||'activities',amt:100,ccy:'CNY',rate:0.196,home:19.6,src:'manual',st,_u:u}];
 const data={trips:{t1:{dest:'Nanjing, China',emoji:'🗺️',start:'2026-11-21',end:'2026-11-28',cur:'SGD',budget:4000,_u:1}},flights:{},acts:{},hotels:{},packing:{},del:{},
  expenses:Object.fromEntries([E('a','D27 planned','2026-11-27','planned',9),E('b','D23 paid','2026-11-23','paid',8),E('c','D25 planned B','2026-11-25','planned',7),E('d','D25 paid A','2026-11-25','paid',3),E('e','D26 planned','2026-11-26','planned',5),E('f','Food D22','2026-11-22','paid',6,'food'),E('g','Food D21','2026-11-21','planned',7,'food')])};
 const ctx=await b.newContext({viewport:{width:390,height:900}});const pg=await ctx.newPage();const errs=[];pg.on('pageerror',e=>errs.push(e.message));
 await pg.route('**/*',r=>{const u=new URL(r.request().url());if(u.pathname==='/api/me')return r.fulfill({status:401,json:{}});if(u.pathname==='/')return r.fulfill({contentType:'text/html',body:html});return r.fulfill({status:404,body:''})});
 await pg.goto('http://x.test/');await pg.evaluate(d=>localStorage.setItem('tp_data',JSON.stringify(d)),data);await pg.reload();
 await pg.click('[data-open]');await pg.click('.tabs button:nth-child(4)');await pg.waitForTimeout(200);
 let out=[];for(const k of ['activities','food']){await pg.click('[data-cat="'+k+'"]');await pg.waitForTimeout(200);const txt=await pg.evaluate(()=>document.querySelector('#app').innerText);out.push(k+': '+txt.split('\n').filter(l=>/^(D\d|Food)/.test(l.trim())).join(' | '));if(k==='activities')await pg.screenshot({path:path.join(OUT,'b.png'),fullPage:true})}
 console.log('category bars (paid% + planned% of all spending):',JSON.stringify(await pg.$$eval('[data-cat]',e=>e.map(x=>x.dataset.cat+': '+[...x.querySelectorAll('.bar i')].map(i=>parseFloat(i.style.width).toFixed(1)).join(' + ')))));
 console.log('errors:',errs.length?errs:'none');console.log(out.join('\n'));
 await b.close()})();
