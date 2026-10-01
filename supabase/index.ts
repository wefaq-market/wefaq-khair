// Wefaq — radar-sync v15
// Orchestrates the live collector and the smart processor, then returns production leads.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function cleanText(value: unknown, max = 5000) { return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max); }

async function getUser(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  if (!auth) return null;
  const token = auth.replace(/^Bearer\s+/i, "");
  const { data, error } = await db.auth.getUser(token);
  return error || !data?.user ? null : data.user;
}

async function invokeFunction(name: string, token: string, payload: Record<string, unknown>) {
  const url = `${SUPABASE_URL}/functions/v1/${name}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  let body: any = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
  if (!response.ok) throw new Error(`${name} ${response.status}: ${cleanText(body?.message || body?.error || raw, 900)}`);
  return body;
}

function sourceStatus(id: string, missing: string[]) {
  const missingSet = new Set(missing);
  if (id === "youtube") return missingSet.has("YOUTUBE_API_KEY") ? "pending" : "ready";
  if (id === "x") return missingSet.has("X_BEARER_TOKEN") ? "pending" : "ready";
  if (id === "reddit") return missingSet.has("REDDIT_CLIENT_ID") || missingSet.has("REDDIT_CLIENT_SECRET") ? "pending" : "ready";
  if (id === "web") return missingSet.has("BRAVE_SEARCH_API_KEY") && missingSet.has("GOOGLE_CSE_API_KEY/GOOGLE_CSE_ID") ? "pending" : "ready";
  if (id === "telegram") return Deno.env.get("TELEGRAM_BOT_TOKEN") ? "ready" : "pending";
  return "pending";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ ok: true, service: "wefaq-radar-sync", role: "orchestrator" }), { headers: { ...corsHeaders, "content-type": "application/json" } });

  try {
    const user = await getUser(req);
    if (!user) return new Response(JSON.stringify({ ok: false, error: "auth_required" }), { status: 401, headers: { ...corsHeaders, "content-type": "application/json" } });
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const payload = await req.json().catch(() => ({}));
    const requestedSources = Array.isArray(payload?.requested_sources) ? payload.requested_sources.map((x: unknown) => String(x)) : ["web", "youtube", "x", "reddit"];
    const educationalQuery = cleanText(payload?.query || "مطلوب محفظ قرآن OR أبحث عن معلم قرآن OR تحفيظ قرآن OR مطلوب مدرس لغة عربية OR تعليم أطفال", 1200);
    const days = Math.min(Math.max(Number(payload?.days || 7), 1), 30);

    const run = await db.from("radar_sync_runs").insert({ source_ids: requestedSources, status: "running" }).select("id").single();
    const runId = run.data?.id;

    let collector: any = null;
    const orchestrationErrors: string[] = [];
    try {
      collector = await invokeFunction("social-radar-sync", token, { provider: "all", query: educationalQuery, days, max_results: 50 });
    } catch (error) {
      orchestrationErrors.push(cleanText(error instanceof Error ? error.message : String(error), 900));
    }

    let processor: any = null;
    try {
      processor = await invokeFunction("smart-processor", token, { hours: Math.min(days * 24, 720), limit: 700 });
    } catch (error) {
      orchestrationErrors.push(cleanText(error instanceof Error ? error.message : String(error), 900));
    }

    const { data: leads, error: leadsError } = await db
      .from("radar_leads")
      .select("id,source_type,external_id,title,snippet,persona,category,priority,source,source_url,published_at,discovered_at,last_seen_at,score,triage_confidence,status,consent_status,tags,region,country_code,city,language,languages,mode,intent_type,amount,currency")
      .in("status", ["new", "review", "saved", "contacted", "converted"])
      .order("discovered_at", { ascending: false })
      .limit(200);
    if (leadsError) throw leadsError;

    const missing = Array.isArray(collector?.missing_credentials) ? collector.missing_credentials : [];
    const sourceIds = ["web","youtube","x","reddit","telegram","rss","meta","linkedin","freelance"];
    const sourceMap: Record<string, any> = {};
    for (const id of sourceIds) sourceMap[id] = { status: sourceStatus(id, missing) };
    if (collector?.telegram === "webhook_only") sourceMap.telegram = { status: sourceStatus("telegram", missing), mode: "authorized webhook" };

    // Persist only connector readiness metadata; no synthetic lead counts are written.
    for (const id of sourceIds) {
      await db.from("radar_sources").upsert({
        id,
        name: id === "web" ? "Open Web Search" : id === "youtube" ? "YouTube" : id === "x" ? "X / Twitter" : id === "reddit" ? "Reddit" : id === "telegram" ? "Telegram" : id === "rss" ? "RSS / Feeds" : id === "meta" ? "Meta official connectors" : id === "linkedin" ? "LinkedIn official connectors" : "Arabic freelance sources",
        source_type: id,
        status: sourceMap[id].status,
        last_synced_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "id" });
    }

    const newCount = Number(processor?.new_count || 0);
    const updatedCount = Number(processor?.updated_count || 0);
    const dedupedCount = Number(processor?.deduped_count || 0);
    const foundCount = Number(processor?.found || 0);
    const errorCount = Number(processor?.error_count || 0) + orchestrationErrors.length;
    const finalStatus = errorCount ? ((leads || []).length ? "partial" : "failed") : "completed";

    if (runId) {
      await db.from("radar_sync_runs").update({
        finished_at: new Date().toISOString(), status: finalStatus,
        found_count: foundCount, new_count: newCount, updated_count: updatedCount,
        deduped_count: dedupedCount, error_count: errorCount,
        notes: { collector: collector?.synced || {}, collector_errors: collector?.errors || {}, orchestration_errors: orchestrationErrors, educational_only: true },
      }).eq("id", runId);
    }

    return new Response(JSON.stringify({
      ok: true,
      leads: (leads || []).map((x: any) => ({ ...x, sourceType: x.source_type, hoursAgo: Math.max(0, (Date.now() - new Date(x.discovered_at || x.last_seen_at || Date.now()).getTime()) / 36e5), type: x.intent_type, budget: x.amount, budget_currency: x.currency })),
      stats: { found_count: foundCount, new_count: newCount, updated_count: updatedCount, deduped_count: dedupedCount, error_count: errorCount },
      sources: sourceMap,
      missing_credentials: [...new Set(missing)],
      errors: orchestrationErrors,
      requested_by: user.id,
      live_only: true,
    }), { headers: { ...corsHeaders, "content-type": "application/json" } });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: "radar_sync_failed", message: cleanText(error instanceof Error ? error.message : String(error), 900) }), { status: 500, headers: { ...corsHeaders, "content-type": "application/json" } });
  }
});
