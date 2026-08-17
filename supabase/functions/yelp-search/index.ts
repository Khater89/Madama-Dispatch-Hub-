const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });

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
  jsonKeyValues(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || undefined).forEach((k) => allowed.add(k));
  const legacyAnon = Deno.env.get("SUPABASE_ANON_KEY");
  if (legacyAnon) allowed.add(legacyAnon);
  return allowed.has(supplied);
}

const TRADE_CONFIG: Record<string, { category?: string; term: string }> = {
  plumber: { category: "plumbing", term: "plumber" },
  plumbing: { category: "plumbing", term: "plumber" },
  electrical: { category: "electricians", term: "electrician" },
  electrician: { category: "electricians", term: "electrician" },
  hvac: { category: "hvac", term: "HVAC" },
  handyman: { category: "handyman", term: "handyman" },
  "appliance repair": { category: "homeappliancerepair", term: "appliance repair" },
  locksmith: { category: "locksmiths", term: "locksmith" },
  "glass repair": { category: "glassandmirrors", term: "glass repair" },
  "power washing": { category: "pressurewashers", term: "pressure washing" },
  landscaping: { category: "landscaping", term: "landscaping" },
};

function memoryBusiness(row: any) {
  return {
    id: row?.yelp_business_id || null,
    name: row?.name || "",
    phone: row?.phone || "",
    distance_miles: null,
    categories: Array.isArray(row?.categories) ? row.categories : [],
    rating: row?.rating ?? null,
    review_count: row?.reviews_count ?? 0,
    url: row?.source_url || "",
    city: row?.city || "",
    state: row?.state || "",
    zip_code: row?.zip_code || "",
    display_address: row?.display_address || "",
    latitude: row?.latitude ?? null,
    longitude: row?.longitude ?? null,
    last_seen_at: row?.last_seen_at || null,
    search_count: Number(row?.search_count || 0),
    source: "memory",
  };
}

