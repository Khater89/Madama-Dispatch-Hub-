/* Boots MDAMA index.html headlessly and drives a demo work order end-to-end. */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { MockDB, uuid } = require('./mockdb');

const APP = path.join(__dirname, '..', 'Madama-Dispatch-Hub--main', 'index.html');
const db = new MockDB();
const findings = [];
const consoleMsgs = [];
const netCalls = [];
function note(sev, area, msg){ findings.push({ sev, area, msg }); console.log(`  [${sev}] ${area}: ${msg}`); }

const fakeSession = { access_token:'demo-token', user:{ id: uuid(), email:'demo@mdama.local' } };
const SB = 'https://vuwdhcyiifyarveeqlwz.supabase.co';

let html = fs.readFileSync(APP, 'utf8');
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*"><\/script>/g, '');

const STUB = `<script>
window.__readyGate = new Promise(r => { window.__signalReady = r; });
window.XLSX = { read(){return{};}, utils:{} };
window.supabase = { createClient(){ return { auth:{
  async getSession(){ await window.__readyGate; return { data:{ session: window.__session } }; },
  onAuthStateChange(){ return { data:{ subscription:{ unsubscribe(){} } } }; },
  async signInWithPassword(){ return { data:{ session: window.__session }, error:null }; },
  async signOut(){ return { error:null }; }
} }; } };
window.fetch = function(){ return window.__nodeFetch.apply(null, arguments); };
window.print = function(){};
window.alert = function(m){ window.__log('ALERT: ' + m); };
window.confirm = function(){ return true; };
window.prompt = function(){ return ''; };
window.scrollTo = function(){};
</script>`;
html = html.replace('<head>', '<head>' + STUB);
if (!html.includes('__readyGate')) html = STUB + html;

const vc = new VirtualConsole();
vc.on('jsdomError', e => consoleMsgs.push('jsdomError: ' + (e.message || e)));
vc.on('error', (...a) => consoleMsgs.push('error: ' + a.map(String).join(' ')));
vc.on('warn', (...a) => consoleMsgs.push('warn: ' + a.map(String).join(' ')));

const dom = new JSDOM(html, {
  runScripts: 'dangerously', url: 'https://mdama.local/', pretendToBeVisual: true, virtualConsole: vc
});
const w = dom.window;

w.__session = fakeSession;
w.__log = m => console.log('   ' + m);
w.Element.prototype.scrollIntoView = function(){};
w.HTMLElement.prototype.focus = function(){};
if (!w.crypto) w.crypto = {};
w.crypto.randomUUID = () => uuid();
w.CSS = w.CSS || {}; w.CSS.escape = s => String(s).replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c);

function mkResponse(status, body, extraHeaders = {}){
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status,
    text: async () => text, json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    headers: { get: k => extraHeaders[String(k).toLowerCase()] ?? null } };
}

w.__nodeFetch = async (url, opt = {}) => {
  url = String(url);
  const method = (opt.method || 'GET').toUpperCase();
  const headers = opt.headers || {};
  let body = null; try { body = opt.body ? JSON.parse(opt.body) : null; } catch { body = opt.body; }

  if (url.startsWith(SB + '/rest/v1')){
    const p = url.slice((SB + '/rest/v1').length);
    let r; try { r = db.handle(method, p, body, headers); }
    catch (e){ r = { status:400, body:{ message: e.message } }; }
    return mkResponse(r.status, r.body, r.headers);
  }
  if (url.startsWith(SB + '/functions/v1')){
    netCalls.push('edge ' + url.split('?')[0]);
    // simulate the OpenAI-backed function being unavailable -> exercises the local fallback
    if (/ai-assist/.test(url)) return mkResponse(200, { error:'AI unavailable in demo' });
    return mkResponse(200, { ok:true, results:[], businesses:[] });
  }
  if (url.startsWith(SB + '/storage/v1')){ netCalls.push('storage ' + url.split('?')[0]); return mkResponse(200, { signedURL:'/demo-url' }); }
  netCalls.push('EXTERNAL ' + url.split('?')[0]);
  if (/zippopotam/.test(url)) return mkResponse(200, { places:[{ latitude:'40.7484', longitude:'-73.9967', 'place name':'New York', 'state abbreviation':'NY' }] });
  return mkResponse(200, {});
};

