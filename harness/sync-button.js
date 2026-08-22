/* Tests the ACTUAL SYNCHRONIZE button: stale-handler fix, confirm dialog, two-way parity. */
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
const w=new JSDOM(html,{runScripts:'dangerously',url:'https://m.local/',pretendToBeVisual:true,virtualConsole:vc}).window;
w.__session={access_token:'t',user:{id:uuid(),email:'d@d'}};
w.Element.prototype.scrollIntoView=function(){};w.HTMLElement.prototype.focus=function(){};
if(!w.crypto)w.crypto={};w.crypto.randomUUID=()=>uuid();
w.CSS={escape:s=>String(s).replace(/[^a-zA-Z0-9_-]/g,c=>'\\'+c)};w.requestAnimationFrame=cb=>setTimeout(cb,0);
const mk=(st,b)=>({ok:st<300,status:st,text:async()=>JSON.stringify(b),json:async()=>b,headers:{get:()=>null}});
w.__nodeFetch=async(u,o={})=>{u=String(u);const m=(o.method||'GET').toUpperCase();let b=null;try{b=o.body?JSON.parse(o.body):null}catch{}
  if(u.startsWith(SB+'/rest/v1')){try{const r=db.handle(m,u.slice((SB+'/rest/v1').length),b,o.headers||{});return mk(r.status,r.body)}catch(e){return mk(400,{message:e.message})}}
  if(/ai-assist/.test(u))return mk(200,{error:'x'});if(u.startsWith(SB+'/storage'))return mk(200,{signedURL:'/d'});
  if(/zippopotam/.test(u))return mk(200,{places:[{latitude:'40',longitude:'-73','place name':'NY','state abbreviation':'NY'}]});return mk(200,{})};
const TECH=uuid();
db.tables.technicians.push({id:TECH,name:'T',phone:'2125550134',normalized_phone:'2125550134',primary_trade:'HVAC',city:'New York',state:'NY',zip_code:'10001',active:true,hiring_profile:{}});
db.tables.profiles.push({id:w.__session.user.id,role:'admin',active:true});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const $=id=>w.document.getElementById(id);
let pass=0,fail=0; const chk=(id,ok,d='')=>{ok?pass++:fail++;console.log(`  ${ok?'PASS':'FAIL'}  ${id}${d?'  — '+d:''}`);};
const diagData=woId=>db.tables.work_order_stage_data.find(r=>r.stage==='diagnosis'&&r.work_order_id===woId)?.data||{};
const apprData=woId=>db.tables.work_order_stage_data.find(r=>r.stage==='approval'&&r.work_order_id===woId)?.data||{};

