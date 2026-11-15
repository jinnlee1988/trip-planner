// Flights, Hotels, Itinerary and home at several widths, themes and device languages; also saves and adds a flight through the form.
// Run:  node tests/screens/tabs.js   (needs Playwright with Chromium). Screenshots go to tests/screens/out/.
const path=require('path');const OUT=path.join(__dirname,'out');require('fs').mkdirSync(OUT,{recursive:true});
const {chromium}=require('playwright');const fs=require('fs');
const html=fs.readFileSync(path.join(__dirname,'..','..','public','index.html'),'utf8');
(async()=>{const b=await chromium.launch();
 const data={trips:{t1:{dest:'Nanjing, China',emoji:'🗺️✈️🍂',start:'2026-11-21',end:'2026-11-28',cur:'SGD',budget:0,_u:1}},flights:{
  f1:{trip:'t1',airline:'Scoot B787-8',no:'TR 180',from:'SIN',to:'NKG',fromN:'Changi T1',toN:'Lukou T2',dep:'2026-11-21T10:35',depTz:'8',arr:'2026-11-21T15:45',arrTz:'8',ref:'ECMGGD',seat:'15J,15K',notes:'Check-in luggage 20kg',_u:1},
  f2:{trip:'t1',airline:'Scoot',no:'TR 181',from:'NKG',to:'SIN',dep:'2026-11-28T17:00',depTz:'8',arr:'2026-11-28T22:30',arrTz:'8',ref:'ECMGGD',seat:'10D,10E',notes:'Check-in luggage 20kg',_u:1},
  f3:{trip:'t1',airline:'Test',no:'XX 1',from:'SIN',to:'LAX',fromN:'Changi Airport Terminal 3',dep:'2026-11-28T23:00',depTz:'8',arr:'2026-11-30T01:30',arrTz:'-8',_u:1}},acts:{},hotels:{h1:{trip:'t1',name:'南京夫子庙秦淮游船码头亚朵酒店',addr:'大石壩街35号, 秦淮区, 南京',ln:'Nanjing, China',cin:'2026-11-21',cout:'2026-11-24',tin:'16:00',tout:'12:00',ref:'1658115307681302',notes:'PIN: 9043 尊享城景大床房(亚朵星球深睡枕PRO+深睡床垫)',_u:1},h2:{trip:'t1',name:'Plain Hotel',cin:'2026-11-30',cout:'2026-12-01',_u:1}},expenses:{},packing:{},del:{}};
 for(const [name,w,hgt,theme,loc] of [['f-m',390,860,'light','en-GB'],['f-s',320,860,'light','en-GB'],['f-x',350,860,'light','en-GB'],['f-m-dark',390,860,'dark','en-US'],['f-d',900,760,'light','zh-CN']]){
  const ctx=await b.newContext({viewport:{width:w,height:hgt},deviceScaleFactor:1,colorScheme:theme,locale:loc});const pg=await ctx.newPage();
  const errs=[];pg.on('pageerror',e=>errs.push(e.message));
  await pg.route('**/*',r=>{const u=new URL(r.request().url());if(u.pathname==='/api/me')return r.fulfill({status:401,json:{}});if(u.pathname==='/')return r.fulfill({contentType:'text/html',body:html});return r.fulfill({status:404,body:''})});
  await pg.goto('http://x.test/');await pg.evaluate(d=>localStorage.setItem('tp_data',JSON.stringify(d)),data);await pg.reload();
  await pg.click('[data-open]');await pg.click('.tabs button:nth-child(2)');await pg.waitForTimeout(300);
  const dates=await pg.$$eval('[data-fl] .fle .mu',e=>e.map(x=>x.textContent));
  await pg.screenshot({path:path.join(OUT,name+'.png')});await pg.click('.tabs button:nth-child(3)');await pg.waitForTimeout(200);await pg.screenshot({path:path.join(OUT,name+'-h.png')});await pg.click('.tabs button:nth-child(1)');await pg.waitForTimeout(200);await pg.screenshot({path:path.join(OUT,name+'-i.png')});await pg.click('#back');await pg.waitForTimeout(200);await pg.screenshot({path:path.join(OUT,name+'-home.png')});await pg.click('[data-open]');await pg.click('.tabs button:nth-child(2)');await pg.waitForTimeout(200);
  let form='';if(name==='f-m'){await pg.click('[data-fl]');await pg.waitForTimeout(200);await pg.screenshot({path:path.join(OUT,'f-form.png')});
   await pg.fill('[name=fromN]','Changi Airport T1 edited');await pg.click('#mOk');await pg.waitForTimeout(200);
   form=await pg.evaluate(()=>{const f=JSON.parse(localStorage.getItem('tp_data')).flights.f1;return f.fromN+' | '+f.toN+' | '+f.dep+' | '+f.no});
   await pg.click('#addFl');await pg.fill('[name=airline]','A');await pg.fill('[name=no]','B1');await pg.fill('[name=from]','sin');await pg.fill('[name=to]','kul');await pg.click('#mOk');await pg.waitForTimeout(200);
   form+=' || new: '+await pg.evaluate(()=>{const fl=Object.values(JSON.parse(localStorage.getItem('tp_data')).flights).find(f=>f.no==='B1');return JSON.stringify([fl.from,fl.to,fl.fromN,fl.toN])})+' apn count '+await pg.locator('.apn').count()}
  console.log(name,loc,'errors:',errs.length?errs:'none','scrollW',await pg.evaluate(()=>document.documentElement.scrollWidth),dates.join(','),form);await ctx.close()}
 await b.close()})();
