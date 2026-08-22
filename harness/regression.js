/* Runs the same probes against the ORIGINAL and the FIXED build and diffs them. */
const fs = require('fs'), path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { MockDB, uuid } = require('./mockdb');

const SB = 'https://vuwdhcyiifyarveeqlwz.supabase.co';

function boot(dir){
  const db = new MockDB();
  let html = fs.readFileSync(path.join(__dirname,'..',dir,'index.html'),'utf8')
    .replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*"><\/script>/g,'');
  const STUB = `<script>
window.__readyGate=new Promise(r=>{window.__signalReady=r;});
window.XLSX={read(){return{}},utils:{}};
window.supabase={createClient(){return{auth:{
 async getSession(){await window.__readyGate;return{data:{session:window.__session}}},
 onAuthStateChange(){return{data:{subscription:{unsubscribe(){}}}}},
 async signInWithPassword(){return{data:{session:window.__session},error:null}},
 async signOut(){return{error:null}}}}}};
window.fetch=function(){return window.__nodeFetch.apply(null,arguments)};
window.print=function(){};window.alert=function(){};window.confirm=function(){return true};
window.prompt=function(){return ''};window.scrollTo=function(){};
</script>`;
  html = html.replace('<head>','<head>'+STUB);
  const vc = new VirtualConsole();
  const dom = new JSDOM(html,{runScripts:'dangerously',url:'https://mdama.local/',pretendToBeVisual:true,virtualConsole:vc});
  const w = dom.window;
  w.__session = { access_token:'t', user:{ id:uuid(), email:'demo@mdama.local' } };
  w.Element.prototype.scrollIntoView=function(){};
  w.HTMLElement.prototype.focus=function(){};
  if(!w.crypto) w.crypto={}; w.crypto.randomUUID=()=>uuid();
  w.CSS=w.CSS||{}; w.CSS.escape=s=>String(s).replace(/[^a-zA-Z0-9_-]/g,c=>'\\'+c);
  const mk=(st,b)=>({ok:st<300,status:st,text:async()=>JSON.stringify(b),json:async()=>b,headers:{get:()=>null}});
  w.__nodeFetch = async (url,opt={})=>{
    url=String(url); const m=(opt.method||'GET').toUpperCase();
    let body=null; try{body=opt.body?JSON.parse(opt.body):null}catch{}
    if(url.startsWith(SB+'/rest/v1')){
      try{ const r=db.handle(m,url.slice((SB+'/rest/v1').length),body,opt.headers||{}); return mk(r.status,r.body); }
      catch(e){ return mk(400,{message:e.message}); }
    }
    if(/ai-assist/.test(url)) return mk(200,{error:'AI unavailable in demo'});   // force local fallback
    if(/zippopotam/.test(url)) return mk(200,{places:[{latitude:'40.7',longitude:'-73.9','place name':'NY','state abbreviation':'NY'}]});
    return mk(200,{});
  };
  db.tables.profiles.push({id:w.__session.user.id,email:'demo@mdama.local',role:'admin',active:true});
  return { w, db, ready: async()=>{ w.__signalReady(); await new Promise(r=>setTimeout(r,500)); } };
}

const RAW = `Work Order #: WO-DEMO-88213
Store: TargetMart - 4471
Store #: 4471
Address: 350 5th Ave, New York, NY 10118
Trade: HVAC
NTE: $1200
ETA: P24
Description: Walk-in cooler not holding temperature.`;

const CASES = [
  { id:'T1 wo_number extracted',        run: a => a.wo_number,      want:'WO-DEMO-88213' },
  { id:'T2 store_name extracted',       run: a => a.store_name,     want:'TargetMart - 4471' },
  { id:'T3 store_number is the NUMBER', run: a => a.store_number,   want:'4471' },
  { id:'T4 NTE extracted',              run: a => a.nte,            want:1200 },
];

(async () => {
  const results = {};
  for (const dir of ['Madama-Dispatch-Hub--main','fixed']){
    const { w, ready } = boot(dir);
    await ready();
    const a = w.localAnalyze(RAW);
    const r = {};
    for (const c of CASES) r[c.id] = c.run(a);

    // quote markup behaviour
    const qd = { main_rate:75, helper_rate:40, trip_amount:85, assessment_main_hours:1,
      assessment_helper_hours:0, repair_main_hours:2, repair_helper_hours:0, markup:null,
      parts:[{quantity:1,unit_cost:200,sales_tax:16}], materials:[], equipment:[], shipping:[] };
    r['T5 blank markup keeps parts'] = Number(w.quoteCalc(qd).parts.toFixed(2));
    r['T6 blank markup still flagged'] = w.validateQuoteBuilder({...qd,tech_report:'x',required_to:'y',
      parts:[{description:'motor',quantity:1,unit_cost:200,sales_tax:16}]}).issues.includes('Parts / Materials markup from TL');

    // negative amount due: clamp present?
    const src = fs.readFileSync(path.join(__dirname,'..',dir,'index.html'),'utf8');
    const fnBody = src.slice(src.indexOf('function applyFinalPaymentFormulaV1155'),
                             src.indexOf('function applyFinalPaymentFormulaV1155')+900);
    r['T7 final amount clamped'] = /amountDue=Math\.max\(0,total-incurred\)/.test(fnBody);
    r['T8 payload clamped'] = /p\.amount_due=Math\.max\(0,total-incurred\)/.test(src);

    // migrations present?
    const sqlDir = path.join(__dirname,'..',dir,'sql');
    const have = fs.readdirSync(sqlDir);
    r['T9 migrations shipped'] = ['23_live_search_db_v11_19.sql','30_multiuser_auth_foundation.sql','30_vendor_network_fast_hire.sql']
      .filter(f => have.includes(f)).length + '/3';

    results[dir] = r;
  }

  const keys = Object.keys(results['fixed']);
  const wantMap = Object.fromEntries(CASES.map(c=>[c.id,c.want]));
  wantMap['T5 blank markup keeps parts']=216; wantMap['T6 blank markup still flagged']=true;
  wantMap['T7 final amount clamped']=true; wantMap['T8 payload clamped']=true; wantMap['T9 migrations shipped']='3/3';

  const pad=(s,n)=>String(s).padEnd(n);
  console.log(pad('CHECK',34)+pad('BEFORE',22)+pad('AFTER',22)+'RESULT');
  console.log('-'.repeat(92));
  let pass=0;
  for (const k of keys){
    const before=results['Madama-Dispatch-Hub--main'][k], after=results['fixed'][k];
    const ok = String(after)===String(wantMap[k]);
    if(ok) pass++;
    console.log(pad(k,34)+pad(JSON.stringify(before),22)+pad(JSON.stringify(after),22)+(ok?'PASS':'FAIL'));
  }
  console.log('-'.repeat(92));
  console.log(`${pass}/${keys.length} checks pass on the fixed build`);
})();