(async()=>{
  w.__signalReady(); await wait(600);
  const wo={id:uuid(),wo_number:'WO-BTN',store_name:'S',city:'New York',state:'NY',
    assigned_technician_id:TECH,status:'diagnosis',workflow_stage:'diagnosis',trade:'HVAC',sow:'x'};
  db.tables.work_orders.push(wo); w.eval('wos').push(wo);
  const now=Date.now();
  const diag={work_order_id:wo.id,stage:'diagnosis',completed:true,updated_at:new Date(now-60000).toISOString(),data:{
    exact_problem:'p',repair_plan:'r',
    parts:[{id:'P1',part_trade:'HVAC Part',part_type:'Compressor',name:'Fan motor',brand_model:'X',specs:'1/4hp',quantity:1,unit_price:200,sales_tax:16}],
    equipment:[],materials:[],shipping:[],technician_total_cost:450,helper_total_cost:0,incurred_items:[]}};
  db.tables.work_order_stage_data.push(diag); w.eval('stageRows').push(JSON.parse(JSON.stringify(diag)));

  await w.openWorkflow(wo.id); await wait(300);
  w.eval('workflowStageView="approval"'); w.renderStageContent(); await wait(300);

  console.log('\n--- the Quote-stage SYNCHRONIZE button exists and is re-bound by v12.5 ---');
  const btn=$('quoteSynchronizeBtn');
  chk('B1 quote SYNCHRONIZE button present',Boolean(btn));
  chk('B2 button re-bound by v12.5 (not the stale v11.36 handler)',Boolean(btn)&&btn.dataset.v125Bound==='1',
    'dataset.v125Bound='+(btn?.dataset.v125Bound));

  console.log('\n--- add Material + Equipment + Fee in the QUOTE, then CLICK the button ---');
  w.addQuoteLine('materials'); w.addQuoteLine('equipment'); w.addQuoteLine('shipping'); await wait(120);
  const setLine=(kind,idx,map)=>{const c=[...w.document.querySelectorAll(`.quote-line[data-qkind="${kind}"]`)][idx];if(!c)return;for(const[k,val] of Object.entries(map)){const el=c.querySelector(`[data-qk="${k}"]`);if(el)el.value=val;}};
  setLine('materials',0,{description:'Refrigerant R448A',quantity:2,unit_cost:45});
  setLine('equipment',0,{description:'Recovery machine',quantity:1,unit_cost:120});
  setLine('shipping',0,{description:'Disposal fee',amount:60});

  // simulate the real click
  btn.click(); await wait(120);

  console.log('\n--- confirmation dialog must appear before anything is written ---');
  const dlg=$('v125SyncConfirm');
  chk('C1 confirm dialog shown on click',Boolean(dlg));
  chk('C2 nothing written to Diagnosis until confirmed',
    (diagData(wo.id).materials||[]).length===0,'materials before confirm='+JSON.stringify(diagData(wo.id).materials||[]));
  const goBtn=$('v125SyncGo');
  chk('C3 dialog names the winning side (Quote)',Boolean(goBtn)&&/Quote\s*→/.test(goBtn.textContent||''),goBtn?.textContent);

  console.log('\n--- confirm -> two-way sync runs ---');
  goBtn.click(); await wait(400);

  const d=diagData(wo.id), a=apprData(wo.id).quote_builder||{};
  console.log('   Diagnosis:',JSON.stringify({parts:(d.parts||[]).map(x=>x.name),materials:(d.materials||[]).map(x=>x.name),equipment:(d.equipment||[]).map(x=>x.name),shipping:(d.shipping||[]).map(x=>x.name||x.description)}));
  console.log('   Quote    :',JSON.stringify({parts:(a.parts||[]).map(x=>x.description),materials:(a.materials||[]).map(x=>x.description),equipment:(a.equipment||[]).map(x=>x.description),shipping:(a.shipping||[]).map(x=>x.description)}));

  chk('S1 Material now in Diagnosis',(d.materials||[]).some(x=>/Refrigerant/.test(x.name||'')),JSON.stringify(d.materials||[]));
  chk('S2 Other Special Fee now in Diagnosis',(d.shipping||[]).some(x=>/Disposal/.test(x.name||x.description||'')),JSON.stringify(d.shipping||[]));
  chk('S3 Equipment now in Diagnosis',(d.equipment||[]).some(x=>/Recovery/.test(x.name||'')));

  // PARITY: both stages hold the same set of descriptions
  const norm=arr=>(arr||[]).map(x=>String(x.name||x.description||'').trim()).filter(Boolean).sort();
  const same=(x,y)=>JSON.stringify(x)===JSON.stringify(y);
  chk('S4 Parts parity Diagnosis==Quote',same(norm(d.parts),norm(a.parts)),`${JSON.stringify(norm(d.parts))} vs ${JSON.stringify(norm(a.parts))}`);
  chk('S5 Materials parity',same(norm(d.materials),norm(a.materials)),`${JSON.stringify(norm(d.materials))} vs ${JSON.stringify(norm(a.materials))}`);
  chk('S6 Equipment parity',same(norm(d.equipment),norm(a.equipment)),`${JSON.stringify(norm(d.equipment))} vs ${JSON.stringify(norm(a.equipment))}`);
  chk('S7 Fees parity',same(norm(d.shipping),norm(a.shipping)),`${JSON.stringify(norm(d.shipping))} vs ${JSON.stringify(norm(a.shipping))}`);

  console.log('\n--- reverse: edit DIAGNOSIS newer, sync from the Diagnosis button -> Quote matches ---');
  // make diagnosis the newest edit and remove the material there
  const dr=db.tables.work_order_stage_data.find(r=>r.stage==='diagnosis'&&r.work_order_id===wo.id);
  dr.data.materials=[]; dr.updated_at=new Date(Date.now()+60000).toISOString();
  w.eval('stageRows').find(r=>r.stage==='diagnosis'&&r.work_order_id===wo.id).data=JSON.parse(JSON.stringify(dr.data));
  w.eval('stageRows').find(r=>r.stage==='diagnosis'&&r.work_order_id===wo.id).updated_at=dr.updated_at;
  // go to diagnosis stage so its button renders, and it's not "live quote"
  w.eval('workflowStageView="diagnosis"'); w.renderStageContent(); await wait(200);
  const dbtn=$('diagnosisSynchronizeBtn')||[...w.document.querySelectorAll('#stageContent button')].find(b=>/^\s*synchronize\s*$/i.test(b.textContent||''));
  chk('R0 Diagnosis SYNCHRONIZE button present & bound',Boolean(dbtn)&&dbtn.dataset.v125Bound==='1');
  if(dbtn){ dbtn.click(); await wait(120); const g=$('v125SyncGo'); if(g){g.click(); await wait(400);} }
  const a2=apprData(wo.id).quote_builder||{};
  chk('R1 Quote material removed to match Diagnosis',(a2.materials||[]).length===0,JSON.stringify((a2.materials||[]).map(x=>x.description)));

  console.log('\n  jsdom errors:',errs.length?[...new Set(errs)].slice(0,4).join(' | '):'none');
  console.log(`\n================  ${pass} passed / ${fail} failed  ================`);
})();
