/* Verifies the v12.2 workflow UX + persistence fixes against the live DOM. */
const fs=require('fs'), path=require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { MockDB, uuid } = require('./mockdb');
const SB='https://vuwdhcyiifyarveeqlwz.supabase.co';

const db=new MockDB();
let html=fs.readFileSync(path.join(__dirname,'..','fixed','index.html'),'utf8')
  .replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*"><\/script>/g,'');
html=html.replace('<head>','<head>'+`<script>
window.__readyGate=new Promise(r=>{window.__signalReady=r});
window.XLSX={read(){return{}},utils:{}};
window.supabase={createClient(){return{auth:{
 async getSession(){await window.__readyGate;return{data:{session:window.__session}}},
 onAuthStateChange(){return{data:{subscription:{unsubscribe(){}}}}},
 async signInWithPassword(){return{data:{session:window.__session},error:null}},
 async signOut(){return{error:null}}}}}};
window.fetch=function(){return window.__nodeFetch.apply(null,arguments)};
window.print=function(){};window.alert=function(){};window.confirm=function(){return true};
window.prompt=function(){return ''};window.scrollTo=function(){};
</script>`);
const vc=new VirtualConsole(); const errs=[]; vc.on('jsdomError',e=>errs.push(String(e.message||e)));
const dom=new JSDOM(html,{runScripts:'dangerously',url:'https://mdama.local/',pretendToBeVisual:true,virtualConsole:vc});
const w=dom.window;
w.__session={access_token:'t',user:{id:uuid(),email:'d@d.local'}};
w.Element.prototype.scrollIntoView=function(){};
w.HTMLElement.prototype.focus=function(){};
if(!w.crypto)w.crypto={}; w.crypto.randomUUID=()=>uuid();
w.CSS=w.CSS||{}; w.CSS.escape=s=>String(s).replace(/[^a-zA-Z0-9_-]/g,c=>'\\'+c);
w.requestAnimationFrame=cb=>setTimeout(cb,0);
const mk=(st,b)=>({ok:st<300,status:st,text:async()=>JSON.stringify(b),json:async()=>b,headers:{get:()=>null}});
w.__nodeFetch=async(url,opt={})=>{
  url=String(url); const m=(opt.method||'GET').toUpperCase();
  let body=null; try{body=opt.body?JSON.parse(opt.body):null}catch{}
  if(url.startsWith(SB+'/rest/v1')){
    try{const r=db.handle(m,url.slice((SB+'/rest/v1').length),body,opt.headers||{});return mk(r.status,r.body);}
    catch(e){return mk(400,{message:e.message});}
  }
  if(/ai-assist/.test(url))return mk(200,{error:'AI unavailable'});
  if(url.startsWith(SB+'/storage/v1'))return mk(200,{signedURL:'/demo'});
  if(/zippopotam/.test(url))return mk(200,{places:[{latitude:'40.7',longitude:'-73.9','place name':'NY','state abbreviation':'NY'}]});
  return mk(200,{});
};
const TECH=uuid();
db.tables.technicians.push({id:TECH,name:'Demo Tech',phone:'2125550134',normalized_phone:'2125550134',
  primary_trade:'HVAC',city:'New York',state:'NY',zip_code:'10001',active:true,hiring_profile:{}});
db.tables.profiles.push({id:w.__session.user.id,email:'d@d.local',role:'admin',active:true});

const wait=ms=>new Promise(r=>setTimeout(r,ms));
const $=id=>w.document.getElementById(id);
const set=(id,val)=>{const e=$(id);if(e)e.value=val;return Boolean(e);};
let pass=0,fail=0;
const chk=(id,ok,detail='')=>{ok?pass++:fail++;console.log(`  ${ok?'PASS':'FAIL'}  ${id}${detail?'  — '+detail:''}`);};

