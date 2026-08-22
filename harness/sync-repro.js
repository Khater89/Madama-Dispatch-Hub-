/* Reproduces the Diagnosis <-> Incurred Payment Request sync behaviour. */
const fs=require('fs'), path=require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { MockDB, uuid } = require('./mockdb');
const SB='https://vuwdhcyiifyarveeqlwz.supabase.co';

function boot(file){
  const db=new MockDB();
  let html=fs.readFileSync(path.join(__dirname,'..',file),'utf8')
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
  return {w,db,TECH,errs,ready:async()=>{w.__signalReady();await new Promise(r=>setTimeout(r,600));}};
}

const wait=ms=>new Promise(r=>setTimeout(r,ms));

async function scenario(file,label){
  console.log(`\n############### ${label} (${file}) ###############`);
  const {w,db,TECH,errs}=boot(file);
  await w.__signalReady?.(); await wait(600);
  const $=id=>w.document.getElementById(id);
  const set=(id,val)=>{const e=$(id);if(e)e.value=val;return Boolean(e);};

  // build a booked WO through diagnosis
  set('raw',`Work Order #: WO-SYNC
Store: TargetMart
Address: 350 5th Ave, New York, NY 10118
Trade: HVAC
NTE: $1200
Description: Cooler warm.`);
  await w.analyze(); await wait(300); await w.saveWO(); await wait(300);
  const wo=db.tables.work_orders[0];
  await w.req('/work_orders?id=eq.'+wo.id,{method:'PATCH',headers:{Prefer:'return=minimal'},
    body:JSON.stringify({assigned_technician_id:TECH,status:'arrived',workflow_stage:'arrived'})});
  Object.assign(wo,{assigned_technician_id:TECH,status:'arrived',workflow_stage:'arrived'});
  await w.openWorkflow(wo.id); await wait(300);
  // keep the app's wos[0] as the canonical object; mirror our fields onto it and use it
  Object.assign(w.eval('wos')[0],wo);
  const appWo=w.eval('wos').find(x=>String(x.id)===String(wo.id))||w.eval('wos')[0];

  // seed a new_hiring record so strictHiringIdentityV1159 passes (a real booking has this)
  const hireRow={work_order_id:wo.id,stage:'new_hiring',completed:true,
    data:{technician_name:'Demo Tech',technician_phone:'2125550134'}};
  db.tables.work_order_stage_data.push(hireRow);
  w.eval('stageRows').push(JSON.parse(JSON.stringify(hireRow)));

  // seed a completed diagnosis with ONE incurred row, directly in the store
  const diagRow={work_order_id:wo.id,stage:'diagnosis',completed:true,
    data:{exact_problem:'x',repair_plan:'y',parts:[],equipment:[],materials:[],shipping:[],
      technician_total_cost:450,helper_total_cost:0,
      incurred_items:[{id:'INC-1',description:'Trip charge',amount:150}]}};
  db.tables.work_order_stage_data.push(diagRow);
  w.eval('stageRows').push(JSON.parse(JSON.stringify(diagRow)));

  const incPRs=()=>db.tables.payment_requests.filter(p=>{
    try{return (JSON.parse(p.structured_data?p.structured_data:'{}').created_from||p.structured_data?.created_from)==='diagnosis_incurred_auto';}
    catch{return p.structured_data?.created_from==='diagnosis_incurred_auto';}
  });
  const metaOf=p=>{const m=p.structured_data;return typeof m==='string'?JSON.parse(m):m||{};};

  console.log('\n[A] Diagnosis has 1 incurred row -> run sync');
  await w.syncDiagnosisIncurredPaymentRequests(wo.id); await wait(300);
  let prs=incPRs();
  console.log('    incurred PRs after 1st sync:',prs.length,
    prs.map(p=>`#${p.sequence_number} "${metaOf(p).description}" $${p.amount_due} inc_id=${metaOf(p).diagnosis_incurred_id}`));

  console.log('\n[B] ADD a 2nd incurred row in Diagnosis -> sync again (expect 2 PRs)');
  const dr=db.tables.work_order_stage_data.find(r=>r.stage==='diagnosis');
  dr.data.incurred_items.push({id:'INC-2',description:'Assessment labor',amount:200});
  const local=w.eval('stageRows').find(r=>r.stage==='diagnosis'); local.data=JSON.parse(JSON.stringify(dr.data));
  await w.syncDiagnosisIncurredPaymentRequests(wo.id); await wait(300);
  prs=incPRs();
  console.log('    incurred PRs after adding row:',prs.length,
    prs.map(p=>`"${metaOf(p).description}" $${p.amount_due}`));
  console.log('    RESULT B:',prs.length===2?'OK — both rows produced a PR':'BUG — expected 2 PRs, got '+prs.length);

  console.log('\n[C] EDIT the PR amount in the Incurred stage -> save -> expect Diagnosis row to change');
  const target=incPRs().find(p=>metaOf(p).diagnosis_incurred_id==='INC-1');
  if(!target){console.log('    cannot find INC-1 PR, skipping'); }
  else{
    // open through the REAL entry point so the app's internal paymentWOId / editingPaymentId bindings are set
    w.editCurrentIncurredPayment(target.id); await wait(150);
    set('pamount','175'); set('pdescription','Trip charge (revised)');
    if($('payform')){$('payform').dataset.fieldEditAt=String(Date.now());}
    const ok=await w.createPaymentRequest(); await wait(300);
    console.log('    paynotice:', ($('paynotice')?.textContent||'').trim().slice(0,120));
    const diagAfter=db.tables.work_order_stage_data.find(r=>r.stage==='diagnosis').data.incurred_items.find(x=>x.id==='INC-1');
    console.log('    save returned:',ok);
    console.log('    Diagnosis INC-1 now:',JSON.stringify(diagAfter));
    console.log('    RESULT C:',(diagAfter&&Number(diagAfter.amount)===175)?'OK — edit flowed back to Diagnosis':'BUG — Diagnosis row did NOT update ('+JSON.stringify(diagAfter)+')');
  }

  console.log('\n[D] EDIT Diagnosis amount -> sync -> expect PR to change to the newest value');
  const dr2=db.tables.work_order_stage_data.find(r=>r.stage==='diagnosis');
  const inc1=dr2.data.incurred_items.find(x=>x.id==='INC-1'); inc1.amount=300; inc1.description='Trip charge (from diagnosis)';
  w.eval('stageRows').find(r=>r.stage==='diagnosis').data=JSON.parse(JSON.stringify(dr2.data));
  await w.syncDiagnosisIncurredPaymentRequests(wo.id); await wait(300);
  const prAfter=incPRs().find(p=>metaOf(p).diagnosis_incurred_id==='INC-1');
  console.log('    PR INC-1 now: $'+prAfter?.amount_due+' "'+metaOf(prAfter).description+'"');
  console.log('    RESULT D:',(prAfter&&Number(prAfter.amount_due)===300)?'OK — Diagnosis edit flowed to the PR':'BUG — PR did NOT update to 300 (got '+prAfter?.amount_due+')');

  console.log('\n[E] DELETE an incurred row in Diagnosis -> sync -> expect its PR removed');
  const dr3=db.tables.work_order_stage_data.find(r=>r.stage==='diagnosis');
  dr3.data.incurred_items=dr3.data.incurred_items.filter(x=>x.id!=='INC-2');
  w.eval('stageRows').find(r=>r.stage==='diagnosis').data=JSON.parse(JSON.stringify(dr3.data));
  await w.syncDiagnosisIncurredPaymentRequests(wo.id); await wait(300);
  prs=incPRs();
  console.log('    incurred PRs after delete:',prs.length,prs.map(p=>metaOf(p).diagnosis_incurred_id));
  console.log('    RESULT E:',(prs.length===1&&metaOf(prs[0]).diagnosis_incurred_id==='INC-1')?'OK — deleted row PR removed':'BUG — expected only INC-1, got '+JSON.stringify(prs.map(p=>metaOf(p).diagnosis_incurred_id)));

  console.log('\n  jsdom errors:',errs.length?[...new Set(errs)].slice(0,3).join(' | '):'none');
  return {w,db};
}

(async()=>{
  await scenario('fixed/index.html','CURRENT (v12.2)');
})();
