
/* ========================================================================
   MDAMA v12.2 — workflow UX + data-integrity patch
   Loads last, so every override here wins over the earlier V11xx layers.

   1  Fast-Hire "book" button no longer renders as a highlighted CTA.
   2  Per-stage required-field validation that names AND points at the field.
   3  Every visible field in a stage is actually persisted on Save.
   7  Materials and Other Special Fees added to Diagnosis, in Quote order.
   8  Visible confirmation when Save and SYNCHRONIZE succeed.
   ======================================================================== */

/* ---------- shared styling for the new behaviours ---------- */
(function injectV122Styles(){
  if(document.getElementById('mdamaV122Styles'))return;
  const css=document.createElement('style');
  css.id='mdamaV122Styles';
  css.textContent=`
  /* 1 — neutralise the Fast Hire booking highlight */
  .fast-hire-btn{
    border-color:var(--line,#c1ccd5)!important;
    background:var(--btn-bg,#f4f6f8)!important;
    color:var(--fg,#17202a)!important;
    box-shadow:none!important;
    background-image:none!important;
  }
  /* 2 — field-level error marking */
  .v122-invalid,
  .v122-invalid input,.v122-invalid select,.v122-invalid textarea{
    border-color:#dc2626!important;
    box-shadow:0 0 0 2px rgba(220,38,38,.16)!important;
  }
  .v122-invalid > label{color:#dc2626!important}
  .v122-field-msg{
    color:#dc2626;font-size:11px;margin-top:5px;display:block;font-weight:600;
  }
  .v122-focus-ring{animation:v122Ring 1.5s ease-out 1}
  @keyframes v122Ring{
    0%{box-shadow:0 0 0 0 rgba(220,38,38,.42)}
    70%{box-shadow:0 0 0 9px rgba(220,38,38,0)}
    100%{box-shadow:0 0 0 0 rgba(220,38,38,0)}
  }
  /* 8 — save / sync confirmation */
  .v122-saved{
    background:#0f9d76!important;border-color:#0f9d76!important;color:#fff!important;
    transition:background .18s ease,border-color .18s ease;
  }
  .v122-toast{
    position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(14px);
    background:#0f9d76;color:#fff;font-weight:600;font-size:13px;
    padding:11px 20px;border-radius:9px;box-shadow:0 8px 26px rgba(15,157,118,.32);
    z-index:9999;opacity:0;pointer-events:none;
    transition:opacity .22s ease,transform .22s ease;
  }
  .v122-toast.err{background:#dc2626;box-shadow:0 8px 26px rgba(220,38,38,.32)}
  .v122-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  `;
  document.head.appendChild(css);
})();

/* ---------- 8: visible save / sync confirmation ---------- */
let _v122ToastTimer=null;
function toastV122(message,kind='ok'){
  let el=document.getElementById('v122Toast');
  if(!el){
    el=document.createElement('div');
    el.id='v122Toast';
    el.className='v122-toast';
    document.body.appendChild(el);
  }
  el.textContent=message;
  el.className='v122-toast'+(kind==='err'?' err':'')+' show';
  clearTimeout(_v122ToastTimer);
  _v122ToastTimer=setTimeout(()=>{el.className='v122-toast'+(kind==='err'?' err':'');},2600);
}

/* Flash the button the user actually clicked. */
function flashButtonV122(btn,label){
  if(!btn)return;
  const originalText=btn.textContent,originalClass=btn.className;
  btn.classList.add('v122-saved');
  btn.textContent=label;
  setTimeout(()=>{btn.className=originalClass;btn.textContent=originalText;},1500);
}
function activeButtonV122(){
  const el=document.activeElement;
  return el&&el.tagName==='BUTTON'?el:null;
}

/* ---------- 2: per-stage required-field rules ---------- */
/* Each rule: {id, label, kind}. `kind` decides how "empty" is judged.
   `files` rules are checked against the uploaded-file index, not the DOM. */
