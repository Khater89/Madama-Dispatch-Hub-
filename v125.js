
/* ========================================================================
   MDAMA v12.5 — reliable, confirmed, truly two-way Quote <-> Diagnosis sync
   Loads last.

   Two real bugs this fixes
   ------------------------
   A) STALE BUTTON HANDLERS. renderApproval() (v11.36) runs:
          btn.onclick = synchronizeFromQuote;
      That copies the function VALUE that existed at render time — the old
      v11.35 sync that only knew parts + equipment. Later modules (v12.4)
      reassigned the GLOBAL synchronizeFromQuote, but the button kept pointing
      at the old copy. So the user's click still ran the old sync and Materials
      / Other Special Fees were dropped. (This is why the fix "worked" in a
      direct-call test but not when the button was clicked.)
      Same trap for the Diagnosis-stage SYNCHRONIZE button.

   B) ONE-WAY RESULT. Each button pushed one direction only, overwriting the
      other stage. The user wants both stages to end up with the SAME content
      ("بنفس المحتوى") based on the LATEST edit ("مزامنة اخر تعديل").

   What this module does
   ---------------------
   1. Re-binds both SYNCHRONIZE buttons, after every render, to a stable
      dispatcher that (a) asks for confirmation, then (b) runs a single
      two-way merge — never the stale captured reference.
   2. runTwoWaySyncV125(): merges Diagnosis and Quote line items so both hold
      the identical set, choosing the side that was edited most recently as the
      source of truth, then writes BOTH the Diagnosis stage row and the Quote
      (approval.quote_builder) so neither keeps orphan entries.
   3. Confirmation dialog before syncing.
   ======================================================================== */

/* ---------- which side was edited last ---------- */
function stageEditedAtV125(woId,stage){
  const row=stageRows.find(r=>String(f(r,'work_order_id'))===String(woId)&&f(r,'stage')===stage);
  const t=row&&(f(row,'updated_at')||f(row,'completed_at')||f(row,'created_at'));
  return t?new Date(t).getTime():0;
}

/* Build a canonical line-item view from whichever stage we treat as source. */
function quoteToDiagShapeV125(q,old){
  /* reuse the v12.4 mapper if present, else fall back to a minimal map */
  if(typeof syncDiagnosisItemsAllV124==='function')return syncDiagnosisItemsAllV124(q,old);
  return {...old,parts:q.parts||[],materials:q.materials||[],equipment:q.equipment||[],shipping:q.shipping||[]};
}
function diagToQuoteShapeV125(d,savedQuote){
  /* Start from the saved Quote so labour rates / hours / markup are kept... */
  const wo=workflowWO();
  const base=(typeof quoteBuilderDefaults==='function')
    ? quoteBuilderDefaults(wo,d,{quote_builder:savedQuote||{}})
    : (savedQuote||{});

  /* ...but the LINE ITEMS must be an EXACT mirror of Diagnosis, so a row the
     user deleted in Diagnosis does not survive on the Quote side. Rebuild all
     four sections strictly from Diagnosis, keeping the matching saved row's
     id/rate only where a Diagnosis row still exists. "بنفس المحتوى". */
  const savedBy=(list)=>{const m=new Map();(list||[]).forEach(x=>{const k=String(x.source_diagnosis_id||x.id||'');if(k)m.set(k,x);});return m;};
  const sP=savedBy(savedQuote?.parts), sM=savedBy(savedQuote?.materials),
        sE=savedBy(savedQuote?.equipment), sS=savedBy(savedQuote?.shipping);

  base.parts=(d.parts||[]).map(x=>{const p=sP.get(String(x.id))||{};
    return {id:p.id||safeId(),source_diagnosis_id:String(x.id||''),description:x.name||'',
      quantity:Number(x.quantity||1),unit_cost:moneyValue(x.unit_price),sales_tax:moneyValue(x.sales_tax)};});
  base.materials=(d.materials||[]).map(x=>{const p=sM.get(String(x.id))||{};
    return {id:p.id||safeId(),source_diagnosis_id:String(x.id||''),description:x.name||'',
      quantity:Number(x.quantity||1),unit_cost:moneyValue(x.unit_price)};});
  base.equipment=(d.equipment||[]).map(x=>{const p=sE.get(String(x.id))||{};
    return {id:p.id||safeId(),source_diagnosis_id:String(x.id||''),description:x.name||'',
      quantity:Number(x.quantity||1),unit_cost:moneyValue(x.cost)};});
  base.shipping=(d.shipping||[]).map(x=>{const p=sS.get(String(x.id))||{};
    return {id:p.id||safeId(),source_diagnosis_id:String(x.id||''),
      description:x.name||x.description||'',amount:moneyValue(x.amount)};});
  return base;
}