/* seed */
const TECH_ID = uuid();
db.tables.technicians.push({ id:TECH_ID, name:'Demo HVAC Tech', business_name:'Demo HVAC LLC',
  phone:'(212) 555-0134', normalized_phone:'2125550134', email:'tech@demo.local', primary_trade:'HVAC',
  city:'New York', state:'NY', zip_code:'10001', latitude:40.7484, longitude:-73.9967, rating:4.8,
  active:true, hiring_profile:{}, created_at:new Date().toISOString() });
db.tables.profiles.push({ id:fakeSession.user.id, email:'demo@mdama.local', role:'admin', active:true, full_name:'Demo Dispatcher' });

const wait = ms => new Promise(r => setTimeout(r, ms));
const $ = id => w.document.getElementById(id);
const set = (id, val) => { const e = $(id); if (!e) return false; e.value = val; return true; };

(async () => {
  w.__signalReady();
  await wait(600);

  console.log('boot done. authGate display =', $('authGate')?.style.display, '| appRoot =', $('appRoot')?.style.display);
  console.log('techs loaded:', w.eval('techs.length'), '| wos:', w.eval('wos.length'), '| settings:', JSON.stringify(w.eval('settings')));

  console.log('\n================ DEMO ORDER ================\n');

  /* 1. paste + analyze */
  console.log('--- 1. Paste & Analyze ---');
  const RAW = `Work Order #: WO-DEMO-88213
Store: TargetMart - 4471
Address: 350 5th Ave, New York, NY 10118
Trade: HVAC
NTE: $1200
ETA: P24
Description: Walk-in cooler not holding temperature. Unit runs but box temp is 52F.
Contact: Sam Rivera 212-555-0199`;
  if (!set('raw', RAW)) note('BUG','analyze','#raw missing');
  try { await w.analyze(); } catch(e){ note('CRASH','analyze()', e.message); }
  await wait(500);
  ['won','trade','storename','storenumber','fulladdress','street','city','state','zip','nte','etacode','sow','summary','bcontact','bphone','arabicproblem']
    .forEach(id => { const e = $(id); if (e) console.log(`   ${id} = ${JSON.stringify(String(e.value).slice(0,70))}`); });

  /* 2. save */
  console.log('\n--- 2. Save WO ---');
  try { await w.saveWO(); } catch(e){ note('CRASH','saveWO()', e.message); }
  await wait(300);
  const wo = db.tables.work_orders[0];
  if (!wo) { note('CRASH','saveWO()','no work_orders row written'); }
  else console.log('   saved id=%s wo_number=%s status=%s trade=%s zip=%s nte=%s', wo.id.slice(0,8), wo.wo_number, wo.status, wo.trade, wo.zip_code, wo.nte);

  if (wo){
    /* 3. workflow */
    console.log('\n--- 3. Open workflow ---');
    try { await w.openWorkflow(wo.id); } catch(e){ note('CRASH','openWorkflow()', e.message); }
    await wait(400);
    console.log('   view =', w.eval('workflowStageView'));
    printStages(wo);

    /* 4. assign technician */
    console.log('\n--- 4. Assign technician ---');
    try {
      await w.req('/work_orders?id=eq.' + wo.id, { method:'PATCH', headers:{Prefer:'return=minimal'},
        body: JSON.stringify({ assigned_technician_id:TECH_ID, status:'tech_hired', workflow_stage:'tech_hired' }) });
      const local = w.eval('wos')[0];
      Object.assign(wo, { assigned_technician_id:TECH_ID, status:'tech_hired', workflow_stage:'tech_hired' });
      if (local) Object.assign(local, wo);
      w.renderWorkflow();
    } catch(e){ note('CRASH','assign', e.message); }
    printStages(wo);

    /* helper: fake an uploaded file into the local index */
    const addFile = (stage, type, n=1, itemRef=null) => {
      for (let i=0;i<n;i++){
        const rec = { id:uuid(), work_order_id:wo.id, stage, file_type:type, item_ref:itemRef,
          storage_path:`${wo.id}/${stage}/${type}-${i}.jpg`, file_name:`${type}-${i}.jpg`, mime_type:'image/jpeg', size_bytes:1234, created_at:new Date().toISOString() };
        db.tables.work_order_files.push(rec);
        w.eval('woFiles').push(rec);
      }
    };

    /* 5. arrival */
    console.log('\n--- 5. Arrival stage ---');
    await stage('arrival', async () => {
      const iso = new Date().toISOString().slice(0,16);
      set('a_time_date', iso.slice(0,10)); set('a_time_time', '10:00'); set('a_note','Tech on site.');
      addFile('arrival','arrival_photo',1);
      try { await w.saveArrival(true); } catch(e){ note('CRASH','saveArrival()', e.message); }
      await wait(300);
      console.log('   stage row completed =', db.tables.work_order_stage_data.find(r=>r.stage==='arrival')?.completed);
      console.log('   WO status now =', db.tables.work_orders[0].status, '/', db.tables.work_orders[0].workflow_stage);
      console.log('   notice:', ($('workflowNotice')?.textContent||'').trim().slice(0,180));
    });
    printStages(wo);

    /* 6. diagnosis */
    console.log('\n--- 6. Diagnosis stage ---');
    await stage('diagnosis', async () => {
      set('d_problem','Condenser fan motor seized; head pressure high.');
      set('d_plan','Replace condenser fan motor.\nRecheck superheat.');
      set('d_tech_cost','450'); set('d_hours','3'); set('d_same_day','yes');
      addFile('diagnosis','before_photo',4);
      w.renderDiagnosis();
      set('d_problem','Condenser fan motor seized; head pressure high.');
      set('d_plan','Replace condenser fan motor.\nRecheck superheat.');
      set('d_tech_cost','450'); set('d_hours','3'); set('d_same_day','yes');
      try { await w.saveDiagnosis(true); } catch(e){ note('CRASH','saveDiagnosis()', e.message); }
      await wait(200);
      console.log('   notice:', ($('workflowNotice')?.textContent||'').trim().slice(0,220));
      console.log('   completed =', db.tables.work_order_stage_data.find(r=>r.stage==='diagnosis')?.completed);
      console.log('   saved diagnosis data =', JSON.stringify(db.tables.work_order_stage_data.find(r=>r.stage==='diagnosis')?.data));
    });
    printStages(wo);

    /* 6b. inject Diagnosis Incurred rows > agreed total, to probe the final-payment formula */
    console.log('\n--- 6b. Inject Diagnosis incurred rows ---');
    try {
      const row = db.tables.work_order_stage_data.find(r=>r.stage==='diagnosis');
      row.data.incurred_items = [ {id:uuid(), description:'Trip charge', amount:150}, {id:uuid(), description:'Assessment labor', amount:400} ];
      row.data.technician_total_cost = 450; row.data.helper_total_cost = 0;
      const local = w.eval('stageRows').find(r => r.stage === 'diagnosis'); if (local) local.data = row.data;
      console.log('   agreed total = 450, incurred rows total = 550  (incurred > agreed on purpose)');
      const bd = w.finalPaymentDiagnosisBreakdown(wo.id);
      const agreed = w.finalPaymentAgreedTotal(wo.id);
      console.log('   finalPaymentAgreedTotal        =', agreed);
      console.log('   finalPaymentDiagnosisBreakdown =', JSON.stringify(bd));
      console.log('   >>> Amount Due (V1155 formula) =', (agreed - bd.total).toFixed(2));
    } catch(e){ note('CRASH','incurred probe', e.message); }

    /* 7. quote math (pure) */
    console.log('\n--- 7. Quote calculator (pure math check) ---');
    quoteMathChecks();

    /* 8. payment formula */
    console.log('\n--- 8. Final payment formula ---');
    paymentMathChecks(wo);
  }

  report();
})();