const STAGE_RULES_V122={
  arrival:[
    {id:'a_time_date',label:'Actual arrival date'},
    {id:'a_time_time',label:'Actual arrival time'},
    {kind:'files',stage:'arrival',type:'arrival_photo',min:1,
     anchor:'arrival_photo_input',label:'Arrival Photo (1 required)'}
  ],
  diagnosis:[
    {id:'d_problem',label:'Exact problem found'},
    {id:'d_plan',label:'Repair plan / what the tech will do'},
    {kind:'files',stage:'diagnosis',type:'before_photo',min:4,
     anchor:'before_photos_input',label:'Before Photos (4 required)'}
  ],
  completion:[
    {id:'c_done_at_date',label:'Work completion date'},
    {id:'c_done_at_time',label:'Work completion time'},
    {id:'c_after_photos_ok',label:'After-photos confirmation',kind:'check'},
    {id:'c_manager_ok',label:'Manager confirmation',kind:'check'},
    {id:'c_signoff_ok',label:'Sign-off confirmation',kind:'check'},
    {kind:'files',stage:'completion',type:'after_photo',min:4,
     anchor:'after_photos_input',label:'After Photos (4 required)'}
  ]
};

/* Item-level rules for the repeating Diagnosis cards. */
const DIAG_ITEM_RULES_V122={
  parts:[['part_trade','Part Trade'],['part_type','Part Type'],['name','Part name'],
         ['brand_model','Brand / model'],['specs','Technical specs'],
         ['quantity','Quantity'],['unit_price','Unit price']],
  equipment:[['name','Equipment name'],['possession_type','Possession type'],['cost','Equipment cost']],
  materials:[['name','Material name'],['quantity','Quantity'],['unit_price','Unit price']],
  shipping:[['name','Fee description'],['amount','Fee amount']]
};

function clearFieldErrorsV122(){
  document.querySelectorAll('.v122-invalid').forEach(el=>el.classList.remove('v122-invalid'));
  document.querySelectorAll('.v122-field-msg').forEach(el=>el.remove());
}

function markFieldErrorV122(el,message){
  if(!el)return null;
  const holder=el.closest('.field')||el.closest('.brief-box')||el.parentElement||el;
  holder.classList.add('v122-invalid');
  if(!holder.querySelector('.v122-field-msg')){
    const msg=document.createElement('span');
    msg.className='v122-field-msg';
    msg.textContent=message;
    holder.appendChild(msg);
  }
  return holder;
}

/* Returns {ok, missing:[labels], first:Element} */
function validateStageV122(stage){
  clearFieldErrorsV122();
  const rules=STAGE_RULES_V122[stage]||[];
  const missing=[];
  let first=null;

  for(const rule of rules){
    let empty=false,anchor=null;
    if(rule.kind==='files'){
      const have=filesFor(rule.stage,rule.type).length;
      empty=have<(rule.min||1);
      anchor=document.getElementById(rule.anchor);
    }else{
      const el=document.getElementById(rule.id);
      anchor=el;
      if(!el)continue;                                   // field not rendered in this variant
      empty=rule.kind==='check'?!el.checked:!String(el.value||'').trim();
    }
    if(empty){
      missing.push(rule.label);
      const holder=markFieldErrorV122(anchor,'Required — '+rule.label);
      if(!first)first=holder||anchor;
    }
  }

  /* repeating Diagnosis cards */
  if(stage==='diagnosis'){
    for(const [kind,fields] of Object.entries(DIAG_ITEM_RULES_V122)){
      const cards=document.querySelectorAll(`.diag-item[data-kind="${kind}"]`);
      cards.forEach((card,i)=>{
        for(const [key,label] of fields){
          const el=card.querySelector(`[data-k="${key}"]`);
          if(!el)continue;
          const val=String(el.value||'').trim();
          const numeric=['quantity','unit_price','cost','amount'].includes(key);
          const bad=numeric?(val===''||!(Number(val)>0)):val==='';
          if(bad){
            const nice=`${kind==='shipping'?'Special fee':kind.replace(/s$/,'')} ${i+1} — ${label}`;
            missing.push(nice);
            const holder=markFieldErrorV122(el,'Required — '+label);
            if(!first)first=holder||el;
          }
        }
      });
    }
  }

  if(first){
    try{first.scrollIntoView({behavior:'smooth',block:'center'});}catch{}
    first.classList.add('v122-focus-ring');
    setTimeout(()=>first.classList.remove('v122-focus-ring'),1600);
    const focusable=first.querySelector?.('input,select,textarea')||first;
    try{focusable.focus?.({preventScroll:true});}catch{}
  }
  return {ok:missing.length===0,missing,first};
}

/* One shared gate: name every missing field instead of a single generic line. */
function stageGateV122(stage){
  const r=validateStageV122(stage);
  if(!r.ok){
    const list=r.missing.slice(0,8).map(x=>'• '+esc(x)).join('<br>');
    const more=r.missing.length>8?`<br>…and ${r.missing.length-8} more`:'';
    note('workflowNotice',
      `<b>${r.missing.length} required field${r.missing.length===1?'':'s'} still empty:</b><br>${list}${more}`,
      'error');
    toastV122(`${r.missing.length} required field${r.missing.length===1?'':'s'} missing`,'err');
  }
  return r.ok;
}

