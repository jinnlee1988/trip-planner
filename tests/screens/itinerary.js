// Itinerary with simulated weather: day tiles, banner order, day strip scrolling.
// Run:  node tests/screens/itinerary.js   (needs Playwright with Chromium). Screenshots go to tests/screens/out/.
const path=require('path');const OUT=path.join(__dirname,'out');require('fs').mkdirSync(OUT,{recursive:true});
const {chromium}=require('playwright');const fs=require('fs');
const html=fs.readFileSync(path.join(__dirname,'..','..','public','index.html'),'utf8');
(async()=>{const b=await chromium.launch();
 const data={trips:{t1:{dest:'Nanjing, China',emoji:'🗺️',start:'2026-11-21',end:'2026-11-28',cur:'SGD',budget:0,_u:1}},flights:{f1:{trip:'t1',airline:'Scoot',no:'TR 180',from:'SIN',to:'NKG',dep:'2026-11-21T10:35',depTz:'8',arr:'2026-11-21T15:45',arrTz:'8',_u:1}},acts:{a1:{trip:'t1',date:'2026-11-21',time:'16:00',title:'落地 + 去酒店',_u:1}},hotels:{h1:{trip:'t1',name:'亚朵酒店',ln:'Nanjing, China',la:'32.06',lo:'118.79',cin:'2026-11-21',cout:'2026-11-24',tin:'16:00',_u:1}},expenses:{},packing:{},del:{}};
 const ctx=await b.newContext({viewport:{width:390,height:760}});const pg=await ctx.newPage();const errs=[];pg.on('pageerror',e=>errs.push(e.message));
 const days=[];for(let i=0;i<16;i++){const d=new Date(Date.UTC(2026,10,15+i));days.push(d.toISOString().slice(0,10))}
 await pg.route('**/*',r=>{const u=new URL(r.request().url());
  if(u.pathname==='/api/me')return r.fulfill({status:401,json:{}});if(u.pathname==='/')return r.fulfill({contentType:'text/html',body:html});
  if(u.hostname.includes('open-meteo'))return r.fulfill({json:{daily:{time:days,weather_code:days.map((_,i)=>[1,3,61,3,0,2,-0,45][i%8]),temperature_2m_max:days.map((_,i)=>14-i%5+0.4),temperature_2m_min:days.map((_,i)=>4-i%7),precipitation_probability_max:days.map((_,i)=>i*5)}}});
  return r.fulfill({status:404,body:''})});
 await pg.clock.setFixedTime(new Date('2026-11-15T08:00:00Z'));
 await pg.goto('http://x.test/');await pg.evaluate(d=>localStorage.setItem('tp_data',JSON.stringify(d)),data);await pg.reload();
 await pg.click('[data-open]');await pg.waitForTimeout(1500);
 console.log('errors:',errs.length?errs:'none');
 console.log('tiles:',JSON.stringify(await pg.$$eval('.days button',e=>e.slice(0,4).map(x=>x.innerText.replace(/\n/g,' / ')))));
 console.log('order:',JSON.stringify(await pg.$$eval('#app .note',e=>e.map(x=>x.innerText.slice(0,30)))));
 const st=()=>pg.evaluate(()=>{const d=document.querySelector('.days'),o=d.querySelector('.on'),a=d.getBoundingClientRect(),c=o.getBoundingClientRect();return {day:o.innerText.split('\n')[0],left:Math.round(d.scrollLeft),visible:c.left>=a.left-1&&c.right<=a.right+1}});
 console.log('start',JSON.stringify(await st()));
 await pg.evaluate(()=>{document.querySelector('.days').scrollLeft=9999});await pg.click('.days button:last-child');await pg.waitForTimeout(300);console.log('tap day 8',JSON.stringify(await st()));
 await pg.screenshot({path:path.join(OUT,'i.png')});
 await pg.evaluate(()=>{document.querySelector('.days').scrollLeft=120});await pg.click('.days button:nth-child(3)');await pg.waitForTimeout(300);console.log('tap day 3 (already visible)',JSON.stringify(await st()));
 await pg.click('.tabs button:nth-child(2)');await pg.click('.tabs button:nth-child(1)');await pg.waitForTimeout(300);console.log('other tab and back',JSON.stringify(await st()));
 await pg.click('.days button:nth-child(7)').catch(()=>{});await pg.evaluate(()=>{document.querySelector('.days').scrollLeft=9999});await pg.click('.days button:nth-child(7)');await pg.reload();await pg.click('[data-open]');await pg.waitForTimeout(600);console.log('reopen trip',JSON.stringify(await st()));
 await b.close()})();
