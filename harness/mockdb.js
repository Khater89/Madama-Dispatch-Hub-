/* Minimal in-memory PostgREST emulator for MDAMA demo runs. */
const crypto = require('crypto');

const uuid = () => crypto.randomUUID();

class MockDB {
  constructor(){
    this.tables = {
      technicians: [], work_orders: [], app_settings: [{id:'default',openai_model:'gpt-5.4-mini',training_revision:'MDAMA-Jayco-v7-workflow'}],
      work_order_documents: [], work_order_stage_data: [], work_order_files: [],
      payment_requests: [], work_order_candidates: [], work_order_status_history: [],
      technician_interactions: [], technician_classification_history: [], work_order_alerts: [],
      wo_candidates_findclose: [], wo_candidates_external: [], company_techs: [],
      quo_manual_routes: [], worked_with_technicians: [], yelp_search_results: [],
      profiles: [],
      // restored by the v12.1 migrations
      live_search_technicians: [], search_phone_exclusions: [], vendors: [], vendor_technicians: [],
      // tables the app calls but that ship with NO migration in this package:
      // vendors, vendor_technicians, live_search_technicians, search_phone_exclusions
    };
    this.log = [];
    this.missingTableHits = new Set();
  }

  parseQuery(qs){
    const params = new URLSearchParams(qs || '');
    const filters = [];
    let select = '*', order = null, limit = null, onConflict = null;
    for (const [k, v] of params.entries()){
      if (k === 'select') { select = v; continue; }
      if (k === 'order')  { order = v;  continue; }
      if (k === 'limit')  { limit = Number(v); continue; }
      if (k === 'on_conflict') { onConflict = v.split(','); continue; }
      if (k === 'offset') continue;
      filters.push([k, v]);
    }
    return { filters, select, order, limit, onConflict };
  }

  matches(row, filters){
    return filters.every(([col, expr]) => {
      const m = String(expr).match(/^([a-z]+)\.(.*)$/s);
      if (!m) return true;
      const [, op, raw] = m;
      const val = row[col];
      const cmp = raw === 'null' ? null : raw;
      switch(op){
        case 'eq':  return String(val) === String(cmp);
        case 'neq': return String(val) !== String(cmp);
        case 'is':  return cmp === 'null' ? (val === null || val === undefined) : String(val) === String(cmp);
        case 'in':  return raw.replace(/^\(|\)$/g,'').split(',').map(x=>x.replace(/^"|"$/g,'')).includes(String(val));
        case 'gte': return Number(val) >= Number(cmp);
        case 'lte': return Number(val) <= Number(cmp);
        case 'gt':  return Number(val) >  Number(cmp);
        case 'lt':  return Number(val) <  Number(cmp);
        case 'ilike': return new RegExp('^'+String(raw).replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/%/g,'.*')+'$','i').test(String(val??''));
        case 'not': return true;
        default: return true;
      }
    });
  }

  handle(method, path, body, headers){
    const [rawTable, qs] = path.replace(/^\//, '').split('?');
    const table = rawTable;
    this.log.push({ method, table, qs });

    if (!(table in this.tables)){
      this.missingTableHits.add(table);
      return { status: 404, body: { code:'PGRST205', message:`Could not find the table 'public.${table}' in the schema cache` } };
    }

    const q = this.parseQuery(qs);
    let rows = this.tables[table];

    if (method === 'GET'){
      let out = rows.filter(r => this.matches(r, q.filters));
      if (q.order){
        const [col, dir] = q.order.split('.');
        out = out.slice().sort((a,b) => {
          const x = a[col], y = b[col];
          if (x === y) return 0;
          return ((x > y) ? 1 : -1) * (dir === 'desc' ? -1 : 1);
        });
      }
      if (q.limit != null) out = out.slice(0, q.limit);
      return { status: 200, body: out, headers:{ 'content-range': `0-${Math.max(out.length-1,0)}/${out.length}` } };
    }

    if (method === 'POST'){
      const items = Array.isArray(body) ? body : [body];
      const saved = [];
      for (const item of items){
        const rec = { ...item };
        let existing = null;
        if (q.onConflict){
          existing = rows.find(r => q.onConflict.every(c => String(r[c]) === String(rec[c])));
        }
        if (existing && /merge-duplicates/.test(headers.Prefer || '')){
          Object.assign(existing, rec);
          saved.push(existing);
        } else {
          if (!rec.id) rec.id = uuid();
          if (!rec.created_at) rec.created_at = new Date().toISOString();
          this.applyTriggers(table, rec, rows);
          rows.push(rec);
          saved.push(rec);
        }
      }
      return { status: 201, body: saved };
    }

    if (method === 'PATCH'){
      const hit = rows.filter(r => this.matches(r, q.filters));
      hit.forEach(r => Object.assign(r, body, { updated_at: new Date().toISOString() }));
      return { status: 200, body: hit };
    }

    if (method === 'DELETE'){
      const keep = rows.filter(r => !this.matches(r, q.filters));
      const removed = rows.length - keep.length;
      this.tables[table] = keep;
      return { status: 200, body: [] , removed };
    }

    return { status: 405, body: { message: 'method not allowed' } };
  }

  applyTriggers(table, rec, rows){
    if (table === 'work_order_documents' && rec.version == null){
      const same = rows.filter(r => r.work_order_id === rec.work_order_id && r.document_type === rec.document_type);
      rec.version = same.reduce((a,r)=>Math.max(a, r.version||0), 0) + 1;
    }
    if (table === 'payment_requests'){
      // mirrors public.prepare_payment_request()
      let s = String(rec.status || '').trim().toLowerCase().replace(/ /g,'_');
      if (s === 'job_done') s = 'work_done';
      if (!['assessment_completed','deposit','work_done'].includes(s)){
        const err = new Error('Choose a valid payment request status first.');
        err.__pg = true; throw err;
      }
      rec.status = s;
      if (rec.sequence_number == null){
        const same = rows.filter(r => r.work_order_id === rec.work_order_id);
        rec.sequence_number = same.reduce((a,r)=>Math.max(a, r.sequence_number||0),0) + 1;
      }
    }
  }
}

module.exports = { MockDB, uuid };