/* ---------- 7 + 3: Materials and Other Special Fees inside Diagnosis ---------- */
function diagMaterialCardV122(item={}){
  const id=item.id||safeId();
  return `<div class="diag-item" data-kind="materials" data-id="${esc(id)}">
    <div class="grid g4">
      <div class="field"><label>Material name *</label><input data-k="name" value="${esc(item.name||'')}"></div>
      <div class="field"><label>Quantity *</label><input data-k="quantity" type="number" min="0.01" step="0.01" value="${esc(item.quantity??1)}"></div>
      <div class="field"><label>Unit / source cost ($) *</label><input data-k="unit_price" type="number" min="0" step="0.01" value="${esc(item.unit_price??'')}"></div>
      <div class="field"><label>Store / source</label><input data-k="source" value="${esc(item.source||'')}"></div>
    </div>
    <div class="stage-actions" style="justify-content:flex-start">
      <button type="button" class="btn danger small" onclick="removeDiagnosisItemV122('materials','${esc(id)}')">Remove material</button>
    </div></div>`;
}
function diagFeeCardV122(item={}){
  const id=item.id||safeId();
  return `<div class="diag-item" data-kind="shipping" data-id="${esc(id)}">
    <div class="grid g2">
      <div class="field"><label>Special fee description *</label><input data-k="name" value="${esc(item.name||item.description||'')}" placeholder="Permit, parking, delivery, disposal, or other approved fee"></div>
      <div class="field"><label>Fee amount ($) *</label><input data-k="amount" type="number" min="0" step="0.01" value="${esc(item.amount??'')}"></div>
    </div>
    <div class="stage-actions" style="justify-content:flex-start">
      <button type="button" class="btn danger small" onclick="removeDiagnosisItemV122('shipping','${esc(id)}')">Remove fee</button>
    </div></div>`;
}

function addDiagnosisItemV122(kind){
  const d=collectDiagnosis();
  d[kind]=Array.isArray(d[kind])?d[kind]:[];
  d[kind].push({id:safeId(),...(kind==='materials'?{quantity:1}:{})});
  setLocalStageData('diagnosis',d);
  renderDiagnosis();
}
function removeDiagnosisItemV122(kind,id){
  const d=collectDiagnosis();
  d[kind]=(d[kind]||[]).filter(x=>String(x.id)!==String(id));
  setLocalStageData('diagnosis',d);
  renderDiagnosis();
}

/* Render the two new sections in the same order the Quote stage uses:
   Parts → Materials → Equipment → Other Special Fees. */
const _v122RenderDiagnosis=renderDiagnosis;
renderDiagnosis=function(){
  const r=_v122RenderDiagnosis();
  const stage=document.getElementById('stageContent');
  if(!stage||document.getElementById('d_materials'))return r;
  const d=stageData('diagnosis');
  const equipmentBox=document.getElementById('d_equipment');
  if(!equipmentBox)return r;

  const materials=Array.isArray(d.materials)?d.materials:[];
  const fees=Array.isArray(d.shipping)?d.shipping:[];

  /* Materials goes BEFORE Equipment, matching the Quote stage order. */
  const matWrap=document.createElement('div');
  matWrap.innerHTML=`<div class="section" style="margin-top:22px"><h2>Materials <span class="badge b-new">${materials.length}</span></h2></div>
    <div id="d_materials">${materials.map(diagMaterialCardV122).join('')}</div>
    <div class="stage-actions" style="justify-content:flex-start;margin-top:10px">
      <button class="btn primary" type="button" onclick="addDiagnosisItemV122('materials')">+ Add another material</button>
    </div>`;
  const equipmentHeading=equipmentBox.previousElementSibling;
  (equipmentHeading||equipmentBox).insertAdjacentElement('beforebegin',matWrap);

  /* Other Special Fees goes AFTER Equipment. */
  const feeWrap=document.createElement('div');
  feeWrap.innerHTML=`<div class="section" style="margin-top:22px"><h2>Other Special Fees <span class="badge b-new">${fees.length}</span></h2></div>
    <div id="d_fees">${fees.map(diagFeeCardV122).join('')}</div>
    <div class="stage-actions" style="justify-content:flex-start;margin-top:10px">
      <button class="btn primary" type="button" onclick="addDiagnosisItemV122('shipping')">+ Add another special fee</button>
    </div>`;
  const afterEquipment=equipmentBox.nextElementSibling;   // the "+ Add another equipment" row
  (afterEquipment||equipmentBox).insertAdjacentElement('afterend',feeWrap);
  return r;
};