/* The single two-way merge. Returns a short human summary of what happened. */
async function runTwoWaySyncV125(woId=workflowWOId){
  const wo=wos.find(x=>String(f(x,'id'))===String(woId));
  if(!wo)throw new Error('Work Order not found.');

  /* Pull the freshest picture of each side.
     - If the Quote builder is on screen, its DOM is the freshest Quote.
     - The Diagnosis stage row is the freshest Diagnosis (its inputs are
       committed to the row on save / on tab switch). */
  const diag=dataForWO(woId,'diagnosis')||{};
  const approvalRow=stageRows.find(r=>String(f(r,'work_order_id'))===String(woId)&&f(r,'stage')==='approval');
  const savedQuote=(f(approvalRow,'data')?.quote_builder&&typeof f(approvalRow,'data').quote_builder==='object')
    ? f(approvalRow,'data').quote_builder : {};
  const liveQuote=($('q_main_rate')&&String(workflowWOId)===String(woId))
    ? collectQuoteBuilder() : savedQuote;

  /* Decide the source of truth: the side edited most recently. */
  const diagAt=stageEditedAtV125(woId,'diagnosis');
  const quoteAt=stageEditedAtV125(woId,'approval');
  const quoteIsLive=Boolean($('q_main_rate')&&String(workflowWOId)===String(woId));
  /* a live, on-screen Quote counts as "just edited" */
  const quoteWins=quoteIsLive?true:(quoteAt>=diagAt);

  let summary;
  if(quoteWins){
    /* Quote -> Diagnosis: rebuild Diagnosis line items from the Quote. */
    const next=quoteToDiagShapeV125(liveQuote,diag);
    await persistSyncedDiagnosis(next);
    const localDiag=stageRows.find(r=>String(f(r,'work_order_id'))===String(woId)&&f(r,'stage')==='diagnosis');
    if(localDiag)localDiag.data=next;
    /* also persist the Quote so its saved copy matches what is on screen */
    if(typeof saveWorkflowQuote==='function'&&quoteIsLive){
      try{await saveWorkflowQuote('sync');}catch(e){console.warn('Quote save during sync skipped',e);}
    }
    summary='Diagnosis updated to match the Quote (Quote had the latest edit).';
  }else{
    /* Diagnosis -> Quote: rebuild the Quote builder from Diagnosis, save it. */
    const nextQuote=diagToQuoteShapeV125(diag,savedQuote);
    const nextApproval={...(f(approvalRow,'data')||{}),quote_builder:nextQuote,
      last_synchronized_from:'diagnosis',last_synchronized_at:new Date().toISOString()};
    await saveStageRecord('approval',nextApproval,approvalRow?b(f(approvalRow,'completed')):false);
    const localAppr=stageRows.find(r=>String(f(r,'work_order_id'))===String(woId)&&f(r,'stage')==='approval');
    if(localAppr)localAppr.data=nextApproval;
    summary='Quote updated to match Diagnosis (Diagnosis had the latest edit).';
  }

  /* Keep the linked Incurred Payment Requests aligned too. */
  if(typeof syncDiagnosisIncurredPaymentRequests==='function'){
    try{await syncDiagnosisIncurredPaymentRequests(woId);}catch(e){console.warn('Incurred PR refresh after sync skipped',e);}
  }

  renderAll();
  if(String(workflowWOId)===String(woId))renderWorkflow();
  return summary;
}

