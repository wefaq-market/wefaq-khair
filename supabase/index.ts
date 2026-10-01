// Wefaq — social-radar-sync v15
// Collector only: fetch public/authorized external signals and persist them as source_items.
// No private messages, private groups, or unrestricted profile scraping.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const missing: string[] = [];

function cleanText(value: unknown, max = 4000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function isoDaysAgo(days: number) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().replace(/\.000Z$/, "Z");
}

async function verifyUser(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader) return null;
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  return error || !data?.user ? null : data.user;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function integration(provider: string, accountName: string, externalAccountId: string, metadata: Record<string, unknown> = {}) {
  const { data, error } = await supabaseAdmin.from("source_integrations").upsert({
    provider,
    account_name: accountName,
    external_account_id: externalAccountId,
    status: "connected",
    scopes: ["search"],
    metadata: { ...metadata, educational_only: true },
    updated_at: new Date().toISOString(),
  }, { onConflict: "provider,external_account_id" }).select("id").single();
  if (error) throw error;
  return data.id;
}

async function storeItem(args: {
  integrationId: string;
  provider: string;
  externalItemId: string;
  sourceUrl: string | null;
  title: string;
  description: string;
  media?: unknown[];
  rawData?: unknown;
  publishedAt?: string | null;
}) {
  const publishedAt = args.publishedAt || new Date().toISOString();
  const raw = JSON.stringify(args.rawData ?? {}) + "|" + args.externalItemId + "|" + args.description;
  const contentHash = await sha256(raw);
  const { error } = await supabaseAdmin.from("source_items").upsert({
    integration_id: args.integrationId,
    provider: args.provider,
    external_item_id: args.externalItemId,
    source_url: args.sourceUrl,
    title: cleanText(args.title, 500),
    description: cleanText(args.description, 4000),
    media: args.media ?? [],
    raw_data: args.rawData ?? null,
    content_hash: contentHash,
    published_at: publishedAt,
    last_seen_at: new Date().toISOString(),
    is_active: true,
  }, { onConflict: "provider,external_item_id" });
  if (error) throw error;
}

const EDUCATIONAL_QUERIES = [
  "\"مطلوب محفظ قرآن\" OR \"أبحث عن محفظ قرآن\" OR \"تحفيظ قرآن\"",
  "\"مطلوب معلم تجويد\" OR \"أبحث عن معلم قرآن\" OR \"إجازة قرآن\"",
  "\"مطلوب مدرس لغة عربية\" OR \"أبحث عن معلم لغة عربية\" OR \"العربية لغير الناطقين بها\"",
  "\"تحفيظ قرآن للأطفال\" OR \"تعليم أطفال\" OR \"حلقة قرآن\"",
  "\"معلم قرآن متاح\" OR \"محفظ متاح\" OR \"مدرس عربي متاح\"",
];

function buildQuery(input: unknown) {
  const requested = cleanText(input, 900);
  const base = requested || EDUCATIONAL_QUERIES[0];
  // Keep the collector educationally scoped even when a client sends a broad query.
  return `${base} (قرآن OR تحفيظ OR تجويد OR إجازة OR "لغة عربية" OR "تعليم أطفال")`;
}

async function syncX(query: string, days: number, maxResults: number) {
  const token = Deno.env.get("X_BEARER_TOKEN");
  if (!token) { missing.push("X_BEARER_TOKEN"); return 0; }
  const safeDays = Math.min(Math.max(days, 1), 7);
  const url = new URL("https://api.x.com/2/tweets/search/recent");
  url.searchParams.set("query", query);
  url.searchParams.set("max_results", String(Math.min(Math.max(maxResults, 10), 100)));
  url.searchParams.set("start_time", isoDaysAgo(safeDays));
  url.searchParams.set("tweet.fields", "created_at,author_id,lang,public_metrics,entities,attachments");
  url.searchParams.set("expansions", "author_id,attachments.media_keys");
  url.searchParams.set("user.fields", "username,name");
  url.searchParams.set("media.fields", "url,preview_image_url,type,alt_text");
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await resp.json();
  if (!resp.ok) throw new Error(`X API ${resp.status}: ${cleanText(body?.detail || JSON.stringify(body), 600)}`);
  const users = new Map<string, any>((body?.includes?.users || []).map((u: any) => [String(u.id), u]));
  const media = new Map<string, any>((body?.includes?.media || []).map((m: any) => [String(m.media_key), m]));
  const integrationId = await integration("x", "X Search", "recent-search", { window_days: safeDays });
  let count = 0;
  for (const post of body?.data || []) {
    const user = users.get(String(post.author_id));
    const username = user?.username;
    const sourceUrl = username ? `https://x.com/${username}/status/${post.id}` : `https://x.com/i/web/status/${post.id}`;
    const postMedia = (post?.attachments?.media_keys || []).map((k: string) => media.get(String(k))).filter(Boolean);
    await storeItem({ integrationId, provider: "x", externalItemId: String(post.id), sourceUrl, title: username ? `@${username}` : "X", description: cleanText(post.text), media: postMedia, rawData: { ...post, username, author: user || null }, publishedAt: post.created_at });
    count++;
  }
  return count;
}

