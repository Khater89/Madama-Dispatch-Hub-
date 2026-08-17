// ============================================================================
// MDAMA Dispatch — company-specialized AI assistant
// Tasks: classify/extract pasted documents, generate quotes, generate payment
// requests. Company rules are centralized in this function; app_settings only
// stores the selected model and is never required for extraction.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "Content-Type": "application/json" },
});

const TRADES = [
  "Plumber", "Electrical", "HVAC", "Handyman", "Appliance Repair",
  "Locksmith", "Glass Repair", "Power Washing", "Landscaping",
  "Snow Removal", "Junk Removal",
];
const ETA_CODES = ["P4", "P24", "P48", "P72", "P5", "P30", "ND10"];

function jsonKeyValues(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object") return Object.values(value).map(String).filter(Boolean);
  } catch { /* legacy/non-JSON env */ }
  return [raw].filter(Boolean);
}
function requestIsAuthorized(req: Request): boolean {
  const supplied = (req.headers.get("apikey") || "").trim();
  if (!supplied) return false;
  const allowed = new Set<string>();
  jsonKeyValues(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || undefined).forEach(k => allowed.add(k));
  const legacyAnon = Deno.env.get("SUPABASE_ANON_KEY");
  if (legacyAnon) allowed.add(legacyAnon);
  return allowed.has(supplied);
}

const COMPANY_TRAINING = [
  "You are the document and dispatch specialist for Jayco Maintenance inside MDAMA Dispatch.",
  "First classify the pasted content as exactly one of: work_order, quote, payment_request.",
  "Never confuse the three: SOW is the store report; Tech report is the technician finding; Required to is the supported repair plan; Quote is the client charge; Payment Request is the technician payment.",
  "For a work order extract every explicit field, including WO number, client, trade, SOW, summary, complete address, street/city/state/ZIP/region, best contact and phone, time zone, and special instructions.",
  "Also write problem_explanation_ar as a concise, information-rich Arabic-only briefing: the reported problem, the most relevant possible causes, the required inspection, and one short safety/approval note. Keep it roughly 60-110 Arabic words. Never present an unstated cause, part, price, or repair as confirmed.",
  "Also create a dispatcher brief that explains the issue to understand, the correct trade to hire, questions for the New Hiring call, tools/equipment the technician must have on hand, required confirmations, and access/dispatch notes. Never request or require photo uploads. Base it only on the WO and company rules; never invent a diagnosis.",
  "A trade may be selected only when the source explicitly names the trade or clearly describes a matching issue or asset. If the source has no identifiable issue, return null for trade and an empty recommended_trade. Never guess a trade from the client name, alert status, location, generic maintenance wording, or unrelated codes.",
  "Do not add required tools or equipment unless they are explicitly requested or a specific company rule is triggered by an identified trade and issue. If the issue and trade are unknown, required_on_hand must be empty.",
  "Company confirmation rules: full diagnosis and repair plan; do not repair before approval; manager sign-off; direct manager-on-duty confirmation before final payment. Do not ask for Arrival, Before, After, parts, equipment, label, or any other photos.",
  "Specific dispatch rules: HVAC and Appliance work requires a ladder. Lights-out work requires a ladder and ballast check. Overflow/back-up/clog work requires a 100ft+ snake or hydrojet as appropriate; all bathrooms overflowing means assess the main line.",
  "Priority is Normal by default. Set Emergency only when the source contains the standalone code EMG or P4. Other ETA codes stay Normal.",
  "Do not invent missing facts, diagnosis, parts, prices, hours, tax, helper, equipment, names, dates, or addresses. Return null when absent.",
  "Trade must be one supported MDAMA trade. Plumbing covers toilets, faucets, sinks, drains, pipes, and water; Electrical covers lights, outlets, breakers, wiring, panels, generators, and fuses; HVAC covers heating/cooling and rooftop units; Appliance Repair covers refrigerators, freezers, ice machines, ovens, dishwashers, washers, and dryers; Handyman covers drywall, ceiling tiles, doors, painting, flooring, and general repairs.",
  "Quote rules: use WO/Address/SOW/Tech report/Required to/Incurred/Repair/Parts + materials/Equipment/Total. Use only supported steps. Helper only if explicitly stated. Parts markup is 1.47 only when a source parts cost is supplied. technician_total_cost is the technician’s final agreed total, NOT automatically labor-only; parts/equipment may already be included. Never add technician_total_cost to parts/equipment unless the saved diagnosis explicitly confirms they are separate. End with the suitable final test or final inspection and Clean the working area.",
  "Payment Request rules: statuses are Assessment completed, Deposit, or Job Done. The client initial NTE is reference only and must never drive a Payment Request. Payment Request NTE is the generated/approved Quote total when available. For the Final Payment only: Total cost is the agreed Tech + Helper total from Diagnosis, Incurred is the sum of the CURRENT Diagnosis Incurred rows only, and Amount due is Total cost minus Incurred. Never use deleted Diagnosis Incurred values or legacy Payment Request history to calculate Final Payment. Do not change numeric values supplied by MDAMA.",
  "Payment Request fields and order: WO, Date, Dispatcher, Status, NTE, Amount due, Incurred, Total cost, Payment method, Trade, Tech's name, Tech's phone#, Store, Address, Team leader, Company name.",
].join("\n");

const ANALYZE_INSTRUCTIONS = `
Extract the pasted portal record completely. The response is constrained by a
JSON schema. Read label/value layouts where the value may appear on the next
line after the label. Preserve identifiers and operational codes exactly.

document_type must be work_order|quote|payment_request. state must be the
2-letter US code. scheduled_for must be ISO 8601 or null. nte and all money
values must be numbers without currency symbols. Put every additional labeled
fact that does not fit a named key into extra_fields.

For quote, quote is an object containing address, sow, tech_report,
required_to (array), incurred_items (array), repair_items (array),
parts_materials (array), equipment (array), total. Otherwise quote is null.

For payment_request, payment_request is an object containing request_date,
dispatcher, status, status_note, nte, amount_due, incurred, total_cost,
payment_method, trade, technician_name, technician_phone, store_name, address,
team_leader, company_name. Otherwise payment_request is null.

WO numbers can be simple digits or compound IDs such as 1082702-00000006.
Do not mistake a store number for a ZIP code. Keep complete street details,
suite/unit, city, state, and ZIP in their correct fields.
Copy full_address verbatim from the Work Order without shortening, normalizing,
translating, or reformatting it. Extract the split address fields separately.
Keep description as the source-reported Description/Summary text when available. summary must NOT merely copy the portal Summary. Write summary as a clear technician-facing English job brief, about 70-140 words, starting with 'Technician:'. State the reported issue and any explicit requested scope, then tell the technician to inspect/troubleshoot, identify the actual cause, and call back with diagnosis, recommended repair plan, required parts/materials/equipment, and total estimate BEFORE starting repair. Explicitly state that no repair or onsite price discussion is authorized before approval. Do not include the exact street address in summary and do not invent diagnosis, parts, cost, or scope.
problem_explanation_ar must be Arabic only, concise, and information-rich.
Use four short labeled sections: المشكلة، أهم الاحتمالات، الفحص المطلوب، تنبيه.
Keep it roughly 60-110 Arabic words. Clearly label unstated causes and solutions
as possibilities rather than facts or a confirmed diagnosis.

dispatch_brief must help the dispatcher prepare the New Hiring and onsite calls.
It contains issue_summary, recommended_trade, hiring_questions,
required_on_hand, required_evidence, and dispatch_notes. Do not write a repair
diagnosis that was not explicitly in the Work Order.`;

const ARABIC_EXPLANATION_INSTRUCTIONS = `
اكتب شرحاً عربياً مختصراً وثرياً للمشكلة المذكورة في طلب العمل، بين ستين ومئة
وعشر كلمات تقريباً. استخدم أربعة عناوين قصيرة فقط: المشكلة، أهم الاحتمالات،
الفحص المطلوب، تنبيه. افصل بين المعلومة المؤكدة والاحتمال الفني، ولا تخترع سبباً
أو قطعة أو سعراً أو مدة. وضح باختصار أن التشخيص النهائي يعتمد على المعاينة
والقياسات وأن الإصلاح لا يبدأ قبل الموافقة. استخدم العربية فقط.`;

