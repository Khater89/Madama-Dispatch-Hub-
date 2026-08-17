// ============================================================================
// rank-technicians
// POST { work_order_id?: string, work_order?: object, limit?: number, facebook_only?: boolean }
// Reads the WO + non-vendor techs matching its trade, scores them by
// geo distance (Google Distance Matrix when coords exist, else honest ZIP/state/city
// buckets — never numeric ZIP subtraction) blended with response history, writes the top N to
// work_order_candidates, and returns the ranked list.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

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

function haversine(a: number, b: number, c: number, d: number) {
  const R = 3958.8, toR = (x: number) => (x * Math.PI) / 180;
  const dLat = toR(c - a), dLon = toR(d - b);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(a)) * Math.cos(toR(c)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Google Distance Matrix for up to 25 destinations per call
async function driveMiles(oLat: number, oLng: number, dests: {latitude:number;longitude:number}[]) {
  const key = Deno.env.get("GOOGLE_MAPS_API_KEY");
  const out = new Array(dests.length).fill(null) as (number | null)[];
  if (!key || !dests.length) return out;
  for (let i = 0; i < dests.length; i += 25) {
    const chunk = dests.slice(i, i + 25);
    const u = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
    u.searchParams.set("origins", `${oLat},${oLng}`);
    u.searchParams.set("destinations", chunk.map(d => `${d.latitude},${d.longitude}`).join("|"));
    u.searchParams.set("units", "imperial");
    u.searchParams.set("key", key);
    try {
      const r = await fetch(u.toString());
      const j = await r.json();
      const row = j?.rows?.[0]?.elements || [];
      row.forEach((el: any, k: number) => {
        if (el?.status === "OK" && el.distance?.value != null)
          out[i + k] = el.distance.value / 1609.344;
      });
    } catch { /* leave nulls */ }
  }
  return out;
}

function serverKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const secretJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretJson) {
    try {
      const obj = JSON.parse(secretJson);
      const first = Object.values(obj)[0];
      if (typeof first === "string") return first;
    } catch { /* */ }
  }
  return Deno.env.get("SUPABASE_ANON_KEY") || "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!requestIsAuthorized(req)) return json({ error: "Invalid apikey" }, 401);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    serverKey(),
  );

  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const woId = body.work_order_id || null;
  const limit = Math.min(Math.max(body.limit ?? 20, 1), 50);
  const facebookOnly = body.facebook_only === true;

  // Saved WO mode uses the database row. Preview mode accepts the analyzed WO
  // fields directly so the browser can rank against the FULL technician table
  // before the dispatcher saves the WO.
  let wo: any = null;
  if (woId) {
    const { data, error } = await supabase
      .from("work_orders").select("*").eq("id", woId).single();
    if (error || !data) return json({ error: "work order not found" }, 404);
    wo = data;
  } else if (body.work_order && typeof body.work_order === "object") {
    wo = body.work_order;
  } else {
    return json({ error: "work_order_id or work_order preview is required" }, 400);
  }

  const woState = String(wo.state || "").toUpperCase().trim();
  const woZipRaw = String(wo.zip_code || "").replace(/\D/g, "").slice(0, 5);
  const zipPrefix3 = woZipRaw.length >= 3 ? woZipRaw.slice(0, 3) : "";
  const zipPrefix2 = woZipRaw.length >= 2 ? woZipRaw.slice(0, 2) : "";
  const zipPrefix1 = woZipRaw.length >= 1 ? woZipRaw.slice(0, 1) : "";

  const tradeRaw = String(wo.trade || "").replace(/[%,]/g, "").trim();

  // Pull the qualifying pool from the DATABASE, in tiers, so a 100k+ table
  // returns a small ordered shortlist we can safely rank in memory. Every
  // tier hits the indexed columns (state / primary_trade / zip_code).
  const SHORTLIST = 300;                  // enough for ranking, small enough to be fast
  const seen = new Set<string>();
  const pool: any[] = [];

  async function pullTier(builder: (q: any) => any, tag: string) {
    if (pool.length >= SHORTLIST) return;
    const remaining = SHORTLIST - pool.length;
    let q = supabase.from("technicians").select("*")
      .eq("is_vendor", false).eq("active", true);
    if (facebookOnly) q = q.not("facebook_url", "is", null).neq("facebook_url", "");
    q = builder(q).limit(remaining);
    const { data, error } = await q;
    if (error) throw error;
    for (const t of (data || [])) {
      const id = String(t.id);
      if (!seen.has(id)) { seen.add(id); pool.push({ ...t, _tier: tag }); }
    }
  }

  const tradeFilter = (q: any) => {
    if (!tradeRaw) return q;
    return q.or(`primary_trade.eq.${tradeRaw},primary_trade.ilike.*${tradeRaw}*,secondary_trades.cs.{${tradeRaw}}`);
  };

  try {
    // With a requested trade, NEVER fill the shortlist with the wrong trade.
    // Expand geographically instead: ZIP -> state -> ZIP region -> nationwide trade.
    if (tradeRaw) {
      // Tier 1 — same ZIP prefix + trade (usually the closest useful bucket)
      if (zipPrefix3) {
        await pullTier(q => tradeFilter(q).ilike("zip_code", zipPrefix3 + "%"), "zip3+trade");
      }
      // Tier 2 — same state + trade
      if (woState && pool.length < SHORTLIST) {
        await pullTier(q => tradeFilter(q).eq("state", woState), "state+trade");
      }
      // Tier 3 — broader ZIP region + trade. Useful near state borders.
      if (zipPrefix1 && pool.length < SHORTLIST) {
        await pullTier(q => tradeFilter(q).ilike("zip_code", zipPrefix1 + "%"), "zip1+trade");
      }
      // Tier 4 — same trade nationwide as the final fallback.
      if (pool.length < SHORTLIST) {
        await pullTier(q => tradeFilter(q), "trade");
      }
    } else {
      // If the WO has no trade yet, proximity-only fallback is allowed.
      if (zipPrefix3) await pullTier(q => q.ilike("zip_code", zipPrefix3 + "%"), "zip3");
      if (woState && pool.length < SHORTLIST) await pullTier(q => q.eq("state", woState), "state");
      if (pool.length === 0) await pullTier(q => q, "any");
    }
  } catch (e) {
    return json({ error: (e as Error).message || "database query failed" }, 500);
  }
  const techs = pool;

  const hasOrigin = wo.latitude != null && wo.longitude != null;
  const geoTechs = techs.filter(t => t.latitude != null && t.longitude != null);

  const drivenMap = new Map<string, number>();
  if (hasOrigin && geoTechs.length) {
    const withAir = geoTechs
      .map(t => ({ t, air: haversine(wo.latitude, wo.longitude, t.latitude, t.longitude) }))
      .sort((a, b) => a.air - b.air);
    const near = withAir.slice(0, 25);
    const driven = await driveMiles(wo.latitude, wo.longitude, near.map(x => x.t));
    near.forEach((x, i) => {
      const m = driven[i] != null ? driven[i]! : x.air;
      drivenMap.set(x.t.id, m);
    });
    withAir.slice(25).forEach(x => drivenMap.set(x.t.id, x.air));
  }

  const scored = techs.map(t => {
    let score = 1000;
    let dist: number | null = drivenMap.has(t.id) ? drivenMap.get(t.id)! : null;
    const reasons: string[] = [];

    if (dist != null) {
      score -= Math.max(0, 800 - Math.min(dist, 250) * 3.4);
      reasons.push(`${dist.toFixed(1)} mi away`);
    } else {
      // No coordinates → use ZIP proximity first, then state/city as a fallback.
      const tZipRaw = String(t.zip_code || "").replace(/\D/g, "").slice(0, 5);

      // ZIP codes are identifiers, not coordinates. Numeric subtraction between ZIPs
      // can put a farther technician ahead of a nearer one, so use only honest
      // geographic buckets when coordinates are unavailable.
      if (woZipRaw.length === 5 && tZipRaw.length === 5) {
        if (tZipRaw === woZipRaw) {
          score -= 650; reasons.push(`same ZIP ${tZipRaw}`);
        } else if (tZipRaw.slice(0, 3) === zipPrefix3) {
          score -= 500; reasons.push(`same 3-digit ZIP area`);
        } else if (tZipRaw.slice(0, 2) === zipPrefix2) {
          score -= 300; reasons.push(`same 2-digit ZIP area`);
        } else if (tZipRaw.slice(0, 1) === zipPrefix1) {
          score -= 120; reasons.push(`same ZIP region`);
        }
      }

      if (wo.state && String(t.state).toUpperCase() === String(wo.state).toUpperCase()) {
        score -= 300; reasons.push("same state");
      }
      if (wo.city && String(t.city || "").toLowerCase() === String(wo.city).toLowerCase()) {
        score -= 150; reasons.push("same city");
      }
    }
    if (t.has_completed_job) { score -= 80; reasons.push("completed before"); }
    else if (t.has_accepted_job) { score -= 50; reasons.push("accepted before"); }
    else if (t.has_responded) { score -= 25; reasons.push("responded before"); }
    if (t.rating) score -= Number(t.rating) * 8;

    return { tech: t, score, dist, reason: reasons.join(" · ") || "trade match" };
  }).sort((a, b) => a.score - b.score);

  const top = scored.slice(0, limit);

  // persist shortlist
  const rows = top.map((s, i) => ({
    work_order_id: woId,
    technician_id: s.tech.id,
    rank: i + 1,
    score: Number(s.score.toFixed(2)),
    distance_miles: s.dist != null ? Number(s.dist.toFixed(2)) : null,
    reason: s.reason,
    outcome: "shortlisted",
  }));
  if (woId && rows.length) {
    await supabase.from("work_order_candidates")
      .upsert(rows, { onConflict: "work_order_id,technician_id" });
  }

  // Tell the front-end which tier each candidate came from so the operator
  // can see at a glance whether we hit the primary bucket or fell back.
  const tierCount: Record<string, number> = {};
  techs.forEach(t => { const tag = String(t._tier || "unknown"); tierCount[tag] = (tierCount[tag] || 0) + 1; });

  return json({
    work_order_id: woId,
    total_pool: scored.length,
    facebook_only: facebookOnly,
    used_drive_matrix: hasOrigin && geoTechs.length > 0,
    filter_summary: {
      wo_state: woState || null,
      wo_zip: woZipRaw || null,
      wo_trade: tradeRaw || null,
      tiers_used: tierCount,
      shortlist_size: techs.length,
      note: techs.length < 20
        ? "Small pool. Check spelling of state/trade or add more technicians for this state."
        : null,
    },
    candidates: top.map((s, i) => ({
      rank: i + 1,
      score: Number(s.score.toFixed(2)),
      distance_miles: s.dist != null ? Number(s.dist.toFixed(2)) : null,
      reason: s.reason,
      tier: s.tech._tier,
      source_kind: /company[_ -]?map|all[_ -]?techs[_ -]?map|google[_ -]?my[_ -]?maps|my maps/i.test(String(s.tech.source_type || "") + " " + String(s.tech.source_platform || "") + " " + String(s.tech.notes || "")) ? "company_map" : (s.tech.is_external ? "solo_db" : "company_db"),
      technician: s.tech,
    })),
  });
});