function printStages(wo){
  const keys = ['new_hiring','arrival','diagnosis','approval','pre_payment','completion','payment','final_report'];
  const st = w.eval('currentWorkflowStatus')(wo);
  console.log('   status=%s stageIndexForStatus=%s', st, w.eval('stageIndexForStatus')(st));
  console.log('   ' + keys.map(k => { let u; try{u=w.stageUnlocked(k);}catch(e){u='ERR:'+e.message;} return `${k}:${u===true?'open':u===false?'LOCK':u}`; }).join('  '));
}

async function stage(key, fn){
  try { w.eval('workflowStageView='+JSON.stringify(key)); w.renderStageContent(); }
  catch(e){ note('CRASH', 'render ' + key, e.message); return; }
  if (!w.stageUnlocked(key)) note('BUG', key, 'stage is locked at this point in the flow');
  await fn();
}

function dumpInputs(stageKey){
  const box = w.document.getElementById('stageBody') || w.document.getElementById('workflowBody');
  if (!box) return;
  const req = [...box.querySelectorAll('input,select,textarea')].filter(e => e.id).map(e => e.id);
  console.log('   fields present:', req.slice(0,25).join(', ') || '(none)');
}

function quoteMathChecks(){
  const cases = [
    { name:'markup missing (null)', d:{ main_rate:75, helper_rate:40, trip_amount:85, assessment_main_hours:1, assessment_helper_hours:0, repair_main_hours:2, repair_helper_hours:0, markup:null, parts:[{quantity:1,unit_cost:200,sales_tax:16}], materials:[], equipment:[], shipping:[] } },
    { name:'markup = 1 (no markup)', d:{ main_rate:75, helper_rate:40, trip_amount:85, assessment_main_hours:1, assessment_helper_hours:0, repair_main_hours:2, repair_helper_hours:0, markup:1, parts:[{quantity:1,unit_cost:200,sales_tax:16}], materials:[], equipment:[], shipping:[] } },
    { name:'markup = 1.3', d:{ main_rate:75, helper_rate:40, trip_amount:85, assessment_main_hours:1, assessment_helper_hours:0, repair_main_hours:2, repair_helper_hours:0, markup:1.3, parts:[{quantity:1,unit_cost:200,sales_tax:16}], materials:[], equipment:[], shipping:[] } },
  ];
  for (const c of cases){
    const r = w.quoteCalc(c.d);
    console.log(`   ${c.name.padEnd(24)} incurred=$${r.incurred} repair=$${r.repair} parts=$${r.parts.toFixed(2)} TOTAL=$${r.total.toFixed(2)}`);
    const val = w.validateQuoteBuilder({ ...c.d, tech_report:'x', required_to:'do the thing' });
    console.log(`     validate ok=${val.ok} issues=${val.issues.join(' | ') || '-'}`);
  }
}

