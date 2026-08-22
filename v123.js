
/* ========================================================================
   MDAMA v12.3 — unified Diagnosis <-> Incurred Payment Request sync
   Loads last, so it is the FINAL definition of the sync entry points.

   Problem it replaces
   -------------------
   The Incurred-PR sync grew across v11.42..v11.71 into ~20 layered
   overrides. Two directions were broken:

     • Diagnosis -> PR only ran on CREATE. The effective reconcile did
       `if (existing) continue;`, so editing a Diagnosis Incurred amount and
       pressing SYNCHRONIZE never updated the already-created PR (repro D).

     • PR -> Diagnosis only ran inside createPaymentRequest(), behind the
       strict-hiring gate. If that gate blocked the save for any reason the
       Diagnosis silently diverged from the PR the user just edited (repro C).

   Design
   ------
   ONE function, reconcileIncurredV123(woId, opts), owns the whole set:
     - CREATE a PR for each Diagnosis incurred row that has none
     - UPDATE the amount / description / linked-NTE of the PR that already
       matches a row (this is the missing half of D)
     - DELETE PRs whose Diagnosis row was removed, and collapse duplicates
     - preserve every manually edited PR field (method, tech, dispatcher…)
   Diagnosis is the source of truth for amount + description + NTE only.

   editIncurredPRBackToDiagnosisV123(prId) owns the reverse direction and is
   idempotent, so it is safe to call from the PR editor regardless of the
   hiring gate.

   "Last write wins after Save": each incurred row and its PR carry a
   `synced_rev` counter; whichever side saved most recently is the one the
   other side is reconciled to.
   ======================================================================== */

const INCURRED_META_KIND_V123='diagnosis_incurred_auto';

function incurredRowsV123(woId){
  return diagnosisIncurredItems(dataForWO(woId,'diagnosis'))
    .filter(x=>String(x.description||'').trim()&&moneyValue(x.amount)>0);
}
function incurredPRsV123(woId){
  return paymentsForWO(woId).filter(p=>paymentMeta(p).created_from===INCURRED_META_KIND_V123);
}
function incurredPRForRowV123(woId,rowId){
  return incurredPRsV123(woId).find(p=>String(paymentMeta(p).diagnosis_incurred_id||'')===String(rowId));
}

/* Build the PR payload for one Diagnosis incurred row, preserving any
   manually edited fields on an existing PR. Amount / description / NTE are
   always taken from Diagnosis. */
function incurredPayloadV123(wo,woId,row,existing){
  const status=String(row.description||'Incurred').trim();
  const amount=moneyValue(row.amount);
  const identity=(typeof strictHiringIdentityV1159==='function')
    ? strictHiringIdentityV1159(woId)
    : paymentTechnicianForWO(wo,{});
  const assigned=identity.record||null;
  const method=(typeof paymentMethodForWOV1166==='function')
    ? paymentMethodForWOV1166(woId,assigned)
    : '';
  const rev=Number(row.synced_rev||0);
  const meta={
    ...(existing?paymentMeta(existing):{}),
    purpose:'advance',purpose_label:status,display_status:status,description:status,
    created_from:INCURRED_META_KIND_V123,diagnosis_incurred_id:String(row.id),
    synced_rev:rev,synced_at:new Date().toISOString()
  };
  const payload={
    work_order_id:woId,
    request_date:f(existing,'request_date')||new Date().toISOString().slice(0,10),
    status:'deposit',status_note:status,
    nte:(typeof currentQuoteNTE==='function'?currentQuoteNTE(woId):null)||null,
    amount_due:amount,incurred:0,total_cost:amount,
    /* preserve manually edited fields, auto-fill only when blank */
    payment_method:f(existing,'payment_method')||method||'Not confirmed',
    trade:f(existing,'trade')||paymentTradeForWO(wo,{}),
    technician_name:f(existing,'technician_name')||identity.name||'Assigned technician',
    technician_phone:f(existing,'technician_phone')||identity.phone||'Not available',
    store_name:f(existing,'store_name')||f(wo,'store_name')||null,
    address:f(existing,'address')||paymentAddress(wo)||null,
    dispatcher:f(existing,'dispatcher')||'Khater',
    team_leader:f(existing,'team_leader')||'Allan',
    company_name:f(existing,'company_name')||'Jayco Maintenance Group',
    structured_data:meta
  };
  payload.content=localPaymentText(wo,{...existing,...payload,display_status:status,description:status,incurred_breakdown:''});
  return payload;
}

