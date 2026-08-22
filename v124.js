
/* ========================================================================
   MDAMA v12.4 — complete two-way Quote <-> Diagnosis line-item sync
   Loads last, so it is the FINAL definition of these sync helpers.

   Problem it replaces
   -------------------
   v12.2 added Materials and "Other Special Fees" to the Diagnosis stage and
   pushed them Diagnosis -> Quote. But the reverse path was still the original
   v11.35 code, which only knew about parts + equipment:

     syncDiagnosisFromQuote() mapped ONLY q.parts and q.equipment.
     syncDiagnosisItems()     wrote ONLY next.parts and next.equipment.

   So pressing SYNCHRONIZE in the Quote stage silently dropped any Material or
   Special-Fee line the dispatcher added there — it never appeared back in
   Diagnosis (user repro: "لم يتم اضافة الحقول الموجودة في ال qute الى
   diagnosis بعد المزامنة").

   Fix
   ---
   Redefine both helpers to carry all FOUR sections (parts, materials,
   equipment, shipping/Other Special Fees) in both directions, preserving any
   Diagnosis-only fields (part_trade, part_type, brand_model, specs,
   possession_type, photos) on rows that already existed.
   ======================================================================== */

/* Map a Quote builder line back into a Diagnosis row of the right shape,
   keeping whatever the Diagnosis row already had for that id. */
function diagRowFromQuoteV124(kind,x,prior){
  const id=x.source_diagnosis_id||x.id||safeId();
  if(kind==='parts'){
    const trade=prior?.part_trade||defaultPartTradeFromWO()||'Other Part';
    const type=prior?.part_type||Object.keys(PART_CATALOG[trade]||{})[0]||'General Part';
    return {...(prior||{}),id,part_trade:trade,part_type:type,
      name:x.description||prior?.name||'Part',
      brand_model:prior?.brand_model||'Not specified',
      specs:prior?.specs||'Added from Quote',
      quantity:moneyValue(x.quantity||1),unit_price:moneyValue(x.unit_cost),sales_tax:moneyValue(x.sales_tax)};
  }
  if(kind==='equipment'){
    return {...(prior||{}),id,name:x.description||prior?.name||'Equipment',
      possession_type:prior?.possession_type||'ownership',
      quantity:moneyValue(x.quantity||1),cost:moneyValue(x.unit_cost)};
  }
  if(kind==='materials'){
    return {...(prior||{}),id,name:x.description||prior?.name||'Material',
      quantity:moneyValue(x.quantity||1),unit_price:moneyValue(x.unit_cost),source:prior?.source||''};
  }
  /* shipping === Other Special Fees */
  return {...(prior||{}),id,name:x.description||prior?.name||prior?.description||'Special fee',
    description:x.description||prior?.description||'',amount:moneyValue(x.amount)};
}

/* Rebuild every Diagnosis line section from the current Quote builder,
   matching by source_diagnosis_id so existing rows keep their extra fields. */
function syncDiagnosisItemsAllV124(q,old){
  const next={...old};
  const bucket=(items,kind,oldList)=>(items||[]).map(x=>{
    const key=String(x.source_diagnosis_id||x.id||'');
    const prior=(oldList||[]).find(p=>String(p.id)===key);
    return diagRowFromQuoteV124(kind,x,prior);
  });
  next.parts     = bucket(q.parts,     'parts',     old.parts);
  next.materials = bucket(q.materials, 'materials', old.materials);
  next.equipment = bucket(q.equipment, 'equipment', old.equipment);
  next.shipping  = bucket(q.shipping,  'shipping',  old.shipping);
  next._pricing_revision={fingerprint:(typeof pricingFingerprint==='function'?pricingFingerprint(next):''),
    source:'quote',changed_at:new Date().toISOString()};
  return next;
}

/* FINAL definition: Quote -> Diagnosis carries all four sections. */
syncDiagnosisFromQuote=async function(){
  const q=collectQuoteBuilder();
  const old=dataForWO(workflowWOId,'diagnosis')||{};
  const next=syncDiagnosisItemsAllV124(q,old);
  await persistSyncedDiagnosis(next);
  /* keep the in-memory editing copy aligned so a re-render shows the rows */
  const localRow=stageRows.find(r=>String(f(r,'work_order_id'))===String(workflowWOId)&&f(r,'stage')==='diagnosis');
  if(localRow)localRow.data=next;
  return q;
};

/* Some code paths call syncDiagnosisItems(items,source) directly (e.g. the
   Payment cost-breakdown panel). Keep that entry point working AND make it
   preserve materials/shipping instead of wiping them: it only carried parts +
   equipment before, so the other two sections were lost whenever it ran. */
const _v124SyncDiagnosisItems=syncDiagnosisItems;
syncDiagnosisItems=function(items,source='payment'){
  const next=_v124SyncDiagnosisItems(items,source);   // fills parts + equipment as before
  const old=dataForWO(workflowWOId,'diagnosis')||{};
  const hasKind=k=>Array.isArray(items)&&items.some(x=>x.kind===k);
  /* if the incoming item list doesn't mention materials/shipping, keep whatever
     Diagnosis already had rather than dropping those sections */
  if(!hasKind('materials'))next.materials=old.materials||[];
  else next.materials=items.filter(x=>x.kind==='materials')
        .map(x=>diagRowFromQuoteV124('materials',{...x,unit_cost:x.unit_price},
          (old.materials||[]).find(p=>String(p.id)===String(x.id))));
  if(!hasKind('shipping'))next.shipping=old.shipping||[];
  else next.shipping=items.filter(x=>x.kind==='shipping')
        .map(x=>diagRowFromQuoteV124('shipping',{...x,amount:x.amount??x.unit_price},
          (old.shipping||[]).find(p=>String(p.id)===String(x.id))));
  return next;
};

/* Re-render Diagnosis after a Quote->Diagnosis sync so the new rows are
   visible immediately if the user switches back to the Diagnosis tab. */
const _v124SyncFromQuote=synchronizeFromQuote;
synchronizeFromQuote=async function(...args){
  const r=await _v124SyncFromQuote.apply(this,args);
  try{ if(workflowStageView==='diagnosis')renderDiagnosis(); }catch{}
  return r;
};
