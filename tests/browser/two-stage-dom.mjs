// DOM/API regression for environments without a native browser. Uses real server functions and test SQL.
// npm install --no-save happy-dom embedded-postgres@17.5.0-beta.15 esbuild
// TEST_USE_PGLITE=1 node tests/e2e/run.mjs tests/browser/two-stage-dom.mjs
// Does not verify layout, real touch/camera access or external maps.
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
const B=process.argv[2]; if(!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(B||'')) throw Error('Local test server required');
const html=readFileSync('index.html','utf8');let passed=0;
const check=(name,value)=>{console.log(`${value?'PASS':'FAIL'} | ${name}`);if(!value)throw Error(name);passed++};
const poll=async(fn)=>{for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,40));}throw Error('Timed out')};
const windows=[];
try {
for(const lang of ['bg','en','de']){
 const w=new Window({url:B+(lang==='bg'?'/':'/'+lang+'/')+'#avtomobili',settings:{enableJavaScriptEvaluation:true,disableJavaScriptFileLoading:true,disableCSSFileLoading:true,disableIframePageLoading:true,suppressInsecureJavaScriptEnvironmentWarning:true,timer:{maxIntervalIterations:3}}});windows.push(w);
 const errors=[];w.addEventListener('error',e=>errors.push(e.message));
 w.HTMLElement.prototype.scrollIntoView=function(){};w.scrollTo=()=>{};
 w.localStorage.setItem('cookie-consent',JSON.stringify({v:2,necessary:true,marketing:false,date:new Date().toISOString()}));
 w.sessionStorage.setItem('req',JSON.stringify({car:'golf',d1:({'bg':'2028-03-06','en':'2028-03-13','de':'2028-03-20'})[lang],t1:'10:00',d2:({'bg':'2028-03-08','en':'2028-03-15','de':'2028-03-22'})[lang],t2:'10:00',m1:'office',m2:'office',open:true}));
 w.fetch=(url,opts)=>{const u=new URL(String(url),B);if(u.origin!==B)return Promise.resolve(new Response('',{status:200}));return fetch(u,opts)};
 w.document.write(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''));
 const scripts=[];
 for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)){
  if(/src=|application\/ld\+json/.test(m[1])||!m[2].trim())continue;
  let code=m[2];if(code.includes('function shortFormError')){code+=';window.__test={shortFormError,shortSync,S,Q,qKey,formErr,renderDocs,renderThanks,DOCS};'}
  scripts.push(code);
 }
 w.eval(scripts.join('\n;\n'));
 const $=s=>w.document.querySelector(s),fill=(s,v)=>{const e=$(s);e.value=v;e.dispatchEvent(new w.Event('input',{bubbles:true}));e.dispatchEvent(new w.Event('change',{bubbles:true}));};
 check(lang+': script initialises',!!w.__test&&errors.length===0);
 check(lang+': no initial document fields',[...w.document.querySelectorAll('#bk [data-flow1]')].every(e=>e.hidden));
 check(lang+': phone country defaults to BG',$('#b-phone-country').value==='BG'&&$('#b-phone-country').options.length>200);
 check(lang+': marketing consent unchecked',!$('#b-mkt').checked);
 for(const [id,v]of Object.entries({'#b-first':'ТЕСТ','#b-middle':'Петров','#b-last':'Иванов','#b-mail':'dom-'+lang+'@example.com','#b-mail-confirm':'wrong@example.com','#b-phone-local':'877123456','#b-bday':'1','#b-bmonth':'1','#b-byear':'1990'}))fill(id,v);
 check(lang+': mismatching emails blocked',!!w.__test.shortFormError()&&$('#b-mail-confirm').getAttribute('aria-invalid')==='true');
 fill('#b-mail-confirm','dom-'+lang+'@example.com');
 check(lang+': completed basic contact valid',w.__test.shortFormError()==='');
 fill('#b-bday','31');fill('#b-bmonth','2');check(lang+': impossible birth date blocked',!!w.__test.shortFormError());fill('#b-bday','1');fill('#b-bmonth','1');
 $('input[name=rdrv][value="0"]').checked=true;w.__test.shortSync();check(lang+': different driver requires names',!!w.__test.shortFormError()&&!$('#main-driver-names').hidden);
 for(const k of ['first','middle','last'])fill('#b-d'+k,'Тест');
 check(lang+': different sole driver is valid without second driver',w.__test.shortFormError()===''&&!$('#b-sd').checked);
 $('input[name=pay2][value=bankp]').checked=true;$('input[name=pay2][value=bankp]').dispatchEvent(new w.Event('change',{bubbles:true}));
 check(lang+': ordinary bank transfer does not require company',w.__test.shortFormError()===''&&$('#inv').hidden);
 $('#b-company').checked=true;$('#b-company').dispatchEvent(new w.Event('change',{bubbles:true}));check(lang+': company invoice conditional',!$('#inv').hidden&&!!w.__test.shortFormError());
 fill('#b-ivat','BG123456789');fill('#b-icn','ТЕСТ');fill('#b-ieik','123456789');fill('#b-iaddr','Тест 1');
 check(lang+': valid company contact',w.__test.shortFormError()==='');
 $('#b-no-vat').checked=true;$('#b-no-vat').dispatchEvent(new w.Event('change',{bubbles:true}));check(lang+': non-VAT company does not require VAT',w.__test.shortFormError()===''&&$('#b-ivat').disabled);
 $('#b-company').checked=false;$('#b-company').dispatchEvent(new w.Event('change',{bubbles:true}));
 $('input[name=pay2][value=cash]').checked=true;$('input[name=pay2][value=cash]').dispatchEvent(new w.Event('change',{bubbles:true}));$('#b-ok').checked=true;
 await poll(()=>w.__test.Q.st==='ok');check(lang+': full form valid with server quote',w.__test.formErr()==='');
 $('#bk').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await poll(()=>w.location.hash==='#blagodarim');
 const rows=await(await fetch(B+'/__e2e/sql?q='+encodeURIComponent("select id,stage,name,phone,drivers,admin_token,view_token from bookings where email='dom-"+lang+"@example.com'"))).json();
 check(lang+': initial submission saved real server/SQL',rows.length===1&&rows[0].stage==='request'&&rows[0].name==='ТЕСТ Петров Иванов'&&rows[0].phone==='+359877123456'&&rows[0].drivers.requester.birthDate==='1990-01-01');
 const bk=rows[0];
 const manage=B+'/api/bookings/'+bk.id+'/manage?key='+bk.admin_token;
 await fetch(manage);let row=await(await fetch(B+'/api/bookings/'+bk.id+'?t='+bk.view_token)).json();check(lang+': opening owner link does not approve',row.stage==='request');
 await fetch(manage,{method:'POST',body:new URLSearchParams({action:'confirm'})});
 row=await(await fetch(B+'/api/bookings/'+bk.id+'?t='+bk.view_token)).json();check(lang+': first approval invites documents',row.stage==='docs');
 w.__test.S.view=row;w.__test.S.bst=row.status;w.__test.renderThanks();
 check(lang+': documents form present without repeated payment',!!$('#docs-f')&&!$('#docs-f [name=pay]'));
 $('#docs-f').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));check(lang+': missing documents blocked',!$('#d-err').hidden);
 for(const[k,v]of Object.entries({name:'ТЕСТ Основен Водач',citizen:'България',idn:'TEST111',egn:'8001010001',idd:'2020-01-01',idp:'МВР ТЕСТ',region:'Пловдив',municipality:'Пловдив',city:'Пловдив',addr:'ул. Тест 1',dln:'TESTDL',dld:'2021-02-02',dlp:'МВР ТЕСТ'}))fill('#d0-'+k,v);
 $('input[name="d0-pt"][value=city]').checked=true;
 const pixels=Buffer.alloc(640*400*4,125),image=Buffer.from(jpeg.encode({data:pixels,width:640,height:400},75).data);
 // Already processed JPEGs: this tests upload/submission, not native camera/canvas processing.
 for(const k of ['idf','idb','dlf','dlb'])w.__test.DOCS.ph['0-'+k]=image;
 $('#docs-f').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));check(lang+': document consent required before upload',!$('#d-err').hidden&&!w.__test.DOCS.busy);
 $('#d-consent').checked=true;$('#docs-f').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await poll(()=>w.__test.S.view?.stage==='review').catch(e=>{console.error('Document submission diagnostics', $('#d-err')?.textContent, $('#d-msg')?.textContent, errors);throw e});
 check(lang+': documents received and awaiting check',w.__test.S.view.stage==='review'&&$('#th-docs').hidden);
 await fetch(manage,{method:'POST',body:new URLSearchParams({action:'confirm'})});row=await(await fetch(B+'/api/bookings/'+bk.id+'?t='+bk.view_token)).json();
 w.__test.S.view=row;w.__test.S.bst=row.status;w.__test.renderThanks();check(lang+': second approval confirms reservation',row.stage==='done'&&row.status==='confirmed');
 await w.happyDOM.close();
}
console.log(`TOTAL: ${passed} PASS, 0 FAIL`);
}finally{for(const w of windows)await w.happyDOM.close()}
