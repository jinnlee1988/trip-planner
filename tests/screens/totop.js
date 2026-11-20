// Back-to-top button: hidden at the top, appears after scrolling, sits above the tab bar on trip pages, scrolls to the top; day heading style.
// Run:  node tests/screens/totop.js   (needs Playwright with Chromium). Screenshots go to tests/screens/out/.
const path=require('path');const OUT=path.join(__dirname,'out');require('fs').mkdirSync(OUT,{recursive:true});
const {chromium}=require('playwright');const fs=require('fs');
const html=fs.readFileSync(path.join(__dirname,'..','..','public','index.html'),'utf8');
(async()=>{const b=await chromium.launch();const acts={};for(let i=0;i<25;i++)acts['a'+i]={trip:'t1',date:'2026-11-21',time:String(7+Math.floor(i/2)).padStart(2,'0')+':'+(i%2?'30':'00'),title:'Activity '+i,notes:'Some notes',_u:1};
 const trips={t1:{dest:'Nanjing, China',emoji:'🗺️',start:'2026-11-21',end:'2026-11-28',cur:'SGD',budget:0,_u:1}};for(let i=2;i<14;i++)trips['t'+i]={dest:'Trip '+i,start:'2027-0'+(1+i%9)+'-01',end:'2027-0'+(1+i%9)+'-05',cur:'SGD',budget:0,_u:1};
 const data={trips,flights:{},acts,hotels:{},expenses:{},packing:{},del:{}};
 for(const theme of ['light','dark']){
 const ctx=await b.newContext({viewport:{width:390,height:760},colorScheme:theme});const pg=await ctx.newPage();const errs=[];pg.on('pageerror',e=>errs.push(e.message));
 await pg.route('**/*',r=>{const u=new URL(r.request().url());if(u.pathname==='/api/me')return r.fulfill({status:401,json:{}});if(u.pathname==='/')return r.fulfill({contentType:'text/html',body:html});return r.fulfill({status:404,body:''})});
 await pg.goto('http://x.test/');await pg.evaluate(d=>localStorage.setItem('tp_data',JSON.stringify(d)),data);await pg.reload();
 const st=async()=>pg.evaluate(()=>{const e=document.querySelector('#toTop'),r=e.getBoundingClientRect(),c=getComputedStyle(e);return {shown:e.classList.contains('show'),clickable:c.pointerEvents!=='none',bottomGap:Math.round(innerHeight-r.bottom),y:Math.round(scrollY)}});
 const out=[];out.push(['home top',await st()]);await pg.mouse.wheel(0,600);await pg.waitForTimeout(400);out.push(['home scrolled',await st()]);
 await pg.click('#toTop');await pg.waitForTimeout(900);out.push(['after tap',await st()]);
 await pg.click('[data-open="t1"]');await pg.waitForTimeout(300);out.push(['trip top',await st()]);
 out.push(['heading',await pg.evaluate(()=>{const d=[...document.querySelectorAll('#app div')].find(x=>/^Saturday, 21 November$/.test(x.textContent));const c=getComputedStyle(d);return c.fontWeight+' '+c.color})]);
 await pg.mouse.wheel(0,1500);await pg.waitForTimeout(400);out.push(['trip scrolled (above tab bar)',await st()]);await pg.screenshot({path:path.join(OUT,'totop-'+theme+'.png')});
 await pg.click('#toTop');await pg.waitForTimeout(900);out.push(['after tap',await st()]);
 await pg.mouse.wheel(0,1500);await pg.waitForTimeout(300);await pg.click('#addAct');out.push(['form covers it (modal z above)',await pg.evaluate(()=>getComputedStyle(document.querySelector('.modal')).zIndex+'>'+getComputedStyle(document.querySelector('#toTop')).zIndex)]);
 console.log(theme,'errors:',errs.length?errs:'none');out.forEach(x=>console.log(' ',JSON.stringify(x)));await ctx.close()}
 await b.close()})();
