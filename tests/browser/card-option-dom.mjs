// DOM: опцията „Плащане с карта онлайн — 10% отстъпка от наема“ в кратката форма на трите езика.
// npm install --no-save happy-dom embedded-postgres@17.5.0-beta.15 esbuild
// TEST_USE_PGLITE=1 node tests/e2e/run.mjs tests/browser/card-option-dom.mjs
// Опцията се показва само когато сървърът отчете настроено плащане (/api/availability → cardPayment). Тук отговорът се подменя
// в браузъра; сървърната проверка (409 card_unavailable без настройки) е в tests/integration/card-payment.ts.
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
const B=process.argv[2]; if(!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(B||'')) throw Error('Local test server required');
const html=readFileSync('index.html','utf8');let passed=0;
const check=(name,value)=>{console.log(`${value?'PASS':'FAIL'} | ${name}`);if(!value)throw Error(name);passed++};
const poll=async(fn)=>{for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,40));}throw Error('Timed out')};
const TXT={bg:'Плащане с карта онлайн — 10% отстъпка от наема',en:'Online card payment — 10% off the rental',de:'Online-Kartenzahlung — 10 % Rabatt auf die Miete'};
const windows=[];
try{
for(const [lang,card] of [['bg',true],['en',true],['de',true],['bg',false]]){
 const w=new Window({url:B+(lang==='bg'?'/':'/'+lang+'/')+'#avtomobili',settings:{enableJavaScriptEvaluation:true,disableJavaScriptFileLoading:true,disableCSSFileLoading:true,disableIframePageLoading:true,suppressInsecureJavaScriptEnvironmentWarning:true,timer:{maxIntervalIterations:3}}});windows.push(w);
 const errors=[];w.addEventListener('error',e=>errors.push(e.message));
 w.HTMLElement.prototype.scrollIntoView=function(){};w.scrollTo=()=>{};
 w.localStorage.setItem('cookie-consent',JSON.stringify({v:2,necessary:true,marketing:false,date:new Date().toISOString()}));
 w.fetch=async(url,opts)=>{const u=new URL(String(url),B);if(u.origin!==B)return new Response('',{status:200});const r=await fetch(u,opts);
  if(u.pathname==='/api/availability'){const j=await r.json();return Response.json({...j,cardPayment:card})}return r};
 w.document.write(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''));
 const scripts=[];for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)){if(/src=|application\/ld\+json/.test(m[1])||!m[2].trim())continue;scripts.push(m[2])}
 w.eval(scripts.join('\n;\n'));
 const $=s=>w.document.querySelector(s);
 check(`${lang}/${card}: script initialises`,errors.length===0);
 if(!card){await new Promise(r=>setTimeout(r,300));check('bg: without configuration the card option stays hidden',$('#card-choice').hidden);continue}
 await poll(()=>!$('#card-choice').hidden);
 check(lang+': card option visible when configured',!$('#card-choice').hidden);
 check(lang+': option text translated',$('#card-choice b').textContent.trim()===TXT[lang]);
 check(lang+': explains deposit and no combination with RENTY10',/RENTY10/.test($('#card-choice small').textContent)&&/100 €/.test($('#card-choice small').textContent));
 check(lang+': cash option still offered',!!$('input[name=pay2][value=cash]'));
 const ci=$('input[name=pay2][value=card]');ci.checked=true;ci.dispatchEvent(new w.Event('change',{bubbles:true}));
 check(lang+': card selected hides company invoice choice',$('#company-choice').hidden&&$('#inv').hidden);
}
console.log(`\nОБЩО: ${passed} PASS, 0 FAIL`);
}finally{for(const w of windows)await w.happyDOM.close().catch(()=>{})}
