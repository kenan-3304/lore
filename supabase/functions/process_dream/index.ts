// deno-lint-ignore-file
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://esm.sh/openai@4.26.0";

const env = Deno.env.toObject();

/**
 * this is the supabase client for the project
 */
const supabase = createClient(
  env.EXPO_PUBLIC_SUPABASE_URL!,
  env.EXPO_PUBLIC_SUPABASE_ANON_KEY!
);
const admin = createClient(
  env.EXPO_PUBLIC_SUPABASE_URL!,
  env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY! });

/**
 * Configurations for storyboard generation.
 */
const MAX_PANELS = 6;
const MIN_PANELS = 4;

type Panel = { description: string; speech: string };
interface Storyboard {
  title: string;
  style: string;
  panels: Panel[];
}

/**
 * Dont fuck with this.
 */
const asciiBase = (s: string) =>
  s
    .replace(/[•▪‣⁃∙]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, "...")
    .replace(/[×✕✖✗✘]/g, "x")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/[\x00-\x1F]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const asciiText = asciiBase;
const asciiStyle = (s: string) => asciiBase(s).replace(/^[-\s]+/, "");
const escapeQuotes = (s: string) => s.replace(/"/g, "'");

/**
 * GPT prompt for storyboard generation this is what we have to configure perfectly
 *
 * RULES:
 * Cant not return double quotes eg: "He shouted "Run!""
 * try to keep concise
 * ONLY USE ASCII SAFE CHARACTERS
 * have to keep nuetral themes cant do sex or gore
 *
 * Reccomend to add:
 * give it examples of good styles to use
 * other shit
 *
 * @param dream - The dream transcript.
 * @returns - The prompt for the storyboard.
 */
const storyboardPrompt = (dream: string) => [
  {
    role: "system",
    content: `You are an award-winning comic storyboard artist and art-director.
Return strict JSON (no markdown) with keys:
- "style"  (concise ASCII art-style line)
- "title"  (short)
- "panels" (array length ${MIN_PANELS}-${MAX_PANELS})
Each panel:
- "description" 20-27 words, 3rd-person, mention props & camera angle
- "speech" (short bubble or empty)`,
  },
  {
    role: "user",
    content: `Dream transcript:\n"""\n${dream.trim()}\n"""\nNow output the JSON storyboard.`,
  },
];

/**
 * Build composite prompt for DALL-E.
 * Basically just fixes the prompt for DALL-E since chatgpt is dumb and cant return a json object
 * @param sb - The storyboard.
 * @returns - The prompt for the DALL-E.
 */
const buildCompositePrompt = (sb: Storyboard) => {
  sb.panels.forEach((p) => {
    p.description = escapeQuotes(asciiText(p.description));
    p.speech = escapeQuotes(asciiText(p.speech));
    if (!/[.!?]$/.test(p.description)) p.description += ".";
  });

  // Build the panel list
  const panelList = sb.panels
    .map((p, i) => {
      const speech = p.speech ? ` Speech bubble: '${p.speech}'.` : "";
      return `${i + 1}) ${p.description}${speech}`;
    })
    .join(" ");

  // Build the grid clause, dalle doesnt really listen to it though so fix
  const gridClause =
    sb.panels.length >= 5
      ? "6 equal panels arranged 2 x 3 on a cream comic page, black gutters"
      : "4 equal panels arranged 2 x 2 on a cream comic page, black gutters";

  // Build the full prompt
  let full = `${asciiStyle(
    sb.style
  )}. ${gridClause}. Illustrate the panels in order: ${panelList}. No panel numbers, captions or sound-effects. Full view, no cropping.`
    .replace(/\s+/g, " ")
    .trim();

  // If its too long cut it off and let chat handle it
  if (full.length > 2990) full = full.slice(0, 2890) + "...";
  return full;
};

/**
 * Shared header helper
 * @returns - The headers for the request.
 */
const buildHeaders = (): Record<string, string> => {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${env.OPENAI_API_KEY}`,
  };
  if (env.OPENAI_PROJECT_ID) h["OpenAI-Project"] = env.OPENAI_PROJECT_ID;
  return h;
};

/**
 * Main Edge Function the main workfkiw
 * @param req - The request.
 * @returns - The response.
 */
serve(async (req) => {
  try {
    /**
     * 0. Health-check add ?test=1 to url to test - returns simple image JSON
     */
    const url = new URL(req.url);
    if (url.searchParams.get("test") === "1") {
      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({
          model: "dall-e-3",
          prompt: "A cat wearing sunglasses.",
          n: 1,
          size: "1024x1024",
        }),
      });
      return new Response(await res.text(), { status: res.status });
    }

    /**
     * 1. Parse form data
     */
    const form = await req.formData();
    const file = form.get("audio") as File;
    const userId = form.get("user_id") as string | null;
    if (!file) throw new Error("audio file missing");

    /**
     * 2. Whisper transcription
     */
    const transcript = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file,
      response_format: "text",
    });

    /**
     * 3. GPT-4o -> storyboard
     */
    const sb: Storyboard = await openai.chat.completions
      .create({
        model: "gpt-4o",
        messages: storyboardPrompt(transcript),
        response_format: { type: "json_object" },
      })
      .then((r) => JSON.parse(r.choices[0].message.content!));

    if (sb.panels.length > MAX_PANELS) sb.panels.splice(MAX_PANELS);

    /**
     * 4. Build prompt
     */
    const prompt = buildCompositePrompt(sb);
    console.log("Prompt len:", prompt.length, "prompt:", prompt);

    /**
     * 5. DALL·E call with 1-retry on user_error
     */
    const genBody = JSON.stringify({
      model: "dall-e-3",
      prompt,
      n: 1,
      // TODO: make this dynamic if we can figure out how to do 1024x1536 then we straight
      size: "1024x1024",
    });

    const imageReq = () =>
      fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: buildHeaders(),
        body: genBody,
      });

    // Error handling for DALL-E
    let imageRes = await imageReq();
    let txt: string | undefined;
    if (!imageRes.ok) {
      txt = await imageRes.text();
      if (txt.includes("image_generation_user_error")) {
        await new Promise((r) => setTimeout(r, 1200));
        imageRes = await imageReq();
        if (!imageRes.ok) txt = await imageRes.text();
      }
      if (!imageRes.ok) {
        console.error("Image API:", txt);
        return new Response(txt, { status: 500 });
      }
    }

    const imageURL = (await imageRes.json()).data[0].url as string;

    /**
     * 6. Upload to Supabase Storage
     */
    const buf = new Uint8Array(await (await fetch(imageURL)).arrayBuffer());
    const path = `${userId || "anon"}/${crypto.randomUUID()}.png`;
    const { error } = await admin.storage
      .from("comics")
      .upload(path, buf, { upsert: true, contentType: "image/png" });
    if (error) throw new Error(`upload: ${error.message}`);
    const { data: pub } = admin.storage.from("comics").getPublicUrl(path);

    /**
     * 7. Insert DB record
     */
    await admin.from("dreams").insert({
      user_id: userId,
      transcript,
      panel_count: sb.panels.length,
      storyboard: sb,
      composite_url: pub.publicUrl,
      // TODO: make this dynamic
      cost_cents: 5,
    });

    return new Response(pub.publicUrl, { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response(String(err), { status: 500 });
  }
});
