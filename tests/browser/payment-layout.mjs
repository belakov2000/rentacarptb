// Layout-only fixture. No live backend, email, or payment gateway is contacted.
import {chromium} from 'playwright-core';
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
const html=readFileSync('index.html','utf8'),out='test-artifacts/payment-layout';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 for(const [width,lang] of [[1440,'bg'],[390,'bg'],[390,'ru'],[320,'ru']]){
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.hostname!=='localhost')return route.abort();
   if(u.pathname==='/api/availability')return route.fulfill({json:{cardPayment:true,cars:{},buffer:60}});
   if(u.pathname==='/api/quote')return route.fulfill({json:{quote:'e'.repeat(64),version:'layout-fixture',expiresAt:new Date(Date.now()+1800000).toISOString(),days:2,totalCents:5000,depositCents:10000,lines:[{code:'rent',cents:5000,unitCents:2500}],legs:{del:null,ret:null}}});
   if(u.pathname.startsWith('/api/'))throw Error('Unexpected API request in layout fixture: '+u.pathname);
   if(u.pathname.startsWith('/images/')&&existsSync('.'+u.pathname))return route.fulfill({path:'.'+u.pathname});
   if(u.pathname==='/'||/^\/(ru|en|de)\/$/.test(u.pathname))return route.fulfill({contentType:'text/html',body:html});
   return route.abort();
  });
  await page.addInitScript(()=>{
   localStorage.setItem('lang','de');
   localStorage.setItem('cookie-consent',JSON.stringify({v:2,necessary:true,marketing:false,date:new Date().toISOString()}));
   sessionStorage.setItem('req',JSON.stringify({car:'golf',d1:'2028-03-06',d2:'2028-03-08',t1:'10:00',t2:'10:00',m1:'office',m2:'office',open:true}));
  });
  await page.goto('http://localhost/'+(lang==='bg'?'':lang+'/')+'#avtomobili');
  await page.locator('#card-choice').waitFor({state:'visible'});
  await page.locator('input[name=pay2][value=card]').check();
  await page.locator('#card-choice img[alt=Visa]').evaluate(e=>e.decode());
  await page.locator('#card-choice img[alt=Mastercard]').evaluate(e=>e.decode());
  assert.equal(await page.locator('html').getAttribute('lang'),lang);
  const bounds=await page.locator('.bar .lang').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width,'Language buttons fit '+width);
  if(width<=900){const b=await page.locator('#burger').boundingBox();assert.ok(b.x+b.width<=width,'Mobile menu fits '+width)}
  const form=await page.locator('#bk').boundingBox();assert.ok(form.x>=0&&form.x+form.width<=width+1,'Booking form fits '+width);
  const methods=await page.locator('#bk .fb-pay .payopts').boundingBox();assert.ok(methods.x>=0&&methods.x+methods.width<=width+1,'Payment options fit '+width);
  assert.ok(!await page.locator('#card-choice').textContent().then(t=>t.includes('RENTY10')));
  await page.locator('#bk .fb-pay').screenshot({path:out+'/'+lang+'-'+width+'.png'});
  await page.locator('header').screenshot({path:out+'/'+lang+'-'+width+'-header.png'});
  await page.locator('#b-company').check();assert.equal(await page.locator('#inv').isVisible(),true);assert.equal(await page.locator('input[name=pay2][value=card]').isChecked(),true);
  assert.deepEqual(errors,[]);await page.close();console.log('PASS layout '+lang+' '+width);
 }
}finally{await browser.close()}