const nullableString = { type: ["string", "null"] };
const nullableNumber = { type: ["number", "null"] };
const stringArray = { type: "array", items: { type: "string" } };
const quoteSchema = {
  type: ["object", "null"],
  properties: {
    address: nullableString, sow: nullableString, tech_report: nullableString,
    required_to: stringArray, incurred_items: stringArray, repair_items: stringArray,
    parts_materials: stringArray, equipment: stringArray, total: nullableNumber,
  },
  required: ["address","sow","tech_report","required_to","incurred_items","repair_items","parts_materials","equipment","total"],
  additionalProperties: false,
};
const paymentSchema = {
  type: ["object", "null"],
  properties: {
    request_date: nullableString, dispatcher: nullableString, status: nullableString,
    status_note: nullableString, nte: nullableNumber, amount_due: nullableNumber,
    incurred: nullableNumber, total_cost: nullableNumber, payment_method: nullableString,
    trade: nullableString, technician_name: nullableString, technician_phone: nullableString,
    store_name: nullableString, address: nullableString, team_leader: nullableString,
    company_name: nullableString,
  },
  required: ["request_date","dispatcher","status","status_note","nte","amount_due","incurred","total_cost","payment_method","trade","technician_name","technician_phone","store_name","address","team_leader","company_name"],
  additionalProperties: false,
};
const dispatchBriefSchema = {
  type: "object",
  properties: {
    issue_summary: { type: "string" },
    recommended_trade: { type: "string" },
    hiring_questions: stringArray,
    required_on_hand: stringArray,
    required_evidence: stringArray,
    dispatch_notes: stringArray,
  },
  required: ["issue_summary","recommended_trade","hiring_questions","required_on_hand","required_evidence","dispatch_notes"],
  additionalProperties: false,
};
const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    document_type: { type: "string", enum: ["work_order","quote","payment_request"] },
    confidence: nullableNumber,
    wo_number: nullableString, external_id: nullableString, job_type: nullableString,
    commitment_at: nullableString, record_type: nullableString, alert_status: nullableString,
    special_handling: nullableString, region: nullableString, timezone: nullableString,
    client_name: nullableString, store_name: nullableString, store_number: nullableString,
    wrid: nullableString, location_contact: nullableString, contact_number: nullableString,
    turf: nullableString, requester: nullableString, noc_phone: nullableString,
    trade: nullableString, description: nullableString,
    priority: { type: "string", enum: ["normal","emergency"] },
    eta_code: nullableString, scheduled_for: nullableString, sow: nullableString,
    summary: nullableString, problem_explanation_ar: nullableString,
    full_address: nullableString, street: nullableString,
    city: nullableString, state: nullableString, zip_code: nullableString,
    best_contact: nullableString, best_contact_phone: nullableString,
    nte: nullableNumber, currency: nullableString, special_instructions: nullableString,
    quote: quoteSchema, payment_request: paymentSchema, dispatch_brief: dispatchBriefSchema,
    extra_fields: {
      type: "array",
      items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label","value"], additionalProperties: false },
    },
  },
  required: ["document_type","confidence","wo_number","external_id","job_type","commitment_at","record_type","alert_status","special_handling","region","timezone","client_name","store_name","store_number","wrid","location_contact","contact_number","turf","requester","noc_phone","trade","description","priority","eta_code","scheduled_for","sow","summary","problem_explanation_ar","full_address","street","city","state","zip_code","best_contact","best_contact_phone","nte","currency","special_instructions","quote","payment_request","dispatch_brief","extra_fields"],
  additionalProperties: false,
};

const QUOTE_INSTRUCTIONS = `
Create one client-facing Quote in this exact plain-text layout and order:
WO# [number]
[Store name / store number]
Address: [full address]
Description: [original WO problem/description]

After inspection, tech reported that [saved technician finding].

Required to:
-[supported step]
-[supported step]

Incurred:
[item + amount, or None]

Repairs:
[item + amount]

Parts & Materials:
[item + amount]

Total $[amount]

The first four fields come from the Work Order. Everything after inspection comes from the saved technician Diagnosis and explicit pricing data. Preserve this template even when revising an existing Quote. Use only supported repair steps and do not invent work. Include helper only when explicitly stated. Apply the 1.47 parts markup only when a source part price is supplied. IMPORTANT: technician_total_cost means the technician’s final agreed total price. Do not label it as labor-only and do not add parts/equipment on top of it unless the saved Diagnosis explicitly says those costs are excluded from that total. When inclusion is unclear, keep the client-facing amount editable rather than double-counting. Include explicit equipment/snaking/power-washing fees in the appropriate client-facing section only when they are confirmed separate charges. Finish Required to with the job-appropriate final test or final inspection and Clean work area. Do not invent any fact, cost, rate, tax, quantity, or specification; if a client-facing amount cannot be derived from supplied data, keep the section editable rather than making up a number. Output plain text only.`;

const PAYMENT_INSTRUCTIONS = `
Create one Payment Request in exactly this field order and plain-text style:
WO#[number]
Date:
Dispatcher:
Status:
NTE: $
Amount due: $
Incurred: $
Total cost: $
Payment method:
Trade:
Tech's name:
Tech's phone:
Store:
Address:
Team leader:
Company name:
Use the selected internal status supplied by the application. Do not change ANY supplied numeric value. The client initial NTE is irrelevant here; NTE is the final/generated Quote total when available. For Final Payment, MDAMA has already calculated the authoritative values: Total cost = agreed Tech + Helper cost from Diagnosis; Incurred = CURRENT Diagnosis Incurred rows only; Amount due = Total cost - Incurred. Preserve the supplied Dispatcher, Team leader, technician identity, status, and template exactly. Output plain text only.`;

async function loadSettings(sb: any) {
  try {
    const { data, error } = await sb.from("app_settings")
      .select("openai_model,training_revision")
      .eq("id", "default").single();
    if (error) return {};
    return data || {};
  } catch {
    return {};
  }
}

async function callOpenAI(key: string, model: string, system: string, user: string, jsonMode: boolean, customSchema?: any) {
  const requestBody: Record<string, unknown> = {
    model,
    instructions: system,
    input: user,
    store: false,
  };
  if (jsonMode) requestBody.text = {
    format: {
      type: "json_schema",
      name: customSchema ? "mdama_hiring_questions" : "mdama_document_extraction",
      strict: true,
      schema: customSchema || ANALYSIS_SCHEMA
    },
  };
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const raw = await response.text();
      try { detail = JSON.parse(raw)?.error?.message || raw; }
      catch { detail = raw; }
    } catch { /* status is enough */ }
    throw new Error(`OpenAI ${response.status}${detail ? `: ${String(detail).replace(/\s+/g, " ").slice(0, 240)}` : ""}`);
  }
  const payload = await response.json();
  const content = payload?.output_text || payload?.output?.flatMap((item: any) => item?.content || [])
    ?.find((part: any) => part?.type === "output_text")?.text;
  if (typeof content !== "string" || !content.trim()) throw new Error("OpenAI returned an empty response");
  return content;
}

const PART_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    name: { type: ["string", "null"] },
    brand: { type: ["string", "null"] },
    model_number: { type: ["string", "null"] },
    specifications: { type: ["string", "null"] },
    technical_details: { type: "array", items: { type: "object", properties: { name: { type: "string" }, value: { type: ["string", "null"] } }, required: ["name", "value"], additionalProperties: false } },
    quantity: { type: "number" },
    unit_price: { type: ["number", "null"] },
    currency: { type: "string", enum: ["USD"] },
    seller: { type: ["string", "null"] },
    source_title: { type: ["string", "null"] },
    source_url: { type: ["string", "null"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    note: { type: "string" },
  },
  required: ["name","brand","model_number","specifications","technical_details","quantity","unit_price","currency","seller","source_title","source_url","confidence","note"],
  additionalProperties: false,
};