(async()=>{
  w.__signalReady(); await wait(600);

  set('raw',`Work Order #: WO-V122
Store: TargetMart
Address: 350 5th Ave, New York, NY 10118
Trade: HVAC
NTE: $1200
Description: Walk-in cooler not holding temperature.`);
  await w.analyze(); await wait(400);
  await w.saveWO(); await wait(400);
  const wo=db.tables.work_orders[0];
  await w.req('/work_orders?id=eq.'+wo.id,{method:'PATCH',headers:{Prefer:'return=minimal'},
    body:JSON.stringify({assigned_technician_id:TECH,status:'arrived',workflow_stage:'arrived'})});
  Object.assign(wo,{assigned_technician_id:TECH,status:'arrived',workflow_stage:'arrived'});
  await w.openWorkflow(wo.id); await wait(400);
  Object.assign(w.eval('wos')[0],wo);

  console.log('\n--- ISSUE 1: Fast-Hire booking button is no longer highlighted ---');
  const styleEl=$('mdamaV122Styles');
  chk('1a v12.2 stylesheet injected',Boolean(styleEl));
  chk('1b .fast-hire-btn gradient neutralised',
    Boolean(styleEl)&&/\.fast-hire-btn\{[^}]*background-image:none/.test(styleEl.textContent),
    'gradient + purple glow overridden to a neutral button');

  console.log('\n--- ISSUE 2: per-field validation names AND marks the field ---');
  w.eval('workflowStageView="arrival"'); w.renderStageContent(); await wait(150);
  let r=w.validateStageV122('arrival');
  // date+time are pre-filled with "now" by modernDateTimeHtml, so only the photo is genuinely missing
  chk('2a arrival reports the genuinely missing field',
    r.missing.length===1&&/Arrival Photo/.test(r.missing[0]),JSON.stringify(r.missing));
  chk('2b the offending field is marked in the DOM',
    w.document.querySelectorAll('.v122-invalid').length>0,
    w.document.querySelectorAll('.v122-invalid').length+' field(s) marked red');
  chk('2c an inline message names the field',
    Boolean(w.document.querySelector('.v122-field-msg')),
    (w.document.querySelector('.v122-field-msg')?.textContent)||'');
  // now satisfy them and re-check
  set('a_time_date','2026-08-22'); set('a_time_time','10:00');
  const addFile=(stage,type,n,ref=null)=>{for(let i=0;i<n;i++){const rec={id:uuid(),work_order_id:wo.id,stage,
    file_type:type,item_ref:ref,storage_path:`${wo.id}/${stage}/${type}${i}.jpg`,file_name:`${type}${i}.jpg`,
    created_at:new Date().toISOString()};db.tables.work_order_files.push(rec);w.eval('woFiles').push(rec);}};
  addFile('arrival','arrival_photo',1);
  r=w.validateStageV122('arrival');
  chk('2d passes once the fields are filled',r.ok,JSON.stringify(r.missing));

  console.log('\n--- ISSUE 8: save shows a visible confirmation ---');
  await w.saveArrival(true); await wait(300);
  const toast=$('v122Toast');
  chk('8a toast element created on save',Boolean(toast));
  chk('8b toast is visible and reports success',
    Boolean(toast)&&/show/.test(toast.className)&&!/err/.test(toast.className),
    `"${toast?.textContent}"`);
  chk('8c arrival actually persisted',
    db.tables.work_order_stage_data.find(x=>x.stage==='arrival')?.completed===true);

  console.log('\n--- ISSUE 2b: a blocked save reports every missing diagnosis field ---');
  w.eval('workflowStageView="diagnosis"'); w.renderDiagnosis(); await wait(200);
  await w.saveDiagnosis(true); await wait(250);
  const notice=($('workflowNotice')?.textContent||'');
  chk('2e diagnosis gate lists the fields by name',
    /required field/i.test(notice)&&/Exact problem/i.test(notice)&&/Before Photos/i.test(notice),
    notice.replace(/\s+/g,' ').slice(0,120));
  chk('2f the save was blocked, not silently completed',
    !db.tables.work_order_stage_data.find(x=>x.stage==='diagnosis')?.completed);

  console.log('\n--- ISSUE 7: Materials + Other Special Fees now exist in Diagnosis ---');
  chk('7a Materials section rendered in Diagnosis',Boolean($('d_materials')));
  chk('7b Other Special Fees section rendered in Diagnosis',Boolean($('d_fees')));
  const order=[...w.document.querySelectorAll('#stageContent h2')].map(h=>h.textContent.trim());
  const idx=n=>order.findIndex(x=>x.replace(/\s*\d+\s*$/,'').trim().toLowerCase()===n.toLowerCase());
  chk('7c order matches the Quote stage (Parts → Materials → Equipment → Fees)',
    idx('Parts & materials')<idx('Materials')&&idx('Materials')<idx('Equipment')&&idx('Equipment')<idx('Other Special Fees'),
    order.filter(x=>/Parts|Materials|Equipment|Special Fees/i.test(x)).join(' → '));

  console.log('\n--- ISSUE 3: every visible field is persisted on Save ---');
  w.addDiagnosisItemV122('materials'); await wait(150);
  w.addDiagnosisItemV122('shipping'); await wait(150);
  const matCard=w.document.querySelector('.diag-item[data-kind="materials"]');
  matCard.querySelector('[data-k="name"]').value='Copper pipe 3/4"';
  matCard.querySelector('[data-k="quantity"]').value='6';
  matCard.querySelector('[data-k="unit_price"]').value='12.50';
  const feeCard=w.document.querySelector('.diag-item[data-kind="shipping"]');
  feeCard.querySelector('[data-k="name"]').value='City permit';
  feeCard.querySelector('[data-k="amount"]').value='85';
  set('d_problem','Condenser fan motor seized.');
  set('d_plan','Replace condenser fan motor.');
  set('d_tech_cost','450');
  addFile('diagnosis','before_photo',4);
  await w.saveDiagnosis(true); await wait(350);
  const saved=db.tables.work_order_stage_data.find(x=>x.stage==='diagnosis')?.data||{};
  chk('3a diagnosis completed after all fields were supplied',
    db.tables.work_order_stage_data.find(x=>x.stage==='diagnosis')?.completed===true,
    ($('workflowNotice')?.textContent||'').slice(0,100));
  chk('3b Materials row persisted with its values',
    (saved.materials||[]).length===1&&saved.materials[0].name==='Copper pipe 3/4"'
      &&Number(saved.materials[0].unit_price)===12.5,
    JSON.stringify(saved.materials));
  chk('3c Other Special Fee row persisted with its values',
    (saved.shipping||[]).length===1&&Number(saved.shipping[0].amount)===85,
    JSON.stringify(saved.shipping));

  console.log('\n--- ISSUE 7b: the new Diagnosis rows flow into the Quote builder ---');
  const q=w.quoteBuilderDefaults(wo,saved,{});
  chk('7d Materials carried into the Quote calculator',
    (q.materials||[]).length===1&&/Copper pipe/.test(q.materials[0].description||'')
      &&Number(q.materials[0].unit_cost)===12.5&&Number(q.materials[0].quantity)===6,
    JSON.stringify(q.materials));
  chk('7e Special fees carried into the Quote calculator',
    (q.shipping||[]).length===1&&Number(q.shipping[0].amount)===85,
    JSON.stringify(q.shipping));

  console.log('\n--- jsdom errors ---');
  console.log(errs.length?[...new Set(errs)].slice(0,5).join('\n'):'none');
  console.log(`\n================  ${pass} passed / ${fail} failed  ================`);
})();
