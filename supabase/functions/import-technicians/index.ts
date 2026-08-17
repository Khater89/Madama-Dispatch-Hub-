// ============================================================================
// import-technicians
// POST { state: 'LA', rows: [ { name, phone, city, ... }, ... ] }
// Validates, normalizes, de-duplicates, and merges a CSV batch server-side.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
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
  jsonKeyValues(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || undefined).forEach(k => allowed.add(k));
  const legacyAnon = Deno.env.get("SUPABASE_ANON_KEY");
  if (legacyAnon) allowed.add(legacyAnon);
  return allowed.has(supplied);
}
function adminKey(): string | null {
  const modern = jsonKeyValues(Deno.env.get("SUPABASE_SECRET_KEYS") || undefined);
  return modern[0] || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || null;
}

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC",
]);

function normPhone(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length === 10 ? digits : null;
}

function textValue(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function tradeValue(value: unknown): string | null {
  const trade = textValue(value);
  if (!trade) return null;
  const key = trade.toLowerCase();
  if (/plumb/.test(key)) return "Plumber";
  if (/electric/.test(key)) return "Electrical";
  if (/hvac|air\s*condition|heating|cooling/.test(key)) return "HVAC";
  if (/appliance/.test(key)) return "Appliance Repair";
  if (/lock/.test(key)) return "Locksmith";
  if (/glass|window/.test(key)) return "Glass Repair";
  if (/power\s*wash|pressure\s*wash/.test(key)) return "Power Washing";
  if (/landscap|lawn/.test(key)) return "Landscaping";
  if (/snow|plow/.test(key)) return "Snow Removal";
  if (/junk|hauling/.test(key)) return "Junk Removal";
  if (/handyman|general\s*maintenance/.test(key)) return "Handyman";
  return trade;
}

function numberValue(value: unknown): number | null {
  const text = String(value ?? "").replace(/[^0-9.\-]/g, "");
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function booleanValue(value: unknown): boolean | null {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(text)) return true;
  if (["false", "0", "no", "n"].includes(text)) return false;
  return null;
}

function first(row: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  }
  return undefined;
}

function mergePresent(
  previous: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (!previous) return incoming;
  const merged = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== null && value !== undefined && value !== "") merged[key] = value;
  }
  return merged;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!requestIsAuthorized(req)) return json({ error: "Invalid apikey" }, 401);

  const serviceRoleKey = adminKey();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!serviceRoleKey || !supabaseUrl) {
    return json({ error: "Supabase server credentials are not configured" }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const state = String(body.state ?? "").toUpperCase().trim();
  if (!US_STATES.has(state)) return json({ error: "unsupported US state code" }, 400);

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return json({ error: "rows array is empty" }, 400);
  if (rows.length > 5000) return json({ error: "max 5000 rows per call" }, 400);

  const byPhone = new Map<string, Record<string, unknown>>();
  const skipped: Array<{ row: unknown; reason: string }> = [];
  let duplicateCount = 0;

  for (const value of rows) {
    const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const phone = normPhone(first(row, ["phone", "Phone", "PHONE", "normalized_phone"]));
    if (!phone) {
      skipped.push({ row, reason: "no valid 10-digit phone" });
      continue;
    }

    const latitude = numberValue(first(row, ["latitude", "lat"]));
    const longitude = numberValue(first(row, ["longitude", "lng", "lon"]));
    const rating = numberValue(first(row, ["rating"]));
    const reviews = numberValue(first(row, ["reviews_count"]));

    const clean: Record<string, unknown> = {
      name: textValue(first(row, ["name", "Name"])),
      business_name: textValue(first(row, ["business_name", "business", "company"])),
      contact_owner: textValue(first(row, ["contact_owner", "owner"])),
      phone,
      normalized_phone: phone,
      email: textValue(first(row, ["email", "Email"])),
      primary_trade: tradeValue(first(row, ["primary_trade", "trade", "Trade"])),
      city: textValue(first(row, ["city", "City"])),
      zip_code: textValue(first(row, ["zip_code", "zip", "ZIP"])),
      latitude: latitude != null && latitude >= -90 && latitude <= 90 ? latitude : null,
      longitude: longitude != null && longitude >= -180 && longitude <= 180 ? longitude : null,
      rating: rating != null && rating >= 0 && rating <= 5 ? rating : null,
      reviews_count: reviews != null && reviews >= 0 ? Math.trunc(reviews) : null,
      is_vendor: booleanValue(first(row, ["is_vendor"])),
      is_external: booleanValue(first(row, ["is_external"])),
      active: booleanValue(first(row, ["active"])),
      source_type: textValue(first(row, ["source_type"])),
      source_platform: textValue(first(row, ["source_platform", "source"])),
      source_url: textValue(first(row, ["source_url", "url"])),
      facebook_url: textValue(first(row, ["facebook_url", "facebookUrl"])),
      notes: textValue(first(row, ["notes"])),
    };

    if (byPhone.has(phone)) duplicateCount += 1;
    byPhone.set(phone, mergePresent(byPhone.get(phone), clean));
  }

  const cleanRows = [...byPhone.values()];
  if (!cleanRows.length) {
    return json({ error: "no valid rows after cleaning", skipped: skipped.slice(0, 20) }, 400);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.rpc("import_technicians_batch", {
    p_state: state,
    p_rows: cleanRows,
  });

  if (error) return json({ error: error.message, skipped_count: skipped.length }, 500);

  return json({
    ok: true,
    state,
    inserted_or_updated: typeof data === "number" ? data : cleanRows.length,
    skipped_count: skipped.length,
    duplicate_count: duplicateCount,
    skipped_sample: skipped.slice(0, 5),
  });
});