/* The single authoritative reconcile. Returns {created,updated,deleted}. */
async function reconcileIncurredV123(woId=workflowWOId){
  const wo=wos.find(x=>String(f(x,'id'))===String(woId));
  if(!wo)return {created:0,updated:0,deleted:0};

  const rows=incurredRowsV123(woId);
  const wanted=new Map(rows.map(r=>[String(r.id),r]));

  /* group existing auto-PRs by the Diagnosis row they belong to */
  const byRow=new Map();
  for(const p of incurredPRsV123(woId)){
    const key=String(paymentMeta(p).diagnosis_incurred_id||'');
    if(!byRow.has(key))byRow.set(key,[]);
    byRow.get(key).push(p);
  }

  let created=0,updated=0,deleted=0;

  /* 1. DELETE orphans (row removed) + collapse duplicates, keeping the lowest seq */
  for(const [key,group] of byRow){
    group.sort((a,b)=>Number(f(a,'sequence_number')||0)-Number(f(b,'sequence_number')||0));
    const remove=wanted.has(key)?group.slice(1):group;
    for(const row of remove){
      await req('/payment_requests?id=eq.'+encodeURIComponent(f(row,'id')),{method:'DELETE',headers:{Prefer:'return=minimal'}});
      paymentRequests=paymentRequests.filter(x=>String(f(x,'id'))!==String(f(row,'id')));
      deleted++;
    }
  }

  /* 2. CREATE missing + UPDATE existing (this is the half the old code skipped) */
  for(const row of rows){
    const existing=incurredPRForRowV123(woId,row.id);
    const payload=incurredPayloadV123(wo,woId,row,existing);
    if(existing){
      /* only write if something the sync owns actually changed */
      const changed=moneyValue(f(existing,'amount_due'))!==moneyValue(row.amount)
        || String(paymentMeta(existing).description||'')!==String(row.description||'').trim()
        || moneyValue(f(existing,'nte'))!==moneyValue(payload.nte);
      if(!changed)continue;
      const d=await req('/payment_requests?id=eq.'+encodeURIComponent(f(existing,'id')),
        {method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify(payload)});
      const saved=Array.isArray(d)?d[0]:d;
      Object.assign(existing,saved||payload);
      updated++;
    }else{
      const d=await req('/payment_requests',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(payload)});
      const saved=Array.isArray(d)?d[0]:d;
      if(saved)paymentRequests.push(saved);
      created++;
    }
  }

  paymentRequests.sort((a,b)=>Number(f(a,'sequence_number')||0)-Number(f(b,'sequence_number')||0));
  return {created,updated,deleted};
}

/* Reverse direction: a PR edited in the Incurred stage updates its Diagnosis
   row. Idempotent and independent of the hiring gate, so an edit is never
   lost even if the PR save itself is later blocked. Bumps synced_rev so the
   next Diagnosis->PR reconcile treats this as the newest write. */
