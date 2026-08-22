/* Reproduces: fields added in the Quote stage do not appear in Diagnosis after sync. */
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
const set=(id,v)=>{const e=$(id);if(e)e.value=v;return Boolean(e);};
let pass=0,fail=0; const chk=(id,ok,d='')=>{ok?pass++:fail++;console.log(`  ${ok?'PASS':'FAIL'}  ${id}${d?'  — '+d:''}`);};

(async()=>{
  w.__signalReady(); await wait(600);
  const wo={id:uuid(),wo_number:'WO-QD',store_name:'S',city:'New York',state:'NY',
    assigned_technician_id:TECH,status:'diagnosis',workflow_stage:'diagnosis',trade:'HVAC',sow:'x'};
  db.tables.work_orders.push(wo); w.eval('wos').push(wo);
  // completed diagnosis with a part only (no materials/fees yet)
  const diag={work_order_id:wo.id,stage:'diagnosis',completed:true,data:{
    exact_problem:'p',repair_plan:'r',
    parts:[{id:'P1',part_trade:'HVAC Part',part_type:'Compressor',name:'Fan motor',brand_model:'X',specs:'1/4hp',quantity:1,unit_price:200,sales_tax:16}],
    equipment:[],materials:[],shipping:[],technician_total_cost:450,helper_total_cost:0,incurred_items:[]}};
  db.tables.work_order_stage_data.push(diag); w.eval('stageRows').push(JSON.parse(JSON.stringify(diag)));

  await w.openWorkflow(wo.id); await wait(300);
  // move to the approval/quote stage and render the quote builder
  w.eval('workflowStageView="approval"'); w.renderStageContent(); await wait(300);

  console.log('\n--- add a Material, Equipment, and Other Special Fee in the QUOTE stage ---');
  // add rows via the quote UI helpers
  w.addQuoteLine('materials'); await wait(80);
  w.addQuoteLine('equipment'); await wait(80);
  w.addQuoteLine('shipping'); await wait(80);
  const setLine=(kind,idx,map)=>{const cards=[...w.document.querySelectorAll(`.quote-line[data-qkind="${kind}"]`)];const c=cards[idx];if(!c)return false;
    for(const[k,val] of Object.entries(map)){const el=c.querySelector(`[data-qk="${k}"]`);if(el)el.value=val;}return true;};
  chk('material row present in quote UI',setLine('materials',0,{description:'Refrigerant R448A',quantity:2,unit_cost:45}));
  chk('equipment row present in quote UI',setLine('equipment',0,{description:'Recovery machine',quantity:1,unit_cost:120}));
  chk('special-fee row present in quote UI',setLine('shipping',0,{description:'Disposal fee',amount:60}));

  const qBefore=w.collectQuoteBuilder();
  console.log('   quote now has:',JSON.stringify({
    materials:(qBefore.materials||[]).map(x=>x.description),
    equipment:(qBefore.equipment||[]).map(x=>x.description),
    shipping:(qBefore.shipping||[]).map(x=>x.description)}));

  console.log('\n--- press SYNCHRONIZE (Quote -> Diagnosis) ---');
  await w.synchronizeFromQuote(); await wait(300);

  const dAfter=db.tables.work_order_stage_data.find(r=>r.stage==='diagnosis').data;
  console.log('   Diagnosis after sync:',JSON.stringify({
    parts:(dAfter.parts||[]).map(x=>x.name),
    materials:(dAfter.materials||[]).map(x=>x.name),
    equipment:(dAfter.equipment||[]).map(x=>x.name),
    shipping:(dAfter.shipping||[]).map(x=>x.name||x.description)}));

  chk('QD1 Equipment reached Diagnosis',(dAfter.equipment||[]).some(x=>/Recovery machine/.test(x.name||'')),
    JSON.stringify(dAfter.equipment));
  chk('QD2 Material reached Diagnosis',(dAfter.materials||[]).some(x=>/Refrigerant/.test(x.name||'')),
    JSON.stringify(dAfter.materials||[]));
  chk('QD3 Other Special Fee reached Diagnosis',(dAfter.shipping||[]).some(x=>/Disposal/.test(x.name||x.description||'')),
    JSON.stringify(dAfter.shipping||[]));

  console.log('\n--- round-trip: pre-existing Part keeps its Diagnosis-only fields ---');
  const p1=(dAfter.parts||[]).find(x=>String(x.id)==='P1'||/Fan motor/.test(x.name||''));
  chk('QD4 Part keeps part_trade/part_type after sync',
    Boolean(p1)&&p1.part_trade==='HVAC Part'&&p1.part_type==='Compressor'&&/1\/4hp/.test(p1.specs||''),
    JSON.stringify(p1));

  console.log('\n  jsdom errors:',errs.length?[...new Set(errs)].slice(0,4).join(' | '):'none');
  console.log(`\n================  ${pass} passed / ${fail} failed  ================`);
})();