async function syncYouTube(query: string, days: number, maxResults: number) {
  const key = Deno.env.get("YOUTUBE_API_KEY");
  if (!key) { missing.push("YOUTUBE_API_KEY"); return 0; }
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", String(Math.min(Math.max(maxResults, 1), 50)));
  url.searchParams.set("publishedAfter", isoDaysAgo(Math.max(days, 1)));
  url.searchParams.set("relevanceLanguage", "ar");
  url.searchParams.set("order", "date");
  url.searchParams.set("safeSearch", "moderate");
  url.searchParams.set("key", key);
  const resp = await fetch(url);
  const body = await resp.json();
  if (!resp.ok) throw new Error(`YouTube API ${resp.status}: ${cleanText(body?.error?.message || JSON.stringify(body), 600)}`);
  const integrationId = await integration("youtube", "YouTube Search", "search", { window_days: days });
  let count = 0;
  for (const item of body?.items || []) {
    const videoId = item?.id?.videoId;
    if (!videoId) continue;
    const sn = item?.snippet || {};
    await storeItem({ integrationId, provider: "youtube", externalItemId: String(videoId), sourceUrl: `https://www.youtube.com/watch?v=${videoId}`, title: cleanText(sn.channelTitle || "YouTube"), description: cleanText(`${sn.title || ""} — ${sn.description || ""}`), media: sn.thumbnails ? [{ type: "thumbnail", ...sn.thumbnails }] : [], rawData: { ...sn, channelId: sn.channelId, videoId }, publishedAt: sn.publishedAt });
    count++;
  }
  return count;
}

async function redditToken(clientId: string, clientSecret: string, userAgent: string) {
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const basic = btoa(`${clientId}:${clientSecret}`);
  const resp = await fetch("https://www.reddit.com/api/v1/access_token", { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent }, body });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`Reddit token ${resp.status}: ${cleanText(json?.message || JSON.stringify(json), 600)}`);
  return json.access_token as string;
}

async function syncReddit(query: string, days: number, maxResults: number) {
  const clientId = Deno.env.get("REDDIT_CLIENT_ID");
  const clientSecret = Deno.env.get("REDDIT_CLIENT_SECRET");
  const userAgent = Deno.env.get("REDDIT_USER_AGENT") || "Wefaq/1.0 external-radar";
  if (!clientId || !clientSecret) { if (!clientId) missing.push("REDDIT_CLIENT_ID"); if (!clientSecret) missing.push("REDDIT_CLIENT_SECRET"); return 0; }
  const token = await redditToken(clientId, clientSecret, userAgent);
  const url = new URL("https://oauth.reddit.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("sort", "new");
  url.searchParams.set("t", "week");
  url.searchParams.set("limit", String(Math.min(Math.max(maxResults, 1), 100)));
  url.searchParams.set("raw_json", "1");
  const resp = await fetch(url, { headers: { Authorization: `bearer ${token}`, "User-Agent": userAgent } });
  const body = await resp.json();
  if (!resp.ok) throw new Error(`Reddit API ${resp.status}: ${cleanText(body?.message || JSON.stringify(body), 600)}`);
  const integrationId = await integration("reddit", "Reddit Search", "search", { window_days: days });
  let count = 0;
  for (const child of body?.data?.children || []) {
    const d = child?.data;
    if (!d?.id) continue;
    await storeItem({ integrationId, provider: "reddit", externalItemId: String(d.id), sourceUrl: d.permalink ? `https://www.reddit.com${d.permalink}` : `https://www.reddit.com/comments/${d.id}/`, title: cleanText(d.subreddit_name_prefixed || "Reddit"), description: cleanText(`${d.title || ""} — ${d.selftext || ""}`), rawData: { id: d.id, subreddit: d.subreddit, permalink: d.permalink }, publishedAt: d.created_utc ? new Date(Number(d.created_utc) * 1000).toISOString() : null });
    count++;
  }
  return count;
}

async function syncBrave(query: string, days: number, maxResults: number) {
  const token = Deno.env.get("BRAVE_SEARCH_API_KEY");
  if (!token) { missing.push("BRAVE_SEARCH_API_KEY"); return [] as any[]; }
  const target = Math.min(Math.max(maxResults, 1), 50);
  const freshness = days <= 1 ? "pd" : days <= 7 ? "pw" : "pm";
  const results: any[] = [];
  for (let page = 0; page < Math.min(3, Math.ceil(target / 20)); page++) {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query.slice(0, 600));
    url.searchParams.set("count", "20");
    url.searchParams.set("offset", String(page));
    url.searchParams.set("country", "SA");
    url.searchParams.set("search_lang", "ar");
    url.searchParams.set("ui_lang", "ar-SA");
    url.searchParams.set("safesearch", "moderate");
    url.searchParams.set("freshness", freshness);
    const resp = await fetch(url, { headers: { Accept: "application/json", "X-Subscription-Token": token } });
    const body = await resp.json();
    if (!resp.ok) throw new Error(`Brave Search API ${resp.status}: ${cleanText(body?.error?.detail || JSON.stringify(body), 600)}`);
    for (const item of body?.web?.results || []) {
      if (!item?.url) continue;
      results.push({ provider: "web_search", source_url: item.url, title: cleanText(item.title || "Web result", 500), description: cleanText(item.description || "", 4000), published_at: item.page_age && new Date(item.page_age).toString() !== "Invalid Date" ? new Date(item.page_age).toISOString() : null, raw: { provider: "brave", page_age: item.page_age || null, page_fetched: item.page_fetched || null, profile: item.profile || null } });
      if (results.length >= target) break;
    }
    if (results.length >= target || body?.query?.more_results_available === false) break;
  }
  return results;
}