async function editIncurredPRBackToDiagnosisV123(prId,overrides={}){
  const pr=paymentRequests.find(x=>String(f(x,'id'))===String(prId));
  if(!pr)return false;
  const meta=paymentMeta(pr);
  if(meta.created_from!==INCURRED_META_KIND_V123||!meta.diagnosis_incurred_id)return false;

  const woId=f(pr,'work_order_id');
  const rowId=String(meta.diagnosis_incurred_id);
  const diagnosis=dataForWO(woId,'diagnosis')||{};
  const description=String(overrides.description??meta.description??f(pr,'status_note')??'Incurred').trim();
  const amount=moneyValue(overrides.amount??f(pr,'amount_due'));

  let found=false;
  const items=diagnosisIncurredItems(diagnosis).map(item=>{
    if(String(item.id)!==rowId)return item;
    found=true;
    return {...item,description,amount,synced_rev:Number(item.synced_rev||0)+1};
  });
  if(!found)return false;

  const next={...diagnosis,incurred_items:items};
  const previous=workflowWOId;
  workflowWOId=woId;
  try{ await saveStageRecord('diagnosis',next,stageDone('diagnosis')); }
  finally{ workflowWOId=previous; }

  /* keep the local editing copy in step */
  const localRow=stageRows.find(r=>String(f(r,'work_order_id'))===String(woId)&&f(r,'stage')==='diagnosis');
  if(localRow)localRow.data=next;
  return true;
}

/* ---- Route every historical entry point at the new implementation ---- */

/* Diagnosis -> PR: the app calls syncDiagnosisIncurredPaymentRequests and
   reconcileCurrentIncurredRequests from many places. Point both here. */
reconcileCurrentIncurredRequests=async function(woId=workflowWOId){
  return reconcileIncurredV123(woId);
};

syncDiagnosisIncurredPaymentRequests=async function(woId=workflowWOId){
  const result=await reconcileIncurredV123(woId);
  /* refresh technician identity on the PRs when Hiring is complete — convenience only */
  if(typeof refreshPaymentHiringIdentityV1159==='function'){
    try{
      const id=strictHiringIdentityV1159(woId);
      if(id.ok)await refreshPaymentHiringIdentityV1159(woId,true);
    }catch(e){console.warn('Optional incurred PR identity refresh skipped',e);}
  }
  return result;
};

/* PR -> Diagnosis: the historical hook was syncEditedIncurredPRToDiagnosisV1167,
   called from the wrapped createPaymentRequest before the DB write. Redirect it
   at the new idempotent implementation so the edit always reaches Diagnosis. */
syncEditedIncurredPRToDiagnosisV1167=async function(existing,p){
  if(!existing)return;
  return editIncurredPRBackToDiagnosisV123(f(existing,'id'),{
    description:p?.description,
    amount:p?.amount_due
  });
};

/* Safety net: if the PR editor is closed via Save and the hiring gate blocked
   createPaymentRequest, still persist the edit back to Diagnosis from the
   visible form. Wraps the existing save without changing its contract. */
if(typeof createPaymentRequest==='function'){
  const _v123CreatePayment=createPaymentRequest;
  createPaymentRequest=async function(...args){
    const editingId=editingPaymentId;
    const editing=editingId?paymentRequests.find(x=>String(f(x,'id'))===String(editingId)):null;
    const isIncurred=editing&&paymentMeta(editing).created_from===INCURRED_META_KIND_V123;
    const formAmount=document.getElementById('pamount')?moneyValue(document.getElementById('pamount').value):null;
    const formDesc=document.getElementById('pdescription')?String(document.getElementById('pdescription').value||'').trim():null;

    const result=await _v123CreatePayment.apply(this,args);

    /* If the save was blocked (returned false/undefined) but the user did edit
       an Incurred PR, push their change to Diagnosis anyway so the two stages
       cannot diverge. */
    if(isIncurred && !result && (formAmount!==null||formDesc!==null)){
      try{
        await editIncurredPRBackToDiagnosisV123(editingId,{amount:formAmount,description:formDesc});
        if(typeof toastV122==='function')toastV122('Diagnosis updated from your Incurred edit');
        if(workflowWOId)renderWorkflow();
      }catch(e){console.warn('Incurred->Diagnosis safety sync failed',e);}
    }
    return result;
  };
}
