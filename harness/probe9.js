/* Probes the nine reported issues against the live-rendered DOM. */
const fs=require('fs'), path=require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { MockDB, uuid } = require('./mockdb');
const SB='https://vuwdhcyiifyarveeqlwz.supabase.co';

const db=new MockDB();
let html=fs.readFileSync(path.join(__dirname,'..','fixed','index.html'),'utf8')
  .replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*"><\/script>/g,'');
const STUB=`<script>
window.__readyGate=new Promise(r=>{window.__signalReady=r});
window.XLSX={read(){return{}},utils:{}};
window.supabase={createClient(){return{auth:{
 async getSession(){await window.__readyGate;return{data:{session:window.__session}}},
 onAuthStateChange(){return{data:{subscription:{unsubscribe(){}}}}},
 async signInWithPassword(){return{data:{session:window.__session},error:null}},
 async signOut(){return{error:null}}}}}};
window.fetch=function(){return window.__nodeFetch.apply(null,arguments)};
window.print=function(){};window.alert=function(m){window.__log('ALERT '+m)};
window.confirm=function(){return true};window.prompt=function(){return ''};window.scrollTo=function(){};
</script>`;
html=html.replace('<head>','<head>'+STUB);
const vc=new VirtualConsole();
const errs=[]; vc.on('jsdomError',e=>errs.push(String(e.message||e)));
const dom=new JSDOM(html,{runScripts:'dangerously',url:'https://mdama.local/',pretendToBeVisual:true,virtualConsole:vc});
const w=dom.window;
w.__session={access_token:'t',user:{id:uuid(),email:'d@d.local'}};
w.__log=m=>console.log('   '+m);
w.Element.prototype.scrollIntoView=function(){};
w.HTMLElement.prototype.focus=function(){};
if(!w.crypto)w.crypto={}; w.crypto.randomUUID=()=>uuid();
w.CSS=w.CSS||{}; w.CSS.escape=s=>String(s).replace(/[^a-zA-Z0-9_-]/g,c=>'\\'+c);
w.requestAnimationFrame=cb=>setTimeout(cb,0);

const aiCalls=[];
const mk=(st,b)=>({ok:st<300,status:st,text:async()=>JSON.stringify(b),json:async()=>b,headers:{get:()=>null}});
w.__nodeFetch=async(url,opt={})=>{
  url=String(url); const m=(opt.method||'GET').toUpperCase();
  let body=null; try{body=opt.body?JSON.parse(opt.body):null}catch{}
  if(url.startsWith(SB+'/rest/v1')){
    try{const r=db.handle(m,url.slice((SB+'/rest/v1').length),body,opt.headers||{});return mk(r.status,r.body);}
    catch(e){return mk(400,{message:e.message});}
  }
  if(/ai-assist/.test(url)){
    if(body?.task==='analyze_part'){
      aiCalls.push({part_trade:body.part_trade,part_type:body.part_type,
        has_description:Boolean(body.description),has_image:Boolean(body.image_data_url)});
      return mk(200,{name:'AI Motor '+aiCalls.length,brand:'Acme',model_number:'M'+aiCalls.length,
        specifications:'1/4 HP 208V',quantity:1,unit_price:120+aiCalls.length,seller:'SupplyCo',
        source_url:'https://example.com/p'+aiCalls.length,source_title:'SupplyCo listing',
        confidence:'high',note:'demo',technical_details:[]});
    }
    return mk(200,{error:'AI unavailable'});
  }
  if(url.startsWith(SB+'/storage/v1')) return mk(200,{signedURL:'/demo'});
  if(/zippopotam/.test(url)) return mk(200,{places:[{latitude:'40.7',longitude:'-73.9','place name':'NY','state abbreviation':'NY'}]});
  return mk(200,{});
};

const TECH=uuid();
db.tables.technicians.push({id:TECH,name:'Demo Tech',phone:'2125550134',normalized_phone:'2125550134',
  primary_trade:'HVAC',city:'New York',state:'NY',zip_code:'10001',active:true,hiring_profile:{}});
db.tables.profiles.push({id:w.__session.user.id,email:'d@d.local',role:'admin',active:true});

const wait=ms=>new Promise(r=>setTimeout(r,ms));
const $=id=>w.document.getElementById(id);
const set=(id,val)=>{const e=$(id);if(e)e.value=val;return Boolean(e);};
const R=[];
const chk=(id,ok,detail)=>{R.push({id,ok,detail});console.log(`  ${ok?'OK  ':'BUG '} ${id}${detail?' — '+detail:''}`);};

