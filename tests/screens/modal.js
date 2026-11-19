// Forms (pop-up sheets): tap outside / Escape closes; a second tap is needed when something was typed; Save and Delete still work.
// Run:  node tests/screens/modal.js   (needs Playwright with Chromium). Prints one line per check.
const {chromium}=require('playwright');const fs=require('fs');
const html=fs.readFileSync(require('path').join(__dirname,'..','..','public','index.html'),'utf8');
(async()=>{const b=await chromium.launch();const data={trips:{t1:{dest:'Nanjing',emoji:'🗺️',start:'2026-11-21',end:'2026-11-28',cur:'SGD',budget:100,_u:1}},flights:{},acts:{},hotels:{},expenses:{},packing:{},del:{}};
 const ctx=await b.newContext({viewport:{width:390,height:760},hasTouch:true});const pg=await ctx.newPage();const errs=[];pg.on('pageerror',e=>errs.push(e.message));
 await pg.route('**/*',r=>{const u=new URL(r.request().url());if(u.pathname==='/api/me')return r.fulfill({status:401,json:{}});if(u.pathname==='/')return r.fulfill({contentType:'text/html',body:html});return r.fulfill({status:404,body:''})});
 await pg.goto('http://x.test/');await pg.evaluate(d=>localStorage.setItem('tp_data',JSON.stringify(d)),data);await pg.reload();
 const n=()=>pg.locator('.modal').count(),out=()=>pg.mouse.click(195,20),tap=()=>pg.touchscreen.tap(195,20);const r=[];
 await pg.click('[data-open]');await pg.click('.tabs button:nth-child(4)');
 await pg.click('#addEx');r.push(['open',await n()]);await pg.click('.sheet h2');r.push(['tap inside sheet',await n()]);await out();r.push(['tap outside, untouched',await n()]);
 await pg.click('#addEx');await pg.fill('[name=desc]','Lunch');await out();r.push(['outside after typing (1st)',await n(),await pg.locator('#mErr').innerText()]);await out();r.push(['outside again',await n()]);
 r.push(['nothing saved',await pg.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem('tp_data')).expenses).length)]);
 await pg.click('#addEx');await pg.fill('[name=desc]','x');await out();await pg.waitForTimeout(4200);await out();r.push(['after 4s warning resets',await n()]);await out();r.push(['then closes',await n()]);
 await pg.click('#addEx');await tap();r.push(['touch tap outside',await n()]);
 await pg.click('#addEx');const box=await pg.locator('.sheet input[name=desc]').boundingBox();await pg.mouse.move(box.x+10,box.y+10);await pg.mouse.down();await pg.mouse.move(195,20);await pg.mouse.up();r.push(['drag from inside to outside stays open',await n()]);
 await pg.keyboard.press('Escape');r.push(['Escape',await n()]);
 await pg.click('#addEx');await pg.fill('[name=desc]','Dinner');await pg.fill('[name=amt]','10');await pg.fill('[name=ccy]','SGD');await pg.click('#mOk');r.push(['save still works',await n(),await pg.evaluate(()=>Object.values(JSON.parse(localStorage.getItem('tp_data')).expenses).map(e=>e.desc).join())]);
 await pg.click('#edTrip');await pg.click('#mDel');await out();r.push(['delete armed, outside closes, trip kept',await n(),await pg.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem('tp_data')).trips).length)]);
 await pg.click('.tabs button:nth-child(1)');await pg.click('#addAct');await pg.selectOption('[name=bk]','tobook');await out();r.push(['select change counts as edit',await n()]);await out();
 console.log('errors:',errs.length?errs:'none');r.forEach(x=>console.log(JSON.stringify(x)));await b.close()})();
