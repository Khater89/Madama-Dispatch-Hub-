/* Boots MDAMA index.html headlessly and drives a demo work order end-to-end. */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { MockDB, uuid } = require('./mockdb');

const APP = path.join(__dirname, '..', 'Madama-Dispatch-Hub--main', 'index.html');
const db = new MockDB();
const findings = [];
const consoleErrors = [];

function note(sev, area, msg){ findings.push({ sev, area, msg }); console.log(`[${sev}] ${area}: ${msg}`); }

let html = fs.readFileSync(APP, 'utf8');
// strip CDN script tags — jsdom cannot fetch them; we stub the globals instead
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*"><\/script>/g, '');

const vc = new VirtualConsole();
vc.on('jsdomError', e => consoleErrors.push('jsdomError: ' + (e.message||e)));
vc.on('error', (...a) => consoleErrors.push('console.error: ' + a.join(' ')));
vc.on('warn', (...a) => { /* noisy */ });

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  url: 'https://mdama.local/',
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const win = dom.window;

/* ---------- stub the external globals the app expects ---------- */
const fakeSession = { access_token: 'demo-token', user: { id: uuid(), email: 'demo@mdama.local' } };
win.supabase = {
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: fakeSession } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
      signInWithPassword: async () => ({ data: { session: fakeSession }, error: null }),
      signOut: async () => ({ error: null }),
    }
  })
};
win.XLSX = { read: () => ({}), utils: {} };
if (!win.crypto) win.crypto = {};
win.crypto.randomUUID = () => uuid();
win.print = () => {};
win.alert = m => console.log('   [alert]', m);
win.confirm = () => true;
win.prompt = () => '';
win.scrollTo = () => {};
win.Element.prototype.scrollIntoView = function(){};
win.CSS = win.CSS || {}; win.CSS.escape = s => String(s).replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c);

const SB = 'https://vuwdhcyiifyarveeqlwz.supabase.co';
const netCalls = [];
win.fetch = async (url, opt = {}) => {
  url = String(url);
  const method = (opt.method || 'GET').toUpperCase();
  const headers = opt.headers || {};
  let body = null;
  try { body = opt.body ? JSON.parse(opt.body) : null; } catch { body = opt.body; }

  if (url.startsWith(SB + '/rest/v1')){
    const p = url.slice((SB + '/rest/v1').length);
    let r;
    try { r = db.handle(method, p, body, headers); }
    catch (e){ r = { status: 400, body: { message: e.message } }; }
    return mkResponse(r.status, r.body, r.headers);
  }
  if (url.startsWith(SB + '/functions/v1')){
    netCalls.push({ kind:'edge-function', url });
    return mkResponse(200, { ok:true, stub:true, results: [] });
  }
  if (url.startsWith(SB + '/storage/v1')){
    netCalls.push({ kind:'storage', url });
    return mkResponse(200, { signedURL: '/demo-signed-url' });
  }
  netCalls.push({ kind:'external', url });
  // Zippopotam / Overpass / Nominatim etc.
  if (/zippopotam/.test(url)) return mkResponse(200, { places: [{ latitude:'40.7128', longitude:'-74.0060', 'place name':'New York', 'state abbreviation':'NY' }] });
  return mkResponse(200, {});
};
function mkResponse(status, body, extraHeaders = {}){
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    headers: { get: k => extraHeaders[String(k).toLowerCase()] ?? null },
  };
}

/* ---------- seed data ---------- */
const TECH_ID = uuid();
db.tables.technicians.push({
  id: TECH_ID, name: 'Demo HVAC Tech', business_name: 'Demo HVAC LLC', phone: '(212) 555-0134',
  normalized_phone: '2125550134', email: 'tech@demo.local', primary_trade: 'HVAC',
  city: 'New York', state: 'NY', zip_code: '10001', latitude: 40.7484, longitude: -73.9967,
  rating: 4.8, active: true, is_external: false, hiring_profile: {}, created_at: new Date().toISOString()
});
db.tables.profiles.push({ id: fakeSession.user.id, email: 'demo@mdama.local', role: 'admin', active: true, full_name: 'Demo Dispatcher' });

/* ---------- run the app scripts ---------- */
const scripts = Array.from(win.document.querySelectorAll('script')).filter(s => !s.src);
console.log(`Loading ${scripts.length} inline script block(s)...`);
for (const [i, s] of scripts.entries()){
  try { win.eval(s.textContent); }
  catch (e){ note('CRASH', `script block #${i+1}`, e.message); }
}