function paymentMathChecks(wo){
  const fns = Object.keys(w).filter(k => /^applyFinalPaymentFormula/.test(k));
  console.log('   final-payment formula versions defined:', fns.join(', '));
  const dupes = Object.keys(w).filter(k => /V11\d\d$/.test(k));
  console.log('   version-suffixed patch functions:', dupes.length);
}

function report(){
  console.log('\n================ REPORT ================');
  console.log('\n>> 404 tables (called by app, no migration ships them):');
  console.log('   ' + ([...db.missingTableHits].join(', ') || 'none'));
  console.log('\n>> non-Supabase network calls:');
  console.log('   ' + ([...new Set(netCalls.filter(c=>c.startsWith('EXTERNAL')))].join('\n   ') || 'none'));
  console.log('\n>> console errors/warnings:');
  console.log('   ' + ([...new Set(consoleMsgs)].slice(0,25).join('\n   ') || 'none'));
  console.log('\n>> table row counts:');
  for (const [t, rows] of Object.entries(db.tables)) if (rows.length) console.log('  ', t, rows.length);
  console.log('\n>> findings:', findings.length);
  fs.writeFileSync(path.join(__dirname,'findings.json'), JSON.stringify({findings, missingTables:[...db.missingTableHits], consoleMsgs:[...new Set(consoleMsgs)], netCalls:[...new Set(netCalls)]}, null, 2));
}