/* ---------- confirmation dialog ---------- */
function confirmSyncV125(onConfirm){
  const diagAt=stageEditedAtV125(workflowWOId,'diagnosis');
  const quoteAt=stageEditedAtV125(workflowWOId,'approval');
  const quoteLive=Boolean(document.getElementById('q_main_rate'));
  const winner=(quoteLive||quoteAt>=diagAt)?'Quote':'Diagnosis';
  const other=winner==='Quote'?'Diagnosis':'Quote';

  /* prefer an in-page modal; fall back to window.confirm */
  let overlay=document.getElementById('v125SyncConfirm');
  if(overlay)overlay.remove();
  overlay=document.createElement('div');
  overlay.id='v125SyncConfirm';
  overlay.style.cssText='position:fixed;inset:0;background:rgba(15,23,32,.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px';
  overlay.innerHTML=`
    <div style="background:var(--card,#fff);color:var(--fg,#17202a);max-width:440px;width:100%;border-radius:14px;padding:22px 22px 18px;box-shadow:0 20px 60px rgba(0,0,0,.35)">
      <div style="font-size:17px;font-weight:700;margin-bottom:10px">Synchronize the latest edit?</div>
      <div style="font-size:14px;line-height:1.6;margin-bottom:6px">
        This makes <b>Diagnosis</b> and <b>Quote</b> hold the same line items
        (Parts, Materials, Equipment, Other Special Fees).
      </div>
      <div style="font-size:13px;line-height:1.6;background:var(--btn-bg,#eef4f3);border-radius:9px;padding:10px 12px;margin-bottom:16px">
        The <b>${winner}</b> currently has the most recent change, so the
        <b>${other}</b> will be updated to match it.
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button id="v125SyncCancel" class="btn ghost" type="button">Cancel</button>
        <button id="v125SyncGo" class="btn success" type="button">Yes, sync ${winner} → ${other}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close=()=>overlay.remove();
  overlay.addEventListener('click',e=>{if(e.target===overlay)close();});
  document.getElementById('v125SyncCancel').onclick=close;
  document.getElementById('v125SyncGo').onclick=async()=>{
    close();
    await onConfirm();
  };
}

/* ---------- stable dispatcher used by BOTH buttons ---------- */
async function dispatchSyncV125(){
  confirmSyncV125(async()=>{
    const btn=(typeof activeButtonV125Ref!=='undefined'&&activeButtonV125Ref)||null;
    try{
      const summary=await runTwoWaySyncV125(workflowWOId);
      if(typeof toastV122==='function')toastV122('Synchronized ✓');
      note('workflowNotice',summary,'success');
    }catch(e){
      if(typeof toastV122==='function')toastV122('Sync failed: '+String(e?.message||e),'err');
      note('workflowNotice','Could not synchronize: '+String(e?.message||e),'error');
    }
  });
}

/* ---------- re-bind the buttons after every workflow render ---------- */
function rebindSyncButtonsV125(){
  const ids=['quoteSynchronizeBtn','diagnosisSynchronizeBtn'];
  for(const id of ids){
    const btn=document.getElementById(id);
    if(!btn||btn.dataset.v125Bound)continue;
    btn.dataset.v125Bound='1';
    btn.onclick=dispatchSyncV125;              // always the stable dispatcher
    btn.textContent='SYNCHRONIZE';
  }
}

/* Some Diagnosis-stage variants label the button differently or attach it in a
   later render layer; catch any SYNCHRONIZE button by text as a safety net. */
function rebindSyncButtonsByTextV125(){
  const root=document.getElementById('stageContent');
  if(!root)return;
  root.querySelectorAll('button').forEach(btn=>{
    if(btn.dataset.v125Bound)return;
    if(/^\s*synchronize\s*$/i.test(btn.textContent||'')){
      btn.dataset.v125Bound='1';
      btn.onclick=dispatchSyncV125;
    }
  });
}

const _v125RenderWorkflow=renderWorkflow;
renderWorkflow=function(...a){
  const r=_v125RenderWorkflow.apply(this,a);
  requestAnimationFrame(()=>{rebindSyncButtonsV125();rebindSyncButtonsByTextV125();});
  return r;
};
const _v125RenderStageContent=renderStageContent;
renderStageContent=function(...a){
  const r=_v125RenderStageContent.apply(this,a);
  requestAnimationFrame(()=>{rebindSyncButtonsV125();rebindSyncButtonsByTextV125();});
  return r;
};

/* bind once on load in case a stage is already on screen */
requestAnimationFrame(()=>{rebindSyncButtonsV125();rebindSyncButtonsByTextV125();});
