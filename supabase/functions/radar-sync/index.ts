// Wefaq Acquisition Radar v11 — Edge Function skeleton
// Secrets stay server-side. Implement/connect only approved sources.
// Supported adapters in this starter:
//   - Google Custom Search JSON API (public web queries)
//   - Generic RSS/Atom feeds
//   - YouTube Data API search
// Telegram should normally feed this system through an authorized bot/webhook,
// not unrestricted history scraping.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(supabaseUrl, serviceKey);

const GOOGLE_API_KEY = Deno.env.get("GOOGLE_CSE_API_KEY") || "";
const GOOGLE_CX = Deno.env.get("GOOGLE_CSE_CX") || "";
const YOUTUBE_API_KEY = Deno.env.get("YOUTUBE_API_KEY") || "";

const QUERIES = [
  "مطلوب محفظ قرآن",
  "مطلوب معلم تجويد",
  "أبحث عن معلم قرآن",
  "تحفيظ قرآن للأطفال أونلاين",
  "مطلوب مدرس لغة عربية",
  "أبحث عن مدرسة لغة عربية",
  "دروس قرآن عن بعد",
  "حفظ القرآن للأطفال"
];

function sha256(input:string){
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)).then(buf=>
    [...new Uint8Array(buf)].map(x=>x.toString(16).padStart(2,"0")).join("")
  );
}

function classify(text:string){
  const t=text.toLowerCase();
  const studentWords=["أبحث عن","اريد","أريد","مطلوب","ابني","ابنتي","طفلي","طفل","طالب"];
  const teacherWords=["معلم","معلمة","محفظ","محفظة","قارئ","مدرس","مدرسة","أقدم"];
  const serviceWords=["خدمة","مركز","برنامج","حلقة","توريد","مطلوب فريق"];
  const persona=teacherWords.some(w=>t.includes(w)) ? "teacher" : serviceWords.some(w=>t.includes(w)) ? "service" : studentWords.some(w=>t.includes(w)) ? "student" : "student";
  const category=t.includes("قرآن")||t.includes("تجويد")||t.includes("تحفيظ")||t.includes("محفظ") ? "quran" : "arabic";
  return {persona,category};
}

async function googleSearch(q:string){
  if(!GOOGLE_API_KEY || !GOOGLE_CX) return [];
  const url=`https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(GOOGLE_API_KEY)}&cx=${encodeURIComponent(GOOGLE_CX)}&q=${encodeURIComponent(q)}&num=10`;
  const r=await fetch(url); if(!r.ok) throw new Error(`Google CSE ${r.status}`);
  const j=await r.json();
  return (j.items||[]).map((x:any)=>({external_id:x.cacheId||x.link,title:x.title||"",snippet:x.snippet||"",source_url:x.link,source:"Google Custom Search",source_type:"web"}));
}

async function youtubeSearch(q:string){
  if(!YOUTUBE_API_KEY) return [];
  const url=`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=10&q=${encodeURIComponent(q)}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
  const r=await fetch(url); if(!r.ok) throw new Error(`YouTube ${r.status}`);
  const j=await r.json();
  return (j.items||[]).map((x:any)=>({external_id:x.id?.videoId||crypto.randomUUID(),title:x.snippet?.title||"",snippet:x.snippet?.description||"",source_url:x.id?.videoId?`https://www.youtube.com/watch?v=${x.id.videoId}`:"https://youtube.com",source:"YouTube",source_type:"youtube"}));
}

async function upsertLead(item:any){
  const text=`${item.title} ${item.snippet}`.trim();
  const cls=classify(text);
  const score=Math.min(99,50+(text.includes("مطلوب")?15:0)+(text.includes("أونلاين")?10:0)+(text.includes("قرآن")||text.includes("عربية")?10:0));
  const hash=await sha256(text.toLowerCase());
  const row={...item, persona:cls.persona, category:cls.category, priority:score>=88?"hot":score>=75?"warm":"normal", score, content_hash:hash, discovered_at:new Date().toISOString(), last_seen_at:new Date().toISOString(), raw_meta:{ingested_by:"radar-sync"}};
  const {data,error}=await db.from("radar_leads").upsert(row,{onConflict:"source_type,external_id"}).select("id,external_id").maybeSingle();
  if(error) throw error;
  return data;
}

Deno.serve(async (req)=>{
  if(req.method!=="POST") return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:{"content-type":"application/json"}});
  try{
    const body=await req.json().catch(()=>({}));
    const requested=Array.isArray(body?.requested_sources)?body.requested_sources:["web","youtube"];
    const run=await db.from("radar_sync_runs").insert({source_ids:requested,status:"running"}).select("id").single();
    const runId=run.data?.id;
    const items:any[]=[]; const notes:any={};
    if(requested.includes("web") && GOOGLE_API_KEY && GOOGLE_CX){
      for(const q of QUERIES.slice(0,6)){ try{items.push(...await googleSearch(q));}catch(e){notes[`web:${q}`]=String(e);} }
    } else notes.web="Google CSE not configured";
    if(requested.includes("youtube") && YOUTUBE_API_KEY){
      try{items.push(...await youtubeSearch(QUERIES[0]));}catch(e){notes.youtube=String(e);}
    } else notes.youtube="YouTube API not configured";
    const unique=new Map<string,any>();
    for(const x of items){const key=`${x.source_type}:${x.external_id}`; if(!unique.has(key))unique.set(key,x);}
    let saved=0;
    for(const x of unique.values()){await upsertLead(x); saved++;}
    if(runId){await db.from("radar_sync_runs").update({finished_at:new Date().toISOString(),status:"completed",found_count:items.length,new_count:saved,deduped_count:Math.max(0,items.length-saved),notes}).eq("id",runId);}
    const {data:leads}=await db.from("radar_leads").select("id,external_id,title,snippet,persona,category,priority,source,source_type,source_url,score,discovered_at").order("discovered_at",{ascending:false}).limit(40);
    return new Response(JSON.stringify({ok:true,leads:(leads||[]).map((x:any)=>({...x,hours_ago:Math.max(0,(Date.now()-new Date(x.discovered_at).getTime())/36e5)})),sources:{web:{status:GOOGLE_API_KEY&&GOOGLE_CX?"ready":"pending"},youtube:{status:YOUTUBE_API_KEY?"ready":"pending"}}}),{headers:{"content-type":"application/json"}});
  }catch(e){
    return new Response(JSON.stringify({ok:false,error:String(e)}),{status:500,headers:{"content-type":"application/json"}});
  }
});