async function analyzePartWithWeb(key: string, model: string, partTrade: string, partType: string, expectedSpecs: string[], description: string, imageDataUrl: string | null, city: string, state: string) {
  const content: any[] = [{
    type: "input_text",
    text: `Identify this commercial repair part only within the dispatcher-selected trade and part type, using the supplied description and optional image, then search current US retail or supplier listings for the exact matching part and local market price available to ${city}, ${state}.\n\nSelected Part Trade (authoritative):\n${partTrade}\n\nSelected Part Type (authoritative):\n${partType}\n\nRequired technical fields:\n${expectedSpecs.join(", ")}\n\nMarket location (use only this city and state):\n${city}, ${state}, USA\n\nDescription:\n${description || "No written description supplied."}\n\nRules:\n- Do not change or ignore the selected Part Trade or Part Type.\n- Read the image label, model number, and specifications carefully.\n- Return technical_details with exactly one item for every Required technical field, using the same field name and null when it cannot be verified.\n- For a Compressor, carefully extract Model, Type, Capacity in BTU and tons when supported, Refrigerant, Voltage, Phase, and Run Capacitor.\n- Match model number, dimensions, voltage, capacity, connection size, or other critical specs before accepting a listing.\n- Search the live web for sellers serving or pricing the part in ${city}, ${state}; use a direct seller/manufacturer product page, not a search-results page.\n- unit_price is the current listed market price for one unit in USD, excluding sales tax and shipping.\n- Never estimate, average, or invent a price or specification. If an exact-enough listing serving this city/state is not verified, set unit_price and source fields to null and explain why.\n- If the image/description conflicts with ${partTrade} / ${partType}, lower confidence, leave price null, and explain the conflict.`,
  }];
  if (imageDataUrl) content.push({ type: "input_image", image_url: imageDataUrl, detail: "high" });
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      instructions: "You are a meticulous commercial repair-parts identification and price-verification specialist. Use image evidence and written specs together. A price is valid only with a current matching direct product listing.",
      input: [{ role: "user", content }],
      tools: [{ type: "web_search", external_web_access: true, user_location: { type: "approximate", country: "US", city, region: state } }],
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
      text: { format: { type: "json_schema", name: "mdama_part_analysis", strict: true, schema: PART_ANALYSIS_SCHEMA } },
      store: false,
    }),
  });
  if (!response.ok) { const raw = await response.text(); let detail = raw; try { detail = JSON.parse(raw)?.error?.message || raw; } catch {} throw new Error(`OpenAI ${response.status}: ${String(detail).slice(0,300)}`); }
  const payload = await response.json();
  const outputText = payload?.output_text || payload?.output?.flatMap((item: any) => item?.content || [])?.find((part: any) => part?.type === "output_text")?.text;
  const result = parseJsonObject(outputText || "");
  const webSources = (payload?.output || []).flatMap((item: any) => [
    ...(Array.isArray(item?.action?.sources) ? item.action.sources : []),
    ...(item?.content || []).flatMap((part: any) => (part?.annotations || []).filter((a: any) => a?.type === "url_citation")),
  ]).filter((x: any) => x?.url);
  const normalizeUrl = (value: string) => { try { const u = new URL(value); return (u.origin + u.pathname).replace(/\/$/, "").toLowerCase(); } catch { return ""; } };
  const verifiedSource = webSources.find((x: any) => normalizeUrl(x.url) === normalizeUrl(result.source_url));
  if (result.unit_price !== null && !verifiedSource) {
    result.unit_price = null; result.source_url = null; result.source_title = null; result.seller = null; result.confidence = "low";
    result.note = `${result.note ? result.note + " " : ""}The proposed price source could not be verified against the live web-search sources.`;
  } else if (verifiedSource) {
    result.source_url = verifiedSource.url; result.source_title = verifiedSource.title || result.source_title;
  }
  result.checked_at = new Date().toISOString();
  return result;
}

function parseJsonObject(raw: string) {
  const clean = String(raw || "").trim()
    .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const first = clean.indexOf("{");
  const last = clean.lastIndexOf("}");
  for (const candidate of [clean, first >= 0 && last > first ? clean.slice(first, last + 1) : ""]) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* try next */ }
  }
  throw new Error("The model response was not a valid JSON object");
}

