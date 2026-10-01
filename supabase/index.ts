// Wefaq — smart-processor v15
// Reads persisted source_items, classifies educational signals, deduplicates across sources,
// extracts safe public contact hints, and upserts production radar_leads.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function cleanText(value: unknown, max = 5000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}
function normalize(value: unknown) {
  return cleanText(value, 5000)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[\u200f\u200e]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hasAny(text: string, words: string[]) { return words.some((w) => text.includes(normalize(w))); }
function countAny(text: string, words: string[]) { return words.reduce((n, w) => n + (text.includes(normalize(w)) ? 1 : 0), 0); }

const demandWords = ["مطلوب", "ابحث عن", "أبحث عن", "اريد", "أريد", "احتاج", "أحتاج", "بحاجة", "من يبحث", "طالب", "تبحث عن", "نبحث عن"];
const supplyWords = ["متاح", "متاحة", "أقدم", "أقدم خدمات", "معلم", "معلمة", "محفظ", "محفظة", "مدرس", "مدرسة", "أدرس", "ادرس", "تعليم", "استطيع التدريس"];
const serviceWords = ["خدمة تعليمية", "مركز", "حلقة", "برنامج", "دورة", "جلسات", "دروس", "منصة تعليمية"];
const quranWords = ["قرآن", "تحفيظ", "تجويد", "تلاوة", "إجازة", "قراءات", "حفص", "ورش", "رواية", "سند"];
const hadithWords = ["حديث", "السنة", "مصطلح الحديث", "شرح الحديث"];
const arabicWords = ["لغة عربية", "النحو", "الصرف", "البلاغة", "الإملاء", "العربية لغير الناطقين", "عربي"];
const kidsWords = ["أطفال", "طفل", "ابني", "ابنتي", "الناشئة", "صغار"];
const languageWords = ["لغة إنجليزية", "الانجليزية", "فرنسية", "تركية", "أردو", "تعلم اللغات", "language"];
const legacyWords = ["تمويل", "استثمار", "مناقصة", "مزاد", "شريك مؤسس", "دراسة جدوى", "مشروع"];

function classify(textInput: string, rawData: any, publishedAt: string | null) {
  const text = normalize(textInput);
  const educationalHits = countAny(text, [...quranWords, ...hadithWords, ...arabicWords, ...kidsWords, ...languageWords, ...serviceWords]);
  if (educationalHits === 0) return null;
  const legacyHits = countAny(text, legacyWords);
  if (legacyHits >= 2 && educationalHits < 2) return null;

  const isDemand = hasAny(text, demandWords);
  const isSupply = hasAny(text, supplyWords);
  const isService = hasAny(text, serviceWords);

  let persona: "student" | "teacher" | "service" = "student";
  if (isDemand) persona = isService && !isSupply ? "service" : "student";
  else if (isSupply) persona = "teacher";
  else if (isService) persona = "service";

  let intentType = "signal";
  if (isDemand) intentType = "demand";
  else if (isSupply) intentType = "supply";

  let category = "services";
  if (hasAny(text, quranWords)) category = "quran";
  else if (hasAny(text, hadithWords)) category = "hadith";
  else if (hasAny(text, arabicWords)) category = "arabic";
  else if (hasAny(text, kidsWords)) category = "kids";
  else if (hasAny(text, languageWords)) category = "languages";

  let mode = "";
  if (hasAny(text, ["هجين", "hybrid"])) mode = "hybrid";
  else if (hasAny(text, ["حضوري", "في المركز", "في المسجد", "in person"])) mode = "in_person";
  else if (hasAny(text, ["اونلاين", "أونلاين", "عن بعد", "عن بُعد", "online", "remote"])) mode = "online";

  const regionHits: Array<[string,string,string]> = [
    ["KSA", "SA", "السعودية"], ["KSA", "SA", "الرياض"], ["KSA", "SA", "جدة"], ["KSA", "SA", "المدينة"], ["KSA", "SA", "مكة"], ["KSA", "SA", "الدمام"],
    ["EGP", "EG", "مصر"], ["EGP", "EG", "القاهرة"], ["EGP", "EG", "الإسكندرية"],
    ["UAE", "AE", "الإمارات"], ["UAE", "AE", "دبي"], ["UAE", "AE", "أبو ظبي"],
    ["QAT", "QA", "قطر"], ["KW", "KW", "الكويت"], ["GCC", "GCC", "الخليج"], ["MAGHREB", "MAGHREB", "المغرب"], ["MAGHREB", "MAGHREB", "الجزائر"], ["MAGHREB", "MAGHREB", "تونس"],
    ["LEVANT", "LEVANT", "الأردن"], ["LEVANT", "LEVANT", "لبنان"], ["LEVANT", "LEVANT", "سوريا"], ["PALESTINE", "PS", "فلسطين"], ["GAZA", "PS", "غزة"],
    ["AFRICA", "AFRICA", "أفريقيا"], ["AFRICA", "AFRICA", "كينيا"], ["AFRICA", "AFRICA", "نيجيريا"], ["AFRICA", "AFRICA", "جنوب أفريقيا"],
    ["FOREIGN", "FOREIGN", "ألمانيا"], ["FOREIGN", "FOREIGN", "فرنسا"], ["FOREIGN", "FOREIGN", "بريطانيا"], ["FOREIGN", "FOREIGN", "كندا"], ["FOREIGN", "FOREIGN", "أمريكا"], ["FOREIGN", "FOREIGN", "الولايات المتحدة"],
  ];
  let region = "GLOBAL", countryCode = "", city = "";
  for (const [r, c, needle] of regionHits) {
    if (text.includes(normalize(needle))) { region = r; countryCode = c; if (["الرياض","جدة","المدينة","مكة","الدمام","القاهرة","الإسكندرية","دبي","أبو ظبي","غزة"].includes(needle)) city = needle; break; }
  }

  const languages: string[] = [];
  const addLang = (needle: string, label: string) => { if (hasAny(text, [needle])) languages.push(label); };
  addLang("عربي", "Arabic"); addLang("الإنجليزية", "English"); addLang("انجليزية", "English"); addLang("فرنسية", "French"); addLang("أردو", "Urdu"); addLang("تركية", "Turkish");
  if (rawData?.lang && typeof rawData.lang === "string") {
    const code = rawData.lang.toLowerCase();
    if (code === "ar") languages.push("Arabic"); else if (code === "en") languages.push("English"); else if (code === "fr") languages.push("French");
  }
  const uniqueLanguages = [...new Set(languages)];
  const language = uniqueLanguages[0] || "";

  const tags: string[] = [];
  const tagMap: Array<[string,string[]]> = [
    ["تحفيظ", ["تحفيظ", "حفظ"]], ["تجويد", ["تجويد"]], ["قراءات", ["قراءات", "حفص", "ورش"]], ["إجازة", ["إجازة", "سند"]],
    ["حديث", hadithWords], ["نحو", ["النحو"]], ["صرف", ["الصرف"]], ["بلاغة", ["البلاغة"]], ["أطفال", kidsWords],
    ["أونلاين", ["اونلاين", "أونلاين", "عن بعد", "online"]], ["حضوري", ["حضوري", "in person"]]
  ];
  for (const [label, needles] of tagMap) if (hasAny(text, needles)) tags.push(label);
  if (region !== "GLOBAL") tags.push(region);
  tags.push(intentType === "demand" ? "طلب" : intentType === "supply" ? "عرض" : "إشارة");
  tags.push(category);

  const emailMatches = cleanText(textInput).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  const waLinks = cleanText(textInput).match(/https?:\/\/(?:wa\.me|api\.whatsapp\.com)\/[^\s)]+/gi) || [];
  const tgLinks = cleanText(textInput).match(/https?:\/\/t\.me\/[^\s)]+/gi) || [];
  const phoneMatches = cleanText(textInput).match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || [];
  const contact: Record<string, unknown> = {};
  if (emailMatches[0]) contact.email = emailMatches[0];
  if (waLinks[0]) contact.whatsapp_url = waLinks[0];
  if (tgLinks[0]) contact.telegram_url = tgLinks[0];
  if (phoneMatches[0] && (phoneMatches[0].includes("+") || /[ -]/.test(phoneMatches[0]))) contact.phone = phoneMatches[0].trim();
  const hasPublicContact = Object.keys(contact).length > 0;

  const ageHours = publishedAt ? Math.max(0, (Date.now() - new Date(publishedAt).getTime()) / 3600000) : 0;
  const freshnessScore = ageHours <= 24 ? 10 : ageHours <= 72 ? 6 : ageHours <= 168 ? 3 : 0;
  const relevance = Math.min(40, educationalHits * 8);
  const demandScore = isDemand ? 18 : isSupply ? 12 : 4;
  const specificScore = (mode ? 6 : 0) + (region !== "GLOBAL" ? 6 : 0) + (uniqueLanguages.length ? 4 : 0) + (hasPublicContact ? 5 : 0);
  const score = Math.min(99, relevance + demandScore + specificScore + freshnessScore);
  const triageConfidence = Math.min(99, 50 + Math.min(35, educationalHits * 6) + (isDemand || isSupply ? 10 : 4));
  const priority = score >= 82 ? "hot" : score >= 65 ? "warm" : "normal";
  const dedupeText = normalize(`${cleanText(textInput.slice(0, 1200))}|${category}|${intentType}|${region}`);

  return {
    persona, intentType, category, mode, region, countryCode, city, language, languages: uniqueLanguages,
    tags: [...new Set(tags)].slice(0, 12), contact, consentStatus: hasPublicContact ? "public_contact" : "unknown",
    consentBasis: hasPublicContact ? "contact_published_in_source_text" : null,
    score, triageConfidence, priority, dedupeText,
  };
}