async function readYelpMemory(args: {
  supabaseUrl: string;
  serverKey: string;
  trade: string;
  zip: string;
  city: string;
  state: string;
  limit: number;
}) {
  const { supabaseUrl, serverKey, trade, zip, city, state, limit } = args;
  if (!supabaseUrl || !serverKey) return { businesses: [], match: "unavailable", warning: "Yelp Search Memory server key is unavailable." };

  const select = "yelp_business_id,name,phone,normalized_phone,primary_trade,categories,rating,reviews_count,source_url,city,state,zip_code,latitude,longitude,display_address,last_seen_at,search_count";

  const run = async (match: "zip" | "city_state") => {
    const u = new URL(`${supabaseUrl}/rest/v1/yelp_search_results`);
    u.searchParams.set("select", select);
    u.searchParams.set("primary_trade", `ilike.${trade}`);
    if (match === "zip") {
      u.searchParams.set("zip_code", `eq.${zip}`);
    } else {
      u.searchParams.set("city", `ilike.${city}`);
      if (state) u.searchParams.set("state", `eq.${state}`);
    }
    u.searchParams.set("order", "last_seen_at.desc");
    u.searchParams.set("limit", String(limit));

    const r = await fetch(u.toString(), {
      headers: {
        apikey: serverKey,
        Authorization: `Bearer ${serverKey}`,
        Accept: "application/json",
      },
    });
    if (!r.ok) throw new Error(`Memory HTTP ${r.status}: ${(await r.text()).slice(0, 180)}`);
    const rows = await r.json();
    return Array.isArray(rows) ? rows.map(memoryBusiness) : [];
  };

  try {
    if (zip.length === 5) {
      const exactZip = await run("zip");
      if (exactZip.length) return { businesses: exactZip, match: "same ZIP", warning: null };
    }
    if (city) {
      const sameCity = await run("city_state");
      if (sameCity.length) return { businesses: sameCity, match: "same city/state", warning: null };
    }
    return { businesses: [], match: zip.length === 5 ? "same ZIP" : "same city/state", warning: null };
  } catch (error) {
    return {
      businesses: [],
      match: "error",
      warning: `Could not read Yelp Search Memory: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}


function coverageTrade(raw: unknown): string {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "Unknown";
  if (s.includes("plumb")) return "Plumber";
  if (s.includes("electric")) return "Electrical";
  if (s.includes("hvac") || s.includes("heating") || s.includes("cooling")) return "HVAC";
  if (s.includes("handyman")) return "Handyman";
  if (s.includes("appliance")) return "Appliance Repair";
  if (s.includes("locksmith")) return "Locksmith";
  if (s.includes("glass")) return "Glass Repair";
  if (s.includes("power wash") || s.includes("pressure wash")) return "Power Washing";
  if (s.includes("landscap")) return "Landscaping";
  if (s.includes("snow")) return "Snow Removal";
  if (s.includes("junk")) return "Junk Removal";
  return String(raw || "Unknown").trim();
}

function coverageSoloProbability(row: any): number {
  const name = String(row?.name || "").trim();
  const low = name.toLowerCase();
  const reviews = Math.max(0, Number(row?.reviews_count || 0) || 0);
  const digits = String(row?.normalized_phone || row?.phone || "").replace(/\D/g, "");
  const hasPhone = digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
  let score = 55;
  if (/\b[a-z]{2,18}[’']s\b/i.test(name)) score += 18;
  if (/^(?:[a-z]+\s+){0,2}(?:plumbing|plumber|hvac|heating|cooling|electric|electrical|electrician|handyman|appliance|rooter|drain)\b/i.test(name)) score += 9;
  if (reviews > 0 && reviews <= 15) score += 13;
  else if (reviews <= 50 && reviews > 15) score += 9;
  else if (reviews <= 150 && reviews > 50) score += 3;
  else if (reviews > 500) score -= 16;
  else if (reviews > 150) score -= 7;
  if (/\b(?:inc\.?|corp\.?|corporation|group|enterprises|franchise|nationwide|national)\b/i.test(name)) score -= 10;
  if (/\b(?:roto[- ]?rooter|mr\.? rooter|one hour heating|service experts|ars rescue rooter|benjamin franklin plumbing|mister sparky|aire serv|precision today|horizon services)\b/i.test(low)) score -= 32;
  score += hasPhone ? 4 : -8;
  return Math.max(5, Math.min(97, Math.round(score)));
}

async function coveragePagedRows(supabaseUrl: string, serverKey: string, table: string, select: string, extra: Record<string,string> = {}) {
  const all: any[] = [];
  const size = 1000;
  for (let offset = 0; offset < 200000; offset += size) {
    const u = new URL(`${supabaseUrl}/rest/v1/${table}`);
    u.searchParams.set("select", select);
    u.searchParams.set("limit", String(size));
    u.searchParams.set("offset", String(offset));
    for (const [k,v] of Object.entries(extra)) u.searchParams.set(k,v);
    const r = await fetch(u.toString(), { headers: { apikey: serverKey, Authorization: `Bearer ${serverKey}`, Accept: "application/json" } });
    if (!r.ok) throw new Error(`${table} HTTP ${r.status}: ${(await r.text()).slice(0,180)}`);
    const batch = await r.json();
    if (!Array.isArray(batch)) break;
    all.push(...batch);
    if (batch.length < size) break;
  }
  return all;
}

function coverageMaxDate(a: string | null, b: unknown): string | null {
  if (!b) return a;
  const bt = new Date(String(b)).getTime();
  if (!Number.isFinite(bt)) return a;
  if (!a) return String(b);
  const at = new Date(a).getTime();
  return !Number.isFinite(at) || bt > at ? String(b) : a;
}

async function buildCoverageSnapshot(supabaseUrl: string, serverKey: string) {
  if (!supabaseUrl || !serverKey) throw new Error("Supabase server key is unavailable.");
  const sourceResults = await Promise.allSettled([
    coveragePagedRows(supabaseUrl, serverKey, "yelp_search_results", "yelp_business_id,name,phone,normalized_phone,primary_trade,reviews_count,city,state,zip_code,last_search_location,last_seen_at"),
    coveragePagedRows(supabaseUrl, serverKey, "technicians", "id,name,business_name,phone,normalized_phone,primary_trade,city,state,zip_code,solo_list_member,updated_at", { solo_list_member: "eq.true" }),
    coveragePagedRows(supabaseUrl, serverKey, "worked_with_technicians", "id,name,business_name,phone,normalized_phone,primary_trade,city,state,zip_code,last_used_at,updated_at"),
    coveragePagedRows(supabaseUrl, serverKey, "work_orders", "id,trade,city,state,zip_code,created_at")
  ]);
  const sourceNames = ["Yelp Memory", "Confirmed Solo", "Worked With", "Work Orders"];
  const warnings = sourceResults.flatMap((result, index) =>
    result.status === "rejected" ? [`${sourceNames[index]} unavailable: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []
  );
  const [yelp, solo, worked, orders] = sourceResults.map(result => result.status === "fulfilled" && Array.isArray(result.value) ? result.value : []);

  type Group = { state:string; city:string; zip_code:string; trade:string; yelp_results:number; likely_solo:number; confirmed_solo:number; worked_with:number; work_orders:number; last_search_at:string|null };
  const groups = new Map<string, Group>();
  const zip5 = (v: unknown) => { const m = String(v || "").match(/\b(\d{5})\b/); return m ? m[1] : ""; };
  const add = (row: any, source: "yelp"|"solo"|"worked"|"wo") => {
    const trade = coverageTrade(source === "wo" ? row?.trade : row?.primary_trade);
    const state = String(row?.state || "").trim().toUpperCase().slice(0,2);
    const city = String(row?.city || "").trim();
    const searchedZip = source === "yelp" ? zip5(row?.last_search_location) : "";
    const zip = searchedZip || zip5(row?.zip_code);
    if (!state && !city && !zip) return;
    const areaKey = zip ? `${state}|${zip}` : `${state}|${city.toLowerCase()}`;
    const key = `${trade}|${areaKey}`;
    let g = groups.get(key);
    if (!g) { g = { state, city, zip_code:zip, trade, yelp_results:0, likely_solo:0, confirmed_solo:0, worked_with:0, work_orders:0, last_search_at:null }; groups.set(key,g); }
    if (!g.state && state) g.state = state;
    if (!g.city && city) g.city = city;
    if (!g.zip_code && zip) g.zip_code = zip;
    if (source === "yelp") { g.yelp_results++; if (coverageSoloProbability(row) >= 70) g.likely_solo++; g.last_search_at = coverageMaxDate(g.last_search_at,row?.last_seen_at); }
    else if (source === "solo") g.confirmed_solo++;
    else if (source === "worked") g.worked_with++;
    else if (source === "wo") g.work_orders++;
  };
  yelp.forEach((r:any)=>add(r,"yelp"));solo.forEach((r:any)=>add(r,"solo"));worked.forEach((r:any)=>add(r,"worked"));orders.forEach((r:any)=>add(r,"wo"));

  const rows = [...groups.values()].map(g => {
    const score = Math.min(25, g.yelp_results * 1.25) + Math.min(25, g.likely_solo * 2.5) + Math.min(30, g.confirmed_solo * 6) + Math.min(20, g.worked_with * 10);
    const rounded = Math.max(0, Math.min(100, Math.round(score)));
    const usable = g.yelp_results + g.confirmed_solo + g.worked_with;
    const status = usable === 0 ? "EMPTY" : rounded >= 70 ? "GOOD" : "WEAK";
    const area_label = [g.zip_code, [g.city,g.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
    return { ...g, score:rounded, status, area_label };
  }).sort((a,b)=>a.score-b.score || b.work_orders-a.work_orders || a.state.localeCompare(b.state) || a.city.localeCompare(b.city) || a.trade.localeCompare(b.trade));
  return {
    rows,
    totals:{ yelp:yelp.length, confirmed_solo:solo.length, worked_with:worked.length, work_orders:orders.length },
    warning: warnings.length ? warnings.join(" | ") : null
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!requestIsAuthorized(req)) return json({ error: "Invalid apikey" }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const mode = String(body.mode || "live").trim().toLowerCase();
  const trade = String(body.trade || "").trim();
  const zip = String(body.zip_code || body.zip || "").replace(/\D/g, "").slice(0, 5);
  const city = String(body.city || "").trim();
  const state = String(body.state || "").trim().toUpperCase().slice(0, 2);
  const description = String(body.description || "").trim();
  const subtrade = String(body.subtrade || "").trim().slice(0, 80);
  const requestedSearchTerm = String(body.search_term || "").trim().replace(/[\r\n]+/g, " ").slice(0, 100);
  const requestedLimit = Number(body.limit || 50);
  const limit = Math.max(1, Math.min(50, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 50));

  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const serverKey = (Deno.env.get("SUPABASE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();

  if (mode === "coverage") {
    try {
      const snapshot = await buildCoverageSnapshot(supabaseUrl, serverKey);
      return json({ mode:"coverage", generated_at:new Date().toISOString(), ...snapshot });
    } catch (error) {
      return json({ error:`Could not build Coverage: ${error instanceof Error ? error.message : String(error)}` }, 500);
    }
  }

  if (!trade) return json({ error: "trade is required" }, 400);
  if (zip.length !== 5 && !city) return json({ error: "ZIP or city is required" }, 400);
  const location = zip.length === 5 ? zip : [city, state].filter(Boolean).join(", ");

  if (mode === "memory") {
    const memory = await readYelpMemory({ supabaseUrl, serverKey, trade, zip, city, state, limit });
    return json({
      mode: "memory",
      businesses: memory.businesses,
      total: memory.businesses.length,
      trade,
      location,
      memory_match: memory.match,
      memory_warning: memory.warning,
    });
  }

  const apiKey = (Deno.env.get("YELP_API_KEY") || "").trim();
  if (!apiKey) return json({ error: "YELP_API_KEY is not configured in Supabase Edge Function secrets." }, 500);

  const key = trade.toLowerCase();
  const cfg = TRADE_CONFIG[key] || { term: trade };
  const searchTerm = requestedSearchTerm || cfg.term;

  const url = new URL("https://api.yelp.com/v3/businesses/search");
  url.searchParams.set("location", location);
  url.searchParams.set("term", searchTerm);
  if (cfg.category) url.searchParams.set("categories", cfg.category);
  // Do not constrain Yelp with a client-visible radius. MDAMA saves every
  // business Yelp returns, while index.html applies the 60-mile dispatch
  // display boundary. Yelp itself may expand/shrink the effective area.
  url.searchParams.set("sort_by", "distance");
  url.searchParams.set("limit", String(limit));

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
  } catch (error) {
    return json({ error: `Could not reach Yelp: ${error instanceof Error ? error.message : String(error)}` }, 502);
  }

  let payload: any = {};
  try { payload = await response.json(); } catch { /* keep empty */ }
  if (!response.ok) {
    return json({
      error: payload?.error?.description || payload?.error?.code || `Yelp HTTP ${response.status}`,
      yelp_code: payload?.error?.code || null,
    }, response.status);
  }

  const businesses = (Array.isArray(payload?.businesses) ? payload.businesses : []).map((b: any) => ({
    id: b?.id || null,
    name: b?.name || "",
    phone: b?.display_phone || b?.phone || "",
    distance_miles: Number.isFinite(Number(b?.distance)) ? Number((Number(b.distance) / 1609.344).toFixed(1)) : null,
    categories: Array.isArray(b?.categories) ? b.categories.map((c: any) => c?.title).filter(Boolean) : [],
    rating: b?.rating ?? null,
    review_count: b?.review_count ?? 0,
    url: b?.url || "",
    city: b?.location?.city || "",
    state: b?.location?.state || "",
    zip_code: b?.location?.zip_code || "",
    display_address: Array.isArray(b?.location?.display_address) ? b.location.display_address.join(", ") : "",
    latitude: b?.coordinates?.latitude ?? null,
    longitude: b?.coordinates?.longitude ?? null,
    source: "live",
  }));

  // Save every Yelp result to MDAMA search memory. Best-effort only: a DB
  // issue must never prevent a dispatcher from seeing usable Yelp results.
  let savedCount = 0;
  let saveWarning: string | null = null;

  if (businesses.length && supabaseUrl && serverKey) {
    const memoryRows = businesses
      .filter((b: any) => b.id)
      .map((b: any) => {
        const digits = String(b.phone || "").replace(/\D/g, "");
        const normalizedPhone = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
        return {
          yelp_business_id: String(b.id),
          name: b.name || null,
          phone: b.phone || null,
          normalized_phone: normalizedPhone || null,
          primary_trade: trade || null,
          categories: Array.isArray(b.categories) ? b.categories : [],
          rating: b.rating ?? null,
          reviews_count: Number(b.review_count || 0),
          source_url: b.url || null,
          city: b.city || null,
          state: b.state || null,
          zip_code: b.zip_code || null,
          latitude: b.latitude ?? null,
          longitude: b.longitude ?? null,
          display_address: b.display_address || null,
          last_search_location: location || null,
        };
      });

    if (memoryRows.length) {
      try {
        const saveResponse = await fetch(
          `${supabaseUrl}/rest/v1/yelp_search_results?on_conflict=yelp_business_id`,
          {
            method: "POST",
            headers: {
              apikey: serverKey,
              Authorization: `Bearer ${serverKey}`,
              "Content-Type": "application/json",
              Prefer: "resolution=merge-duplicates,return=minimal",
            },
            body: JSON.stringify(memoryRows),
          },
        );
        if (!saveResponse.ok) {
          const saveText = await saveResponse.text();
          saveWarning = `Yelp results returned, but search memory was not saved (HTTP ${saveResponse.status}${saveText ? `: ${saveText.slice(0, 180)}` : ""}).`;
        } else {
          savedCount = memoryRows.length;
        }
      } catch (error) {
        saveWarning = `Yelp results returned, but search memory was not saved: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  } else if (businesses.length) {
    saveWarning = "Yelp results returned, but the Supabase server-side database key is unavailable to the Edge Function.";
  }

  return json({
    mode: "live",
    total: payload?.total ?? businesses.length,
    businesses,
    trade,
    search_term: searchTerm,
    subtrade: subtrade || null,
    category: cfg.category || null,
    location,
    description,
    saved_count: savedCount,
    save_warning: saveWarning,
  });
});
