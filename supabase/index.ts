// Wefaq — smart-endpoint v15
// Authenticated read/query API over production radar_leads; no external scraping here.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const url = Deno.env.get("SUPABASE_URL")!;
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(url, key);
function clean(v: unknown, max = 1000) { return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") return new Response(JSON.stringify({ ok: true, service: "wefaq-smart-endpoint", role: "read-api" }), { headers: { ...corsHeaders, "content-type": "application/json" } });
  try {
    const auth = req.headers.get("Authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    const { data: user, error: authError } = await db.auth.getUser(token);
    if (authError || !user?.user) return new Response(JSON.stringify({ ok: false, error: "auth_required" }), { status: 401, headers: { ...corsHeaders, "content-type": "application/json" } });

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const qs = new URL(req.url).searchParams;
    const persona = clean(body?.persona || qs.get("persona") || "");
    const region = clean(body?.region || qs.get("region") || "");
    const category = clean(body?.category || qs.get("category") || "");
    const mode = clean(body?.mode || qs.get("mode") || "");
    const language = clean(body?.language || qs.get("language") || "");
    const q = clean(body?.q || qs.get("q") || "").toLowerCase();
    const limit = Math.min(Math.max(Number(body?.limit || qs.get("limit") || 50), 1), 200);

    let query = db.from("radar_leads")
      .select("id,source_type,external_id,title,snippet,persona,category,priority,source,source_url,published_at,discovered_at,last_seen_at,score,triage_confidence,status,consent_status,tags,region,country_code,city,language,languages,mode,intent_type,amount,currency")
      .in("status", ["new", "review", "saved", "contacted", "converted"])
      .order("score", { ascending: false })
      .order("discovered_at", { ascending: false })
      .limit(limit);
    if (persona) query = query.eq("persona", persona);
    if (region) query = query.or(`region.eq.${region},country_code.eq.${region}`);
    if (category) query = query.eq("category", category);
    if (mode) query = query.eq("mode", mode);
    if (language) query = query.or(`language.eq.${language},languages.cs.{${language}}`);

    const { data: rows, error } = await query;
    if (error) throw error;
    const leads = (rows || []).filter((row: any) => {
      if (!q) return true;
      return [row.title, row.snippet, row.source, row.category, row.region, ...(row.tags || [])].join(" ").toLowerCase().includes(q);
    });

    const metrics = {
      total: leads.length,
      hot: leads.filter((x: any) => x.priority === "hot").length,
      students: leads.filter((x: any) => x.persona === "student").length,
      teachers: leads.filter((x: any) => x.persona === "teacher").length,
      services: leads.filter((x: any) => x.persona === "service").length,
      demand: leads.filter((x: any) => x.intent_type === "demand").length,
      supply: leads.filter((x: any) => x.intent_type === "supply").length,
    };
    return new Response(JSON.stringify({ ok: true, leads, metrics, requested_by: user.user.id }), { headers: { ...corsHeaders, "content-type": "application/json" } });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: "smart_query_failed", message: clean(error instanceof Error ? error.message : String(error), 900) }), { status: 500, headers: { ...corsHeaders, "content-type": "application/json" } });
  }
});