async function syncGoogle(query: string, days: number, maxResults: number) {
  const key = Deno.env.get("GOOGLE_CSE_API_KEY");
  const cx = Deno.env.get("GOOGLE_CSE_ID") || Deno.env.get("GOOGLE_CSE_CX");
  if (!key || !cx) { missing.push("GOOGLE_CSE_API_KEY/GOOGLE_CSE_ID"); return 0; }
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", key); url.searchParams.set("cx", cx); url.searchParams.set("q", query); url.searchParams.set("num", String(Math.min(Math.max(maxResults, 1), 10))); url.searchParams.set("dateRestrict", `d${Math.min(Math.max(days, 1), 30)}`); url.searchParams.set("safe", "active");
  const resp = await fetch(url); const body = await resp.json();
  if (!resp.ok) throw new Error(`Google CSE ${resp.status}: ${cleanText(body?.error?.message || JSON.stringify(body), 600)}`);
  const integrationId = await integration("web_search", "Google Programmable Search", "google-cse", { window_days: days, fallback: true });
  let count = 0;
  for (const item of body?.items || []) {
    await storeItem({ integrationId, provider: "web_search", externalItemId: String(item.link), sourceUrl: item.link || null, title: cleanText(item.title || "Web result"), description: cleanText(item.snippet || ""), media: item.image?.thumbnailLink ? [{ type: "thumbnail", url: item.image.thumbnailLink }] : [], rawData: { provider: "google-cse", displayLink: item.displayLink }, publishedAt: new Date().toISOString() });
    count++;
  }
  return count;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ ok: true, service: "wefaq-social-radar-sync", role: "collector" }), { headers: { ...corsHeaders, "content-type": "application/json" } });

  try {
    missing.length = 0;
    const user = await verifyUser(req);
    if (!user) return new Response(JSON.stringify({ ok: false, error: "auth_required" }), { status: 401, headers: { ...corsHeaders, "content-type": "application/json" } });

    const payload = await req.json().catch(() => ({}));
    const query = buildQuery(payload?.query);
    const provider = String(payload?.provider || "all");
    const days = Math.min(Math.max(Number(payload?.days || 7), 1), 30);
    const maxResults = Math.min(Math.max(Number(payload?.max_results || 50), 1), 100);
    const synced: Record<string, number> = {};
    const errors: Record<string, string> = {};

    const run = async (name: string, fn: () => Promise<number>) => {
      try { synced[name] = await fn(); } catch (error) { errors[name] = cleanText(error instanceof Error ? error.message : String(error), 900); }
    };

    if (provider === "all" || provider === "x") await run("x", () => syncX(query, days, maxResults));
    if (provider === "all" || provider === "youtube") await run("youtube", () => syncYouTube(query, days, maxResults));
    if (provider === "all" || provider === "reddit") await run("reddit", () => syncReddit(query, days, maxResults));

    let transientWeb: any[] = [];
    if (provider === "all" || provider === "web_search") {
      if (Deno.env.get("BRAVE_SEARCH_API_KEY")) {
        try { transientWeb = await syncBrave(query, days, maxResults); synced.web_search = transientWeb.length; } catch (error) { errors.web_search = cleanText(error instanceof Error ? error.message : String(error), 900); }
      } else {
        await run("google_cse", () => syncGoogle(query, days, maxResults));
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      query,
      synced,
      errors,
      missing_credentials: [...new Set(missing)],
      transient_web_results: transientWeb,
      transient_web_results_persisted: false,
      telegram: "webhook_only",
      requested_by: user.id,
    }), { headers: { ...corsHeaders, "content-type": "application/json" } });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: "external_sync_failed", message: cleanText(error instanceof Error ? error.message : String(error), 900), missing_credentials: [...new Set(missing)] }), { status: 500, headers: { ...corsHeaders, "content-type": "application/json" } });
  }
});