const w = win; // shorthand
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await wait(400); // let the IIFE boot run

  console.log('\n=== DEMO ORDER RUN ===\n');

  /* --- Step 1: paste + analyze a WO --- */
  const RAW = `Work Order #: WO-DEMO-88213
Store: TargetMart - 4471
Address: 350 5th Ave, New York, NY 10118
Trade: HVAC
NTE: $1200
ETA: P24
Description: Walk-in cooler not holding temperature. Unit runs but temp is 52F.
Contact: Sam Rivera 212-555-0199`;

  if (!w.$('wo_raw')) note('BUG', 'analyze', 'element #wo_raw not found — cannot paste a WO');
  else w.$('wo_raw').value = RAW;

  try { await w.analyze(); } catch(e){ note('CRASH', 'analyze()', e.message); }
  await wait(300);
  console.log('after analyze -> wo_number:', w.$('wo_number')?.value, '| trade:', w.$('wo_trade')?.value, '| zip:', w.$('wo_zip')?.value, '| nte:', w.$('wo_nte')?.value);

  /* --- Step 2: save WO --- */
  try { await w.saveWO(); } catch(e){ note('CRASH', 'saveWO()', e.message); }
  await wait(200);
  const wo = db.tables.work_orders[0];
  if (!wo) { note('CRASH', 'saveWO()', 'no work_order row was written'); }
  else console.log('WO saved:', wo.id, wo.wo_number, '| status:', wo.status);

  if (wo){
    /* --- Step 3: open the workflow --- */
    try { await w.openWorkflow(wo.id); } catch(e){ note('CRASH', 'openWorkflow()', e.message); }
    await wait(200);
    console.log('workflow stage view:', w.workflowStageView);
    const stages = ['new_hiring','arrival','diagnosis','approval','pre_payment','completion','payment','final_report'];
    console.log('unlocked:', stages.filter(s => { try { return w.stageUnlocked(s); } catch { return false; } }).join(', '));

    /* --- Step 4: assign a technician directly --- */
    try {
      await w.req('/work_orders?id=eq.' + wo.id, { method:'PATCH', headers:{Prefer:'return=minimal'},
        body: JSON.stringify({ assigned_technician_id: TECH_ID, status:'tech_hired', workflow_stage:'tech_hired' }) });
      Object.assign(wo, { assigned_technician_id: TECH_ID, status:'tech_hired', workflow_stage:'tech_hired' });
      const local = w.wos.find(x => String(x.id) === String(wo.id)); if (local) Object.assign(local, wo);
    } catch(e){ note('CRASH', 'assign tech', e.message); }

    /* --- Step 5: walk each stage's save function with the required fields --- */
    await runStage(w, wo, 'arrival');
    await runStage(w, wo, 'diagnosis');
    await runStage(w, wo, 'approval');
    await runStage(w, wo, 'completion');
    await runStage(w, wo, 'payment');
  }

  /* --- report --- */
  console.log('\n=== BACKEND CALLS THAT 404ed (missing tables) ===');
  console.log([...db.missingTableHits].join(', ') || 'none');
  console.log('\n=== NON-SUPABASE NETWORK CALLS ===');
  console.log([...new Set(netCalls.map(c => c.kind + ' ' + c.url.split('?')[0]))].join('\n') || 'none');
  console.log('\n=== CONSOLE ERRORS ===');
  console.log([...new Set(consoleErrors)].slice(0, 30).join('\n') || 'none');
  console.log('\n=== TABLE COUNTS ===');
  for (const [t, rows] of Object.entries(db.tables)) if (rows.length) console.log(' ', t, rows.length);

  fs.writeFileSync(path.join(__dirname, 'findings.json'), JSON.stringify({findings, missing:[...db.missingTableHits], consoleErrors:[...new Set(consoleErrors)]}, null, 2));
})();

async function runStage(w, wo, key){
  console.log(`\n--- stage: ${key} ---`);
  try {
    w.workflowStageView = key;
    w.selectWorkflowStage(key);
    if (w.workflowStageView !== key) { console.log(`  locked (stageUnlocked=false)`); return; }
    w.renderStageContent();
  } catch(e){ note('CRASH', `render ${key}`, e.message); return; }
  console.log('  rendered ok');
}