/* 3 — make sure the new sections are part of what Save persists. */
const _v122CollectDiagnosis=collectDiagnosis;
collectDiagnosis=function(){
  const d=_v122CollectDiagnosis();
  d.materials=collectDiagnosisItems('materials');
  d.shipping=collectDiagnosisItems('shipping').map(x=>({...x,description:x.name||x.description||''}));
  /* v11.44 hard-coded helper_total_cost to 0, silently discarding whatever the
     dispatcher typed into the still-visible Helper Total Cost box. Persist the
     real number when the field is on screen. */
  if(document.getElementById('d_helper_cost')){
    const helper=asNumber('d_helper_cost');
    if(helper!==null)d.helper_total_cost=helper;
  }
  return d;
};

/* Feed the new Diagnosis rows into the Quote builder so the two stages agree. */
const _v122QuoteDefaults=quoteBuilderDefaults;
quoteBuilderDefaults=function(wo,diagnosis,approval){
  const q=_v122QuoteDefaults(wo,diagnosis,approval);
  const savedMaterials=Array.isArray(q.materials)?q.materials:[];
  const savedShipping=Array.isArray(q.shipping)?q.shipping:[];
  if((diagnosis.materials||[]).length){
    q.materials=syncDiagnosisQuoteItems(diagnosis.materials,savedMaterials,'materials');
  }
  if((diagnosis.shipping||[]).length){
    const used=new Set();
    const synced=(diagnosis.shipping||[]).map(src=>{
      const match=savedShipping.find((x,i)=>!used.has(i)&&String(x.source_diagnosis_id||'')===String(src.id||''));
      if(match)used.add(savedShipping.indexOf(match));
      return {id:match?.id||safeId(),source_diagnosis_id:String(src.id||''),
              description:src.name||src.description||'',amount:moneyValue(src.amount)};
    });
    q.shipping=[...synced,...savedShipping.filter((x,i)=>!used.has(i)&&!x.source_diagnosis_id)];
  }
  return q;
};

/* ---------- 2 + 8: wrap the stage save actions ---------- */
function wrapStageSaveV122(name,stage,successLabel){
  const original=window[name];
  if(typeof original!=='function')return;
  window[name]=async function(complete,...rest){
    const btn=activeButtonV122();
    if(complete&&!stageGateV122(stage))return;
    clearFieldErrorsV122();
    const before=(document.getElementById('workflowNotice')?.className||'');
    const result=await original.call(this,complete,...rest);
    const noticeEl=document.getElementById('workflowNotice');
    const failed=/error/.test(noticeEl?.className||'')&&(noticeEl?.className||'')!==before;
    if(failed){toastV122('Save failed — see the message above','err');}
    else{
      flashButtonV122(btn,'Saved ✓');
      toastV122(complete?successLabel:'Draft saved');
    }
    return result;
  };
}
wrapStageSaveV122('saveArrival','arrival','Arrival saved');
wrapStageSaveV122('saveDiagnosis','diagnosis','Diagnosis saved');
wrapStageSaveV122('saveCompletion','completion','Work Done saved');

/* SYNCHRONIZE buttons get the same confirmation. */
for(const fnName of ['synchronizeFromDiagnosis','synchronizeFromQuote','synchronizeFromPayment']){
  const original=window[fnName];
  if(typeof original!=='function')continue;
  window[fnName]=async function(...args){
    const btn=activeButtonV122();
    try{
      const r=await original.apply(this,args);
      flashButtonV122(btn,'Synchronized ✓');
      toastV122('Stages synchronized');
      return r;
    }catch(e){
      toastV122('Synchronize failed: '+String(e?.message||e),'err');
      throw e;
    }
  };
}

/* Clear a field's error as soon as the dispatcher starts fixing it. */
document.addEventListener('input',e=>{
  const holder=e.target.closest?.('.v122-invalid');
  if(!holder)return;
  holder.classList.remove('v122-invalid');
  holder.querySelector('.v122-field-msg')?.remove();
},true);
document.addEventListener('change',e=>{
  const holder=e.target.closest?.('.v122-invalid');
  if(!holder)return;
  holder.classList.remove('v122-invalid');
  holder.querySelector('.v122-field-msg')?.remove();
},true);
