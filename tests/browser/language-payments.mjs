// Offline DOM regression: no live reservation, email, or bank gateway is contacted.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Window} from 'happy-dom';
const html=readFileSync('index.html','utf8');
const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(m=>!/src=|application\/ld\+json/.test(m[1])&&m[2].trim()).map(m=>m[2]);
const windows=[];
let passed=0;
const check=(label,condition)=>{assert.ok(condition,label);passed++;console.log('PASS | '+label)};
try{
 for(const path of ['/','/en/','/de/','/ru/']){
  const w=new Window({url:'https://example.test'+path+'#avtomobili',settings:{enableJavaScriptEvaluation:true,disableJavaScriptFileLoading:true,disableCSSFileLoading:true,disableIframePageLoading:true,suppressInsecureJavaScriptEnvironmentWarning:true,timer:{maxIntervalIterations:2}}});windows.push(w);
  w.HTMLElement.prototype.scrollIntoView=function(){};w.scrollTo=()=>{};
  w.localStorage.setItem('lang','ru');
  w.localStorage.setItem('cookie-consent',JSON.stringify({v:2,necessary:true,marketing:false,date:new Date().toISOString()}));
  let payload;
  w.fetch=async(url,opts)=>{const u=new URL(String(url),'https://example.test');
   if(u.pathname==='/api/availability')return Response.json({cardPayment:true,cars:{},buffer:60});
   if(u.pathname==='/api/bookings'&&opts?.method==='POST'){payload=JSON.parse(opts.body);return Response.json({id:'a'.repeat(32),token:'b'.repeat(64),status:'pending'})}
   return Response.json({}, {status:404});
  };
  w.document.write(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''));
  const errors=[];w.addEventListener('error',e=>errors.push(e.message));
  w.eval(scripts.join('\n;\n')+';window.__p={setLang,tr,I18N,I18N_RULES,shortFormError,wantsInvoice,invText,sendBooking,S,Q};');
  await new Promise(r=>setTimeout(r,60));
  const $=s=>w.document.querySelector(s),api=w.__p;
  check(path+': no script errors',!errors.length);
  check(path+': language follows explicit path, root remains Bulgarian',w.document.documentElement.lang===(path==='/'?'bg':path.slice(1,-1)));
  check(path+': RU button available',!!$('[data-lang=ru]'));
  check(path+': card visible',!$('#card-choice').hidden);
  for(const lang of ['bg','en','de','ru','bg']){
   api.setLang(lang);await new Promise(r=>setTimeout(r,20));
   check(lang+': active language and path',w.document.documentElement.lang===lang&&w.location.pathname===(lang==='bg'?'/':'/'+lang+'/'));
   check(lang+': no promotion code in payment helper',!$('#card-choice').textContent.includes('RENTY10'));
   check(lang+': both brand images present',!!$('#card-choice img[alt=Visa]')&&!!$('#card-choice img[alt=Mastercard]'));
  }
  api.setLang('ru');
  check('Russian primary navigation',w.document.querySelector('#nav').textContent.includes('Главная'));
  check('Russian form validation',api.shortFormError()==='Укажите имя, отчество и фамилию.');
  check('Russian dynamic rule',api.tr('Моля, попълнете всички данни на водач 2.')==='Заполните все данные водителя 2.');
  check('Russian dictionary covers all existing translations',Object.values(api.I18N).every(v=>v.length===3&&typeof v[2]==='string'&&v[2].length>0));
  check('Russian rules complete',api.I18N_RULES.every(v=>v.length===4&&typeof v[3]==='string'));
  for(const pay of ['card','cash','bankp']){
   const input=$('input[name=pay2][value='+pay+']');input.checked=true;input.dispatchEvent(new w.Event('change',{bubbles:true}));
   check(pay+': invoice offered',!$('#company-choice').hidden);
   $('#b-company').checked=true;$('#b-company').dispatchEvent(new w.Event('change',{bubbles:true}));
   check(pay+': company fields visible',!$('#inv').hidden&&api.wantsInvoice());
   check(pay+': payment choice retained',input.checked);
   $('#b-company').checked=false;$('#b-company').dispatchEvent(new w.Event('change',{bubbles:true}));
   check(pay+': unchecked invoice fields hidden',$('#inv').hidden);
  }
  const r={company:true,pay:'card',icn:'ТЕСТ',ieik:'123456789',noVat:true,icountry:'България',iaddr:'Тест 1'};
  check('Card invoice summary preserved',api.invText(r).includes('Фирма: ТЕСТ'));
  check('Stale invoice details not included when unchecked',api.invText({...r,company:false})==='');
  Object.assign(api.S,r,{car:'golf',name:'Тест Петров Иванов',first:'Тест',middle:'Петров',last:'Иванов',phone:'+359877123456',mail:'test@example.com',mailConfirm:'test@example.com',d1:'2028-03-06',d2:'2028-03-08',t1:'10:00',t2:'10:00',m1:'office',m2:'office'});
  api.Q.d={quote:'e'.repeat(64),totalCents:5000,days:2,lines:[{code:'rent',cents:5000,unitCents:2500}],legs:{}};
  await api.sendBooking({});
  check('Card invoice request reaches API without changing payment',payload?.payment==='card'&&payload?.invoiceRequested===true&&payload?.invoiceData.name==='ТЕСТ');
  check('Chosen Russian language reaches API',payload?.lang==='ru');

 }
 console.log('TOTAL: '+passed+' PASS');
}finally{for(const w of windows)await w.happyDOM.close()}