function firstMatch(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

const WO_LABELS = [
  "Job","Commitment Date & Time","Commitment Date and Time","Commitment","Job Type",
  "ExternalID","External ID","Ext. ID","Record Type","Alert Status","Special Handling",
  "Region","TZ","Time Zone","Timezone","Customer Name","Client Name","Customer","WRID",
  "Location Contact","Best Contact","Contact Number","Contact Phone","Best Contact Phone","Turf",
  "Service Address","Full Address","Address","Reject","Summary","Scope of Work","SOW","Store",
  "Store Name","Location Name","Store #","Store Number","Store No.","NTE","Status","Amount due",
  "Incurred","Total cost","Payment method","WO","WO #","WO Number","Work Order",
];
const normalizeLabel = (value: string) => String(value || "").replace(/[:#]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
function labelValue(text: string, names: string[]) {
  const targets = new Set(names.map(normalizeLabel));
  const known = new Set(WO_LABELS.map(normalizeLabel));
  const lines = String(text || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].trim();
    const colon = raw.indexOf(":");
    const head = colon >= 0 ? raw.slice(0, colon) : raw;
    if (!targets.has(normalizeLabel(head))) continue;
    const sameLine = colon >= 0 ? raw.slice(colon + 1).trim() : "";
    if (sameLine) return sameLine.replace(/^['"]|['"]$/g, "");
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex++) {
      const next = lines[nextIndex].trim();
      if (!next) continue;
      const nextColon = next.indexOf(":");
      const nextHead = nextColon >= 0 ? next.slice(0, nextColon) : next;
      if (known.has(normalizeLabel(nextHead))) break;
      return next.replace(/^['"]|['"]$/g, "");
    }
  }
  return null;
}

function multilineValue(text: string, names: string[]) {
  const targets = new Set(names.map(normalizeLabel));
  const known = new Set(WO_LABELS.map(normalizeLabel));
  const lines = String(text || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].trim();
    const colon = raw.indexOf(":");
    const head = colon >= 0 ? raw.slice(0, colon) : raw;
    if (!targets.has(normalizeLabel(head))) continue;
    const output: string[] = [];
    const sameLine = colon >= 0 ? raw.slice(colon + 1).trim() : "";
    if (sameLine) output.push(sameLine);
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex++) {
      const next = lines[nextIndex].trim();
      if (!next) continue;
      const nextColon = next.indexOf(":");
      const nextHead = nextColon >= 0 ? next.slice(0, nextColon) : next;
      if (known.has(normalizeLabel(nextHead))) break;
      output.push(next);
    }
    if (output.length) return output.join("\n").replace(/^['"]|['"]$/g, "");
  }
  return null;
}

function splitUSAddress(value: string | null) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  const match = clean.match(/^(.+?)\s*,\s*([^,]+?)\s*,?\s+([A-Z]{2})\s*,?\s*(\d{5}(?:-\d{4})?)$/i);
  if (match) return { street: match[1].trim(), city: match[2].trim(), state: match[3].toUpperCase(), zip_code: match[4] };
  const stateZip = clean.match(/\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\s*,?\s*(\d{5}(?:-\d{4})?)\b/i);
  return { street: clean || null, city: null, state: stateZip?.[1]?.toUpperCase() || null, zip_code: stateZip?.[2] || null };
}

function money(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function localHiringQuestions(sow: string, trade: string, summary: string) {
  const problem = (summary || sow || "the reported issue").trim();
  const tradeLabel = trade || "the requested trade";
  const shortProblem = problem.length > 180 ? problem.slice(0, 180) + "…" : problem;
  return {
    problem_summary: `We have a ${tradeLabel} issue at a commercial site: ${shortProblem}. We need a solo technician to visit, diagnose, and let us know what it takes to fix it.`,
    questions: [
      {
        step: 1, title: "Confirm name", type: "text", options: [],
        question: `What name do you go by? I want to make sure I have the right person for this ${tradeLabel} call.`,
      },
      {
        step: 2, title: "Explain the problem", type: "textarea", options: [],
        question: `Here is the situation I need help with: ${shortProblem}`,
      },
      {
        step: 3, title: "Specialty match", type: "select",
        options: ["-- select --","Yes — matches specialty","No — outside specialty","Partially"],
        question: `Is this kind of ${tradeLabel} work within your specialty and daily scope?`,
      },
      {
        step: 4, title: "ETA", type: "text", options: [],
        question: "How soon can you be on site? We need someone there as fast as possible — same-day or first thing tomorrow.",
      },
      {
        step: 5, title: "Free estimate", type: "select",
        options: ["-- select --","Yes — free estimate","No — charges a fee"],
        question: "Do you offer a free estimate for the diagnostic visit?",
      },
      {
        step: 5, title: "Estimate fee (if not free)", type: "text", options: [],
        question: "If not free, what is your estimate fee? ($)",
      },
      {
        step: 6, title: "Payment method", type: "select",
        options: ["-- select --","Check by mail","ACH / Bank transfer","Credit card","Zelle","Cash on completion","Net 30","Other (see notes)"],
        question: "What payment method works best for you once the job is approved?",
      },
      {
        step: 6, title: "Payment notes", type: "text", options: [],
        question: "Any specific payment details or terms (e.g. Net 30, mailing address for a check)?",
      },
      {
        step: 7, title: "Process explained", type: "select",
        options: ["-- select --","Yes, explained and sending message","Not yet"],
        question: "I've explained our process — diagnose first, wait for approval, then repair. I'll send you the full WO details by message. Are we good?",
      },
      {
        step: 8, title: "Address + arrival call", type: "select",
        options: ["-- select --","Yes, sent address and requested arrival call","Not yet"],
        question: "Great — the site address is in the WO I'm sending. Please call me when you arrive. Confirmed?",
      },
    ],
  };
}

function localArabicExplanation(text: string, sow: unknown, summary: unknown, trade: unknown) {
  const source = String([summary, sow, text].filter(Boolean).join(" ")).toLowerCase();
  const full = (issue: string) => `المشكلة:\n${issue}\n\nأهم الاحتمالات:\nقد يرتبط الخلل بالمكوّن نفسه أو بتوصيلاته أو بظروف التشغيل، وتبقى هذه احتمالات حتى اكتمال الفحص.\n\nالفحص المطلوب:\nتأمين الموقع، توثيق الحالة، فحص مصدر الخلل، وإجراء القياسات المناسبة قبل تقديم التشخيص وخطة الإصلاح.\n\nتنبيه:\nلا يبدأ الإصلاح قبل موافقة المسؤول، ويعتمد القرار النهائي على المعاينة والصور والقياسات.`;
  const rules: [RegExp, string][] = [
    [/leak|drip|water\s+coming|water\s+fountain/, "يوضح الطلب وجود تسرّب مياه في الموقع، ويطلب فحص المشكلة وتحديد الخدمة اللازمة."],
    [/clog|blocked|back(?:ed|ing)?\s+up|overflow/, "يوضح الطلب وجود انسداد أو رجوع للمياه في الموقع، ويطلب فحص المشكلة وتحديد الخدمة اللازمة."],
    [/light|lamp|ballast|fixture/, "يوضح الطلب وجود عطل في الإنارة بالموقع، ويطلب فحصها وتحديد الخدمة اللازمة."],
    [/outlet|socket|receptacle|breaker|no\s+power/, "يوضح الطلب وجود عطل كهربائي في الموقع، ويطلب فحصه وتحديد الخدمة اللازمة."],
    [/air\s*condition|hvac|cooling|heating|thermostat|rooftop\s+unit/, "يوضح الطلب وجود مشكلة في نظام التكييف أو التدفئة بالموقع، ويطلب فحصها وتحديد الخدمة اللازمة."],
    [/lock|rekey|key\s+broken/, "يوضح الطلب وجود مشكلة في القفل أو المفتاح بالموقع، ويطلب فحصها وتحديد الخدمة اللازمة."],
    [/glass|window|mirror/, "يوضح الطلب وجود مشكلة في الزجاج بالموقع، ويطلب فحصها وتحديد الخدمة اللازمة."],
    [/ceiling|drywall|tile|door|floor|cabinet/, "يوضح الطلب وجود تلف في أحد عناصر الموقع، ويطلب فحصه وتحديد أعمال الصيانة اللازمة."],
    [/refrigerator|freezer|dishwasher|washer|dryer|oven|appliance/, "يوضح الطلب وجود عطل في أحد أجهزة الموقع، ويطلب فحصه وتحديد الخدمة اللازمة."],
  ];
  for (const [pattern, message] of rules) if (pattern.test(source)) return full(message);
  const byTrade: Record<string, string> = {
    Plumber: "يتعلق الطلب بمشكلة في أعمال السباكة بالموقع، ويطلب فحصها وتحديد الخدمة اللازمة.",
    Electrical: "يتعلق الطلب بمشكلة كهربائية في الموقع، ويطلب فحصها وتحديد الخدمة اللازمة.",
    HVAC: "يتعلق الطلب بمشكلة في نظام التكييف أو التدفئة، ويطلب فحصها وتحديد الخدمة اللازمة.",
    Handyman: "يتعلق الطلب بأعمال صيانة عامة في الموقع، ويطلب فحص المشكلة وتحديد الخدمة اللازمة.",
    Locksmith: "يتعلق الطلب بمشكلة في أحد الأقفال بالموقع، ويطلب فحصها وتحديد الخدمة اللازمة.",
  };
  return full(byTrade[String(trade || "")] || "يوضح الطلب وجود مشكلة صيانة في الموقع، ويطلب فحصها وتحديد الخدمة المطلوبة وفق نطاق العمل المذكور.");
}

function validArabicExplanation(value: unknown) {
  const text = String(value || "").trim();
  return text.length >= 120 && text.length <= 800 && /[\u0600-\u06ff]/.test(text) && !/[A-Za-z]/.test(text) && text.includes("المشكلة") && text.includes("الفحص") && !text.startsWith("تعذّر");
}

async function createArabicExplanation(key: string, model: string, raw: string, sow?: unknown, summary?: unknown) {
  const source = [summary ? `الملخص:\n${String(summary)}` : "", sow ? `نطاق العمل:\n${String(sow)}` : "", `نص طلب العمل:\n${raw}`]
    .filter(Boolean).join("\n\n");
  const explanation = (await callOpenAI(key, model, ARABIC_EXPLANATION_INSTRUCTIONS, source, false))
    .replace(/^```[^\n]*\n?|```$/g, "").trim();
  if (!validArabicExplanation(explanation)) throw new Error("The Arabic explanation was empty or not Arabic-only");
  return explanation;
}

function classifyLocally(text: string) {
  if (/\bPAYMENT\s+REQUEST\b/i.test(text) ||
      (/\bAmount\s+due\s*:/i.test(text) && /\bTotal\s+cost\s*:/i.test(text))) return "payment_request";
  if (/^\s*QUOTE\b/im.test(text) ||
      (/\bRequired\s+to\s*:/i.test(text) && /\bTech(?:nician)?\s+report\s*:/i.test(text))) return "quote";
  return "work_order";
}

function normalizeDocumentType(value: unknown, raw: string) {
  const local = classifyLocally(raw);
  if (local !== "work_order") return local;
  const type = String(value || "").toLowerCase().replace(/[\s-]+/g, "_");
  return ["work_order", "quote", "payment_request"].includes(type) ? type : "work_order";
}

function normalizePaymentStatus(value: unknown) {
  const status = String(value || "").toLowerCase().replace(/[\s-]+/g, "_");
  if (/job_done|work_done|completed/.test(status)) return "work_done";
  if (/assessment/.test(status)) return "assessment_completed";
  if (/deposit|advance/.test(status)) return "deposit";
  return null;
}

function compactTechPiece(value: unknown, max = 420) {
  let text = String(value || "").replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
  text = text
    .replace(/^(reported issue|job details|scope of work|sow|description|summary|special instructions?)\s*[:\-]\s*/i, "")
    .replace(/^please\s+dispatch\s+(?:a\s+)?technician\s+to\s+/i, "")
    .replace(/\bHave you already tried\b.*$/i, "")
    .replace(/\bBest Contact(?: Phone)?\s*[:\-].*$/i, "")
    .replace(/\bTechnicians?,\s*please\s+contact\b.*$/i, "")
    .trim();
  if (text.length <= max) return text;
  const clipped = text.slice(0, max + 1);
  const cuts = [clipped.lastIndexOf(". "), clipped.lastIndexOf("; "), clipped.lastIndexOf(", "), clipped.lastIndexOf(" ")];
  const cut = cuts.find((x) => x >= Math.floor(max * 0.62));
  return (cut && cut > 0 ? clipped.slice(0, cut + 1) : text.slice(0, max)).trim().replace(/[,:;\-]+$/, "") + "…";
}
function technicianFacingSummary(data: {trade?: unknown; description?: unknown; sow?: unknown; special?: unknown}) {
  const trade = String(data.trade || "service").trim() || "service";
  const issue = compactTechPiece(data.description || data.sow, 430) || "The site reported a service issue that requires inspection and troubleshooting.";
  const scope = compactTechPiece(data.sow, 360);
  const special = compactTechPiece(data.special, 260);
  const parts = [
    `Technician: this is a commercial ${trade} service call.`,
    `Reported issue: ${issue}`,
    scope && scope.toLowerCase() !== issue.toLowerCase() ? `Requested scope: ${scope}` : "",
    "Please inspect and troubleshoot the reported condition, identify the actual cause, and call us with your diagnosis, recommended repair plan, any parts/materials or equipment needed, and your total estimate before starting any repair.",
    special ? `Special instructions: ${special}` : "",
    "Do not perform repair work or discuss pricing with the site until approval is provided.",
  ].filter(Boolean);
  return parts.join("\n\n").slice(0, 1800);
}

function localAnalyze(text: string) {
  const lower = text.toLowerCase();
  const tradeRules: [string, RegExp][] = [
    ["Plumber", /plumb|toilet|urinal|faucet|sink|drain|pipe|water\s+heater|hydrojet|snake|leak/],
    ["Electrical", /electric|outlet|socket|breaker|wiring|light|ballast|power|panel|generator|fuse/],
    ["HVAC", /hvac|air\s*condition|heating|cooling|furnace|thermostat|rooftop\s+unit/],
    ["Locksmith", /lock|key|rekey|safe/],
    ["Glass Repair", /glass|window|mirror/],
    ["Power Washing", /power\s*wash|pressure\s*wash/],
    ["Landscaping", /landscap|lawn|yard|tree/],
    ["Snow Removal", /snow|plow|salting|deicing/],
    ["Junk Removal", /junk|hauling|debris/],
    ["Appliance Repair", /appliance|washer|dryer|dishwasher|oven|refrigerator|freezer|ice\s*machine/],
    ["Handyman", /handyman|drywall|ceiling|tile|painting|flooring|cabinet|door|board[ -]?up|concrete/],
  ];
  let trade = null;
  for (const [name, pattern] of tradeRules) if (pattern.test(lower)) { trade = name; break; }

  const fullAddress = labelValue(text, ["Service Address", "Full Address", "Address"]);
  const address = splitUSAddress(fullAddress);
  const etaCode = ETA_CODES.find((code) => new RegExp(`\\b${code}\\b`, "i").test(text)) || null;
  const documentType = classifyLocally(text);
  const payment = documentType === "payment_request" ? {
    request_date: firstMatch(text, [/\bDate\s*:\s*([^\n]+)/i]),
    dispatcher: firstMatch(text, [/\bDispatcher\s*:\s*([^\n]+)/i]),
    status: normalizePaymentStatus(firstMatch(text, [/\bStatus\s*:\s*([^\n]+)/i])),
    status_note: firstMatch(text, [/\bStatus\s*:\s*([^\n]+)/i]),
    nte: money(firstMatch(text, [/\bNTE\s*:\s*\$?([\d,.]+)/i])),
    amount_due: money(firstMatch(text, [/\bAmount\s+due\s*:\s*\$?([\d,.]+)/i])),
    incurred: money(firstMatch(text, [/\bIncurred\s*:\s*\$?([\d,.]+)/i])),
    total_cost: money(firstMatch(text, [/\bTotal\s+cost\s*:\s*\$?([\d,.]+)/i])),
    payment_method: firstMatch(text, [/\bPayment\s+method\s*:\s*([^\n]+)/i]),
    trade: firstMatch(text, [/\bTrade\s*:\s*([^\n]+)/i]),
    technician_name: firstMatch(text, [/\bTech(?:nician)?(?:'s)?\s+name\s*:\s*([^\n]+)/i]),
    technician_phone: firstMatch(text, [/\bTech(?:nician)?(?:'s)?\s+phone#?\s*:\s*([^\n]+)/i]),
    store_name: firstMatch(text, [/\bStore\s*:\s*([^\n]+)/i]),
    address: fullAddress,
    team_leader: firstMatch(text, [/\bTeam\s+leader\s*:\s*([^\n]+)/i]),
    company_name: firstMatch(text, [/\bCompany\s+name\s*:\s*([^\n]+)/i]),
  } : null;

  const sow = multilineValue(text, ["Scope of Work", "SOW"]);
  const requiredOnHand: string[] = [];
  const requiredEvidence = ["Arrival call", "Full diagnosis and repair plan", "Signed manager sheet and direct manager confirmation after completion"];
  if (trade === "HVAC" || trade === "Appliance Repair") {
    requiredOnHand.push("Ladder");
  }
  if (trade === "Electrical" && /light|ballast/i.test(text)) {
    requiredOnHand.push("Ladder");
  }
  if (trade === "Plumber" && /overflow|backing up|clog/i.test(text)) {
    requiredOnHand.push("100 ft+ snake or hydrojet as appropriate");
  }
  const sourceDescription = multilineValue(text, ["Description", "Summary"]) || labelValue(text, ["Description", "Summary"]) || sow || "";
  const techSummary = technicianFacingSummary({ trade, description: sourceDescription, sow, special: labelValue(text, ["Special Instructions", "Special Handling"]) });
  const dispatchBrief = {
    issue_summary: techSummary,
    recommended_trade: trade || "",
    hiring_questions: [
      "Can you handle this commercial repair?", "Do you provide a free estimate?",
      "What is your distance and ETA?", "What is your assessment fee and payment method?",
    ],
    required_on_hand: requiredOnHand,
    required_evidence: requiredEvidence,
    dispatch_notes: [
      "Do not disclose the complete address until all Hiring requirements are accepted.",
      "No repair and no onsite price discussion before approval.",
    ],
  };

  return {
    document_type: documentType,
    confidence: 0.55,
    wo_number: firstMatch(text, [
      /(?:^|\n)\s*WO\b(?:\s*(?:number|#))?\s*[:#-]?\s*([A-Z0-9]+(?:-[A-Z0-9]+)*)/i,
      /\b(\d{7}-\d{8})\b/,
    ]) || labelValue(text, ["ExternalID", "External ID"]),
    external_id: labelValue(text, ["ExternalID", "External ID"]),
    job_type: labelValue(text, ["Job Type"]),
    commitment_at: labelValue(text, ["Commitment Date & Time", "Commitment Date and Time", "Commitment"]),
    record_type: labelValue(text, ["Record Type"]),
    alert_status: labelValue(text, ["Alert Status"]),
    special_handling: labelValue(text, ["Special Handling"]),
    region: labelValue(text, ["Region"]),
    timezone: labelValue(text, ["TZ", "Time Zone", "Timezone"]),
    client_name: labelValue(text, ["Customer Name", "Client Name", "Customer"]),
    store_name: labelValue(text, ["Store", "Store Name", "Location Name"]),
    store_number: labelValue(text, ["Store #", "Store Number", "Store No."]),
    wrid: labelValue(text, ["WRID"]),
    location_contact: labelValue(text, ["Location Contact", "Best Contact"]),
    contact_number: labelValue(text, ["Contact Number", "Contact Phone", "Best Contact Phone"]),
    turf: labelValue(text, ["Turf"]),
    requester: firstMatch(text, [/\bRequest(?:or|er)\s*:\s*([^\n]+)/i]),
    noc_phone: firstMatch(text, [/\b(?:NOC|call)\b[^\n]*?((?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}(?:\s*(?:ext\.?|x)\s*\d+)?)/i]),
    trade,
    description: sourceDescription,
    priority: /\b(?:EMG|P4)\b/i.test(text) ? "emergency" : "normal",
    eta_code: etaCode,
    scheduled_for: null,
    sow,
    summary: techSummary,
    problem_explanation_ar: localArabicExplanation(text, sow, labelValue(text, ["Summary", "Description"]) || sow, trade),
    full_address: fullAddress,
    street: address.street,
    city: address.city,
    state: address.state,
    zip_code: address.zip_code,
    best_contact: labelValue(text, ["Best Contact", "Location Contact"]),
    best_contact_phone: labelValue(text, ["Best Contact Phone", "Contact Number", "Contact Phone"]),
    nte: money(firstMatch(text, [/\bNTE\s*:\s*\$?([\d,.]+)/i])),
    currency: "USD",
    special_instructions: firstMatch(text, [/\bSpecial\s+(?:Instructions|Handling)\s*:\s*([^\n]+)/i]),
    quote: null,
    payment_request: payment,
    dispatch_brief: dispatchBrief,
    extra_fields: [],
    extracted_fields: {},
  };
}

function normalizeAnalysis(input: any, raw: string) {
  const local = localAnalyze(raw);
  const data = input && typeof input === "object" ? input : local;
  const documentType = normalizeDocumentType(data.document_type, raw);
  const payment = data.payment_request && typeof data.payment_request === "object"
    ? { ...data.payment_request, status: normalizePaymentStatus(data.payment_request.status) }
    : local.payment_request;
  const etaFromText = ETA_CODES.find((code) => new RegExp(`\\b${code}\\b`, "i").test(raw));
  const extras = Array.isArray(data.extra_fields)
    ? Object.fromEntries(data.extra_fields.filter((item: any) => item?.label).map((item: any) => [String(item.label), String(item.value ?? "")]))
    : {};
  const modelBrief = data.dispatch_brief && typeof data.dispatch_brief === "object"
    ? data.dispatch_brief
    : local.dispatch_brief;
  const normalizedTechSummary = technicianFacingSummary({
    trade: local.trade || data.trade,
    description: data.description ?? local.description,
    sow: data.sow ?? local.sow,
    special: data.special_instructions ?? local.special_instructions,
  });
  const dispatchBrief = {
    issue_summary: normalizedTechSummary,
    recommended_trade: local.trade || "",
    hiring_questions: Array.isArray(modelBrief.hiring_questions)
      ? modelBrief.hiring_questions.map(String)
      : local.dispatch_brief.hiring_questions,
    required_on_hand: local.dispatch_brief.required_on_hand,
    required_evidence: local.dispatch_brief.required_evidence,
    dispatch_notes: Array.isArray(modelBrief.dispatch_notes)
      ? modelBrief.dispatch_notes.map(String)
      : local.dispatch_brief.dispatch_notes,
  };
  return {
    document_type: documentType,
    confidence: Number(data.confidence) || null,
    wo_number: data.wo_number ?? local.wo_number,
    external_id: data.external_id ?? local.external_id,
    job_type: data.job_type ?? local.job_type,
    commitment_at: data.commitment_at ?? local.commitment_at,
    record_type: data.record_type ?? local.record_type,
    alert_status: data.alert_status ?? local.alert_status,
    special_handling: data.special_handling ?? local.special_handling,
    region: data.region ?? local.region,
    timezone: data.timezone ?? local.timezone,
    client_name: data.client_name ?? local.client_name,
    store_name: data.store_name ?? local.store_name,
    store_number: data.store_number ?? local.store_number,
    wrid: data.wrid ?? local.wrid,
    location_contact: data.location_contact ?? local.location_contact,
    contact_number: data.contact_number ?? local.contact_number,
    turf: data.turf ?? local.turf,
    requester: data.requester ?? local.requester,
    noc_phone: data.noc_phone ?? local.noc_phone,
    trade: local.trade,
    description: data.description ?? local.description,
    priority: /\b(?:EMG|P4)\b/i.test(raw) ? "emergency" : "normal",
    eta_code: etaFromText || (ETA_CODES.includes(data.eta_code) ? data.eta_code : null),
    scheduled_for: data.scheduled_for ?? null,
    sow: data.sow ?? local.sow,
    summary: technicianFacingSummary({
      trade: local.trade || data.trade,
      description: data.description ?? local.description,
      sow: data.sow ?? local.sow,
      special: data.special_instructions ?? local.special_instructions,
    }),
    problem_explanation_ar: validArabicExplanation(data.problem_explanation_ar) ? String(data.problem_explanation_ar).trim() : local.problem_explanation_ar,
    full_address: local.full_address || data.full_address,
    street: data.street ?? local.street,
    city: data.city ?? local.city,
    state: data.state ? String(data.state).toUpperCase() : local.state,
    zip_code: data.zip_code ?? local.zip_code,
    best_contact: data.best_contact ?? local.best_contact,
    best_contact_phone: data.best_contact_phone ?? local.best_contact_phone,
    nte: money(data.nte) ?? local.nte,
    currency: data.currency || "USD",
    special_instructions: data.special_instructions ?? local.special_instructions,
    quote: documentType === "quote" ? (data.quote || {}) : null,
    payment_request: documentType === "payment_request" ? (payment || {}) : null,
    dispatch_brief: dispatchBrief,
    extra_fields: Array.isArray(data.extra_fields) ? data.extra_fields : [],
    extracted_fields: { ...extras, ...(data.extracted_fields && typeof data.extracted_fields === "object" ? data.extracted_fields : {}) },
  };
}

async function geocode(analysis: Record<string, unknown>) {
  const key = Deno.env.get("GOOGLE_MAPS_API_KEY");
  if (!key) return { latitude: null, longitude: null };
  const address = [analysis.street, analysis.city, analysis.state, analysis.zip_code].filter(Boolean).join(", ");
  if (!address) return { latitude: null, longitude: null };
  try {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", address);
    url.searchParams.set("key", key);
    const payload = await (await fetch(url.toString())).json();
    const location = payload?.results?.[0]?.geometry?.location;
    if (location) return { latitude: location.lat, longitude: location.lng };
  } catch { /* geocoding is optional */ }
  return { latitude: null, longitude: null };
}

function serverKey() {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const secrets = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secrets) {
    try {
      const first = Object.values(JSON.parse(secrets))[0];
      if (typeof first === "string") return first;
    } catch { /* fall through */ }
  }
  return Deno.env.get("SUPABASE_ANON_KEY") || "";
}


function localYelpSubtrade(tradeRaw: string, descriptionRaw: string) {
  const trade = String(tradeRaw || "").trim();
  const text = String(descriptionRaw || "").toLowerCase();
  const key = trade.toLowerCase();
  const result = (subtrade: string, yelpTerm: string) => ({ subtrade, yelp_term: yelpTerm });

  if (/plumb/.test(key)) {
    if (/sewage|sewer|main\s*line|back(?:ed|ing)?\s*up|overflow|clog|snake|hydrojet|drain/.test(text)) return result("Drain Cleaning / Sewer", "drain cleaning sewer plumber");
    if (/toilet|urinal/.test(text)) return result("Toilet / Urinal Repair", "toilet repair plumber");
    if (/water\s*heater|hot\s*water/.test(text)) return result("Water Heater", "water heater plumber");
    if (/leak|drip|pipe|burst/.test(text)) return result("Leak / Pipe Repair", "leak pipe repair plumber");
    if (/faucet|sink/.test(text)) return result("Faucet / Sink Repair", "faucet sink plumber");
    return result("General Plumbing", "plumber");
  }
  if (/hvac/.test(key)) {
    if (/not\s+cool|cooling|hot|warm|ac\b|air\s*condition/.test(text)) return result("AC / Cooling", "air conditioning repair HVAC");
    if (/heat|heating|furnace/.test(text)) return result("Heating / Furnace", "heating furnace repair HVAC");
    if (/thermostat/.test(text)) return result("Thermostat / Controls", "thermostat HVAC repair");
    if (/rtu|rooftop|roof\s*top/.test(text)) return result("Rooftop Unit", "rooftop unit HVAC repair");
    return result("General HVAC", "HVAC repair");
  }
  if (/electr/.test(key)) {
    if (/light|lamp|ballast|fixture/.test(text)) return result("Lighting / Ballast", "lighting electrician");
    if (/outlet|socket|receptacle/.test(text)) return result("Outlet / Receptacle", "outlet repair electrician");
    if (/breaker|panel|fuse/.test(text)) return result("Breaker / Panel", "breaker panel electrician");
    if (/no\s+power|power\s+out|wiring|wire/.test(text)) return result("Power / Wiring", "electrical wiring electrician");
    return result("General Electrical", "electrician");
  }
  if (/appliance/.test(key)) {
    if (/refrigerator|fridge|freezer/.test(text)) return result("Refrigerator / Freezer", "refrigerator freezer repair");
    if (/ice\s*machine|ice\s*maker/.test(text)) return result("Ice Machine", "ice machine repair");
    if (/dishwasher/.test(text)) return result("Dishwasher", "dishwasher repair");
    if (/washer|dryer/.test(text)) return result("Washer / Dryer", "washer dryer repair");
    if (/oven|range|stove/.test(text)) return result("Oven / Range", "oven range repair");
    return result("General Appliance Repair", "appliance repair");
  }
  if (/handyman/.test(key)) {
    if (/door|hinge|closer/.test(text)) return result("Door Repair", "door repair handyman");
    if (/drywall|ceiling|ceiling\s*tile/.test(text)) return result("Drywall / Ceiling", "drywall ceiling handyman");
    if (/floor|flooring|tile/.test(text)) return result("Flooring / Tile", "flooring tile handyman");
    if (/paint/.test(text)) return result("Painting", "painting handyman");
    return result("General Handyman", "handyman");
  }
  if (/lock/.test(key)) return result(/rekey/.test(text) ? "Rekey" : "Lock Repair", /rekey/.test(text) ? "rekey locksmith" : "lock repair locksmith");
  if (/glass/.test(key)) return result("Glass / Window Repair", "glass window repair");
  if (/power\s*wash|pressure/.test(key)) return result("Pressure Washing", "pressure washing");
  if (/landscap/.test(key)) return result("Landscaping", "landscaping");
  if (/snow/.test(key)) return result("Snow Removal", "snow removal");
  if (/junk/.test(key)) return result("Junk Removal", "junk removal");
  return result(trade || "General Service", trade || "repair service");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!requestIsAuthorized(request)) return json({ error: "Invalid apikey" }, 401);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, serverKey());
  let body: any = {};
  try { body = await request.json(); } catch { /* validation below */ }
  const settings = await loadSettings(sb);
  const model = settings.openai_model || Deno.env.get("OPENAI_MODEL") || "gpt-5.4-mini";
  const key = Deno.env.get("OPENAI_API_KEY") || "";

  if (body.task === "yelp_subtrade") {
    const trade = String(body.trade || "").trim();
    const description = String(body.description || "").trim();
    if (!trade) return json({ error: "trade is required" }, 400);

    const fallback = localYelpSubtrade(trade, description);
    if (!description || !key) {
      return json({ ...fallback, source: description ? "local" : "trade", model: description ? undefined : null });
    }

    const schema = {
      type: "object",
      properties: {
        subtrade: { type: "string" },
        yelp_term: { type: "string" },
      },
      required: ["subtrade", "yelp_term"],
      additionalProperties: false,
    };
    const instructions = `
You classify one commercial maintenance Work Order for a Yelp technician search.
The Trade supplied by MDAMA is authoritative. Read only the problem description
and identify ONE practical subtrade/service type within that Trade.

Return exactly two fields:
- subtrade: a short dispatcher-friendly label, normally 2-5 words.
- yelp_term: ONE concise Yelp search phrase, normally 2-5 words, that includes
  the useful service intent and trade noun when appropriate.

Rules:
- Do not generate multiple queries, alternatives, cities, ZIP codes, company names, brands, or explanations.
- Do not change the supplied Trade.
- Do not invent a confirmed diagnosis, failed part, or repair that the WO did not state.
- Search intent should describe the service needed, not a speculative cause.
- Examples: Plumbing + sewage backup/clog => subtrade "Drain Cleaning / Sewer", yelp_term "drain cleaning sewer plumber".
  HVAC + space is hot/not cooling => "AC / Cooling", "air conditioning repair HVAC".
  Electrical + lights out => "Lighting / Ballast", "lighting electrician".
- If the description is too vague, use a general subtrade and a general Yelp term for the supplied Trade.
`.trim();
    try {
      const raw = await callOpenAI(
        key,
        model,
        instructions,
        `Trade: ${trade}\nDescription: ${description.slice(0, 1500)}`,
        true,
        schema,
      );
      const parsed = parseJsonObject(raw);
      const subtrade = String(parsed.subtrade || "").trim().slice(0, 80) || fallback.subtrade;
      const yelpTerm = String(parsed.yelp_term || "").trim().replace(/[\r\n]+/g, " ").slice(0, 100) || fallback.yelp_term;
      return json({ subtrade, yelp_term: yelpTerm, source: "openai", model });
    } catch (error) {
      return json({ ...fallback, source: "local", ai_error: (error as Error).message, model });
    }
  }

  if (body.task === "hiring_questions") {
    const sow = String(body.sow || "").trim();
    const trade = String(body.trade || "").trim();
    const summary = String(body.summary || "").trim();
    const rawWO = String(body.raw_wo_text || "").trim();
    const context = [
      sow && `SOW: ${sow}`,
      trade && `Trade: ${trade}`,
      summary && `Summary: ${summary}`,
      rawWO && `WO text (excerpt): ${rawWO.slice(0, 800)}`,
    ].filter(Boolean).join("\n");
    if (!context) return json({ error: "sow or raw_wo_text is required" }, 400);

    const instructions = `
You are a dispatch coordinator building a hiring script for a phone call to a
solo technician. Read the work order details below and produce a CUSTOM
hiring conversation with 8 questions in this EXACT order and structure:

  1. Confirm the tech's name they go by
  2. Explain the specific problem (a 1-2 sentence summary suitable to read aloud)
  3. Ask if this specific work matches their trade/specialty
  4. Ask when they can be on site — we want ASAP
  5. Ask if they offer a free estimate (yes → done; no → ask price)
  6. Ask their preferred payment method
  7. Explain the process briefly + confirm you will send WO details by message
  8. Give the address + ask the technician to call when they arrive

Every question must be tailored to THIS specific WO. Weave in relevant
details: the exact issue, the trade jargon they'd expect, and any evidence
requirements. Do NOT be generic.

Return a JSON object with two keys:
  problem_summary: a single short paragraph the dispatcher can read to the tech
                   describing the issue (2-3 sentences, plain English)
  questions: an array of exactly 8 objects, each shaped as:
    {
      step: number 1-8,
      title: short English label (e.g. "Confirm name"),
      question: the full question to ask, written naturally for a phone call,
      type: "text" | "textarea" | "select",
      options: array of strings (only when type is "select")
    }
Type rules:
  - Step 1 (name): type "text"
  - Step 2 (explain problem): type "textarea", prefilled question is the
    problem_summary itself (dispatcher reads it and can edit before saving)
  - Step 3 (specialty match): type "select" with options ["-- select --",
    "Yes — matches specialty", "No — outside specialty", "Partially"]
  - Step 4 (ETA): type "text"
  - Step 5 (free estimate): TWO items — first a "select" with ["-- select --",
    "Yes — free estimate", "No — charges a fee"], second a "text" for fee ($)
  - Step 6 (payment): "select" with ["-- select --", "Check by mail",
    "ACH / Bank transfer", "Credit card", "Zelle", "Cash on completion",
    "Net 30", "Other (see notes)"] AND second item "text" for payment notes
  - Step 7 (process): "select" with ["-- select --", "Yes, explained and sending message", "Not yet"]
  - Step 8 (address+arrival call): "select" with ["-- select --", "Yes, sent address and requested arrival call", "Not yet"]

English only. Practical. Sound like a real dispatcher.`.trim();

    if (!key) {
      // Local fallback — still customized per trade
      const fallback = localHiringQuestions(sow, trade, summary);
      return json({ ...fallback, source: "local" });
    }
    try {
      const schema = {
        type: "object",
        properties: {
          problem_summary: { type: "string" },
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                step: { type: "number" },
                title: { type: "string" },
                question: { type: "string" },
                type: { type: "string" },
                options: { type: "array", items: { type: "string" } },
              },
              required: ["step","title","question","type","options"],
              additionalProperties: false,
            },
          },
        },
        required: ["problem_summary","questions"],
        additionalProperties: false,
      };
      const raw = await callOpenAI(key, model, `${instructions}\n\nWork order:\n${context}`, "hiring", true, schema);
      const parsed = JSON.parse(raw);
      return json({ ...parsed, source: "openai", model });
    } catch (error) {
      const fallback = localHiringQuestions(sow, trade, summary);
      return json({ ...fallback, source: "local", ai_error: (error as Error).message });
    }
  }

  if (body.task === "ping") {
    if (!key) return json({ ok: false, model, key_source: "none", error: "OPENAI_API_KEY is not set in Supabase Edge Function Secrets." });
    try {
      const started = Date.now();
      const reply = await callOpenAI(key, model, "Reply with exactly OK.", "ping", false);
      return json({ ok: true, model, key_source: "server secret", training_revision: settings.training_revision || "built-in", latency_ms: Date.now() - started, reply: reply.trim().slice(0, 40) });
    } catch (error) {
      return json({ ok: false, model, key_source: "server secret", error: (error as Error).message });
    }
  }

  if (body.task === "explain_arabic") {
    const raw = String(body.raw_wo_text || "").trim();
    if (!raw) return json({ error: "raw_wo_text is required" }, 400);
    if (!key) {
      return json({
        problem_explanation_ar: localArabicExplanation(raw, body.sow, body.summary, null),
        source: "local",
      });
    }
    try {
      return json({
        problem_explanation_ar: await createArabicExplanation(key, model, raw, body.sow, body.summary),
        source: "openai",
      });
    } catch (error) {
      return json({
        problem_explanation_ar: localArabicExplanation(raw, body.sow, body.summary, null),
        source: "local",
        ai_error: (error as Error).message,
      });
    }
  }

  if (body.task === "analyze_part") {
    const partTrade = String(body.part_trade || "").trim();
    const partType = String(body.part_type || "").trim();
    const expectedSpecs = Array.isArray(body.expected_specs) ? body.expected_specs.map(String).map((x: string) => x.trim()).filter(Boolean).slice(0, 20) : [];
    const description = String(body.description || "").trim();
    const imageDataUrl = body.image_data_url ? String(body.image_data_url) : null;
    const city = String(body.city || "").trim();
    const state = String(body.state || "").trim().toUpperCase();
    if (!partTrade) return json({ error: "Choose the Part Trade first." }, 400);
    if (!partType) return json({ error: "Choose the Part Type first." }, 400);
    if (!expectedSpecs.length) return json({ error: "The selected Part Type has no technical specification template." }, 400);
    if (!city || !/^[A-Z]{2}$/.test(state)) return json({ error: "The WO City and 2-letter State are required for local market pricing." }, 400);
    if (!description && !imageDataUrl) return json({ error: "A part description or image is required." }, 400);
    if (imageDataUrl && !/^data:image\/(jpeg|png|webp);base64,/i.test(imageDataUrl)) return json({ error: "Part image must be JPG, PNG, or WebP." }, 400);
    if (!key) return json({ error: "OPENAI_API_KEY is not set in Supabase Edge Function Secrets." }, 400);
    try { return json(await analyzePartWithWeb(key, model, partTrade, partType, expectedSpecs, description, imageDataUrl, city, state)); }
    catch (error) { return json({ error: `Part analysis failed: ${(error as Error).message}` }, 500); }
  }

  if (body.task === "analyze") {
    const raw = String(body.raw_wo_text || "").trim();
    if (!raw) return json({ error: "raw_wo_text is required" }, 400);
    let source = "local";
    let aiError = "";
    let extracted: any = null;
    if (key) {
      try {
        extracted = parseJsonObject(await callOpenAI(
          key,
          model,
          `${COMPANY_TRAINING}\n\n${ANALYZE_INSTRUCTIONS}`,
          raw,
          true,
        ));
        source = "openai";
      } catch (error) {
        aiError = (error as Error).message || "Unknown AI extraction error";
      }
    }
    const needsArabicRetry = !validArabicExplanation(extracted?.problem_explanation_ar);
    const analysis: Record<string, unknown> = normalizeAnalysis(extracted, raw);
    if (key && needsArabicRetry) {
      try {
        analysis.problem_explanation_ar = await createArabicExplanation(key, model, raw, analysis.sow, analysis.summary);
      } catch { /* the local Arabic-only explanation remains available */ }
    }
    const geo = await geocode(analysis);
    analysis.latitude = geo.latitude;
    analysis.longitude = geo.longitude;
    return json({
      analysis,
      source,
      training_revision: settings.training_revision || "built-in",
      ...(source === "local" ? { fallback_reason: key ? "ai_error" : "no_key", ...(aiError ? { ai_error: aiError } : {}) } : {}),
    });
  }

  if (body.task === "quote") {
    if (!key) return json({ error: "OPENAI_API_KEY is not set in Supabase Edge Function Secrets." }, 400);
    try {
      const text = await callOpenAI(
        key,
        model,
        `${COMPANY_TRAINING}\n\n${QUOTE_INSTRUCTIONS}`,
        `Work order data (JSON):\n${JSON.stringify(body.work_order || {}, null, 2)}\n\nSaved technician Diagnosis (JSON):\n${JSON.stringify(body.diagnosis || {}, null, 2)}\n\nSaved evidence file index (JSON):\n${JSON.stringify(body.files || [], null, 2)}\n\nCurrent editable Quote, if any:\n${String(body.current_text || "")}\n\nDispatcher revision prompt, if any:\n${String(body.user_prompt || "")}`,
        false,
      );
      return json({ text });
    } catch (error) {
      return json({ error: `Generation failed: ${(error as Error).message}` }, 500);
    }
  }

  if (body.task === "payment") {
    if (!key) return json({ error: "OPENAI_API_KEY is not set in Supabase Edge Function Secrets." }, 400);
    const requestData = { ...(body.payment_request || {}) };
    if (!requestData.status) return json({ error: "Choose the payment request status first." }, 400);
    requestData.status = normalizePaymentStatus(requestData.status);
    if (!requestData.status || !["assessment_completed","deposit","work_done"].includes(requestData.status)) {
      return json({ error: "Allowed Payment Request statuses are Assessment completed, Deposit, or Job Done." }, 400);
    }
    requestData.amount_due = money(requestData.amount_due) || 0;
    requestData.incurred = money(requestData.incurred) || 0;
    requestData.total_cost = requestData.amount_due + requestData.incurred;
    try {
      const text = await callOpenAI(
        key,
        model,
        `${COMPANY_TRAINING}\n\n${PAYMENT_INSTRUCTIONS}`,
        `Work order data (JSON):\n${JSON.stringify(body.work_order || {}, null, 2)}\n\nSelected payment request (JSON):\n${JSON.stringify(requestData, null, 2)}\n\nCurrent editable Payment Request, if any:\n${String(body.current_text || "")}\n\nDispatcher revision prompt, if any:\n${String(body.user_prompt || "")}`,
        false,
      );
      return json({ text, payment_request: requestData });
    } catch (error) {
      return json({ error: `Generation failed: ${(error as Error).message}` }, 500);
    }
  }

  return json({ error: "Unknown task. Use ping | yelp_subtrade | explain_arabic | analyze_part | analyze | quote | payment." }, 400);
});