async function dedupeHash(value: string) { return sha256(value); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ ok: true, service: "wefaq-smart-processor", role: "classifier" }), { headers: { ...corsHeaders, "content-type": "application/json" } });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const accessToken = authHeader.replace(/^Bearer\s+/i, "");
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(accessToken);
    if (userError || !userData?.user) return new Response(JSON.stringify({ ok: false, error: "auth_required" }), { status: 401, headers: { ...corsHeaders, "content-type": "application/json" } });

    const payload = await req.json().catch(() => ({}));
    const hours = Math.min(Math.max(Number(payload?.hours || 336), 1), 720);
    const limit = Math.min(Math.max(Number(payload?.limit || 500), 1), 1000);
    const since = new Date(Date.now() - hours * 3600000).toISOString();

    const { data: items, error: itemsError } = await supabaseAdmin
      .from("source_items")
      .select("id,provider,external_item_id,source_url,title,description,raw_data,published_at,last_seen_at,is_active")
      .eq("is_active", true)
      .gte("last_seen_at", since)
      .order("last_seen_at", { ascending: false })
      .limit(limit);
    if (itemsError) throw itemsError;

    let found = 0, newCount = 0, updatedCount = 0, dedupedCount = 0, skipped = 0;
    const errors: string[] = [];

    for (const item of items || []) {
      found++;
      try {
        const combined = cleanText(`${item.title || ""} ${item.description || ""}`);
        const cls = classify(combined, item.raw_data, item.published_at);
        if (!cls) { skipped++; continue; }
        const dedupeKey = await dedupeHash(cls.dedupeText);
        const contentHash = await dedupeHash(normalize(combined));
        const sourceType = String(item.provider || "web");
        const externalId = String(item.external_item_id || item.id);

        const { data: existingBySource, error: existingSourceError } = await supabaseAdmin
          .from("radar_leads")
          .select("id,discovered_at,dedupe_key,raw_meta")
          .eq("source_type", sourceType)
          .eq("external_id", externalId)
          .maybeSingle();
        if (existingSourceError) throw existingSourceError;

        if (!existingBySource) {
          const { data: duplicate } = await supabaseAdmin
            .from("radar_leads")
            .select("id,source_type,external_id,raw_meta,last_seen_at")
            .eq("dedupe_key", dedupeKey)
            .neq("status", "rejected")
            .maybeSingle();

          if (duplicate) {
            const rawMeta = (duplicate.raw_meta && typeof duplicate.raw_meta === "object") ? duplicate.raw_meta as Record<string, unknown> : {};
            const duplicateSources = Array.isArray(rawMeta.duplicate_sources) ? rawMeta.duplicate_sources as unknown[] : [];
            duplicateSources.push({ source_type: sourceType, external_id: externalId, source_url: item.source_url || null, seen_at: new Date().toISOString() });
            await supabaseAdmin.from("radar_leads").update({ last_seen_at: new Date().toISOString(), raw_meta: { ...rawMeta, duplicate_sources: duplicateSources.slice(-12) }, tags: [...new Set([...(Array.isArray(rawMeta.tags) ? rawMeta.tags as string[] : []), ...cls.tags])] }).eq("id", duplicate.id);
            dedupedCount++;
            continue;
          }
        }

        const row: Record<string, unknown> = {
          source_type: sourceType,
          external_id: externalId,
          title: cleanText(item.title || sourceType, 500),
          snippet: cleanText(item.description || "", 4000),
          persona: cls.persona,
          category: cls.category,
          priority: cls.priority,
          source: sourceType,
          source_url: item.source_url || null,
          published_at: item.published_at || null,
          last_seen_at: new Date().toISOString(),
          score: cls.score,
          triage_confidence: cls.triageConfidence,
          consent_status: cls.consentStatus,
          consent_basis: cls.consentBasis,
          contact: cls.contact,
          tags: cls.tags,
          content_hash: contentHash,
          dedupe_key: dedupeKey,
          raw_meta: { processor: "wefaq-smart-processor-v15", source_item_id: item.id, educational_only: true, classified_at: new Date().toISOString(), intent_type: cls.intentType, languages: cls.languages },
          region: cls.region,
          country_code: cls.countryCode,
          city: cls.city,
          language: cls.language,
          languages: cls.languages,
          mode: cls.mode,
          intent_type: cls.intentType,
        };
        if (!existingBySource) row.status = "new";

        const { error: upsertError } = await supabaseAdmin.from("radar_leads").upsert(row, { onConflict: "source_type,external_id" });
        if (upsertError) throw upsertError;
        if (existingBySource) updatedCount++; else newCount++;
      } catch (error) {
        errors.push(cleanText(error instanceof Error ? error.message : String(error), 600));
      }
    }

    // Mark leads stale after 30 days without being seen. Never delete them automatically.
    await supabaseAdmin.from("radar_leads").update({ status: "stale" }).in("status", ["new", "review", "saved"]).lt("last_seen_at", new Date(Date.now() - 30 * 24 * 3600000).toISOString());

    return new Response(JSON.stringify({ ok: true, found, new_count: newCount, updated_count: updatedCount, deduped_count: dedupedCount, skipped, error_count: errors.length, errors: errors.slice(0, 20), processed_by: userData.user.id }), { headers: { ...corsHeaders, "content-type": "application/json" } });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: "processing_failed", message: cleanText(error instanceof Error ? error.message : String(error), 900) }), { status: 500, headers: { ...corsHeaders, "content-type": "application/json" } });
  }
});