(async()=>{
  w.__signalReady(); await wait(600);

  // ---- create + book a WO ----
  set('raw',`Work Order #: WO-PROBE-1
Store: TargetMart
Store #: 4471
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

  console.log('\n=========== ISSUE 1 — Quick-Book button highlight ===========');
  const bookBtns=[...w.document.querySelectorAll('button')]
    .filter(b=>/book|confirm.*booking/i.test(b.textContent||''))
    .map(b=>({txt:(b.textContent||'').trim().slice(0,40),cls:b.className,id:b.id}));
  console.log('   booking-ish buttons in DOM:',JSON.stringify(bookBtns.slice(0,6),null,1));
  const srcAll=fs.readFileSync(path.join(__dirname,'..','fixed','index.html'),'utf8');
  const hlRules=(srcAll.match(/[^\n]{0,120}(highlight|pulse|attention|glow|flash)[^\n]{0,120}/gi)||[]).slice(0,8);
  console.log('   highlight-related source lines:',hlRules.length);
  hlRules.forEach(x=>console.log('     ',x.trim().slice(0,150)));

  console.log('\n=========== ISSUE 9 — AI part analysis on 2nd+ part ===========');
  w.eval('workflowStageView="diagnosis"'); w.renderDiagnosis(); await wait(200);
  w.addDiagnosisItem('parts'); await wait(200);
  w.addDiagnosisItem('parts'); await wait(200);
  const cards=[...w.document.querySelectorAll('.diag-item[data-kind="parts"]')];
  console.log('   part cards rendered:',cards.length);
  cards.forEach((c,i)=>{
    const id=c.dataset.id;
    console.log(`   card#${i+1} id=${String(id).slice(0,8)} `
      +`typeSel=${Boolean(c.querySelector('[data-k="part_type"]'))} `
      +`pasted=${Boolean(c.querySelector('[data-k="pasted_description"]'))} `
      +`imgInput=${Boolean($('part_image_'+id))} `
      +`analyzeBtn=${Boolean($('part_analyze_'+id))} `
      +`aiBox=${Boolean($('part_ai_'+id))}`);
  });
  // duplicate-ID detection
  const allIds=[...w.document.querySelectorAll('[id]')].map(e=>e.id);
  const dupes=allIds.filter((x,i)=>allIds.indexOf(x)!==i);
  chk('9a no duplicate element IDs in diagnosis',dupes.length===0,dupes.slice(0,5).join(', '));

  // now drive AI on BOTH cards using pasted text only
  for(const [i,c] of cards.entries()){
    const id=c.dataset.id;
    c.querySelector('[data-k="part_trade"]').value='HVAC Part';
    const ts=c.querySelector('[data-k="part_type"]');
    if(ts){ ts.value=ts.options[1]?.value||''; }
    const pd=c.querySelector('[data-k="pasted_description"]');
    if(pd) pd.value='Condenser fan motor 1/4 HP 208V model XYZ-'+(i+1);
    const before=aiCalls.length;
    try{ await w.analyzeDiagnosisPart(id); }catch(e){ console.log(`   card#${i+1} threw: ${e.message}`); }
    await wait(250);
    const fired=aiCalls.length>before;
    const nameVal=c.querySelector('[data-k="name"]')?.value||'';
    const priceVal=c.querySelector('[data-k="unit_price"]')?.value||'';
    chk(`9b card#${i+1} pasted-text analysis fired`,fired,
      `name="${nameVal}" price="${priceVal}" notice="${($('workflowNotice')?.textContent||'').trim().slice(0,90)}"`);
  }
  console.log('   ai-assist analyze_part calls:',JSON.stringify(aiCalls));

  console.log('\n=========== ISSUE 6 — part photos in Quote print ===========');
  const printQuote=srcAll.slice(srcAll.indexOf('function printQuoteStageReport'),
                                srcAll.indexOf('function printQuoteStageReport')+2200);
  chk('6a printQuoteStageReport references part photos',
    /part_photo/.test(printQuote), /part_photo/.test(printQuote)?'':'no part_photo reference in the quote print builder');
  console.log('   finalReportItemFilesHtml used by quote print:',/finalReportItemFilesHtml/.test(printQuote));

  console.log('\n=========== ISSUE 7 — quote sections vs diagnosis sections ===========');
  const quoteKinds=['parts','materials','equipment','shipping'];
  quoteKinds.forEach(k=>{
    const inQuote=srcAll.includes(`q_${k}_rows`);
    const inDiag =new RegExp(`diag-item\\[data-kind="${k}"\\]|collectDiagnosisItems\\('${k}'\\)`).test(srcAll);
    console.log(`   ${k.padEnd(10)} quote=${inQuote}  diagnosis=${inDiag}`);
  });

  console.log('\n=========== ISSUE 4/5 — diagnosis <-> incurred PR sync ===========');
  const syncFns=Object.keys(w).filter(k=>/^(sync|synchronize|reconcile|prepare)[A-Z]/.test(k));
  console.log('   sync-related functions:',syncFns.join(', '));

  console.log('\n=========== ISSUE 2/3/8 — per-stage validation + save UX ===========');
  const saveFns=['saveArrival','saveDiagnosis','saveApproval','saveCompletion','saveHiring'];
  saveFns.forEach(fn=>{
    const i=srcAll.indexOf('function '+fn+'(');
    if(i<0){console.log(`   ${fn}: not found as a plain declaration`);return;}
    const body=srcAll.slice(i,i+1400);
    const gate=(body.match(/note\('workflowNotice','[^']{0,140}/)||[])[0]||'(none)';
    console.log(`   ${fn}: single-message gate -> ${gate.slice(24,140)}`);
  });
  chk('2a stage validation points at a specific field',
    /scrollIntoView[\s\S]{0,200}invalid|classList\.add\('field-error'\)|data-field-error/.test(srcAll),
    'no per-field error marking found anywhere in the file');
  chk('8a save button shows a success animation',
    /saved-flash|btn-saved|classList\.add\('success-pulse'\)/.test(srcAll),
    'no save-confirmation visual effect found');

  console.log('\n=========== jsdom errors ===========');
  console.log(errs.length?[...new Set(errs)].slice(0,6).join('\n'):'none');
  fs.writeFileSync(path.join(__dirname,'probe-results.json'),JSON.stringify({R,aiCalls},null,2));
})();
