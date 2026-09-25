// On-device small language model (optional).
// The model's weights are downloaded once from a public host and cached by the browser.
// After that it runs on this phone's GPU (WebGPU). The only input it ever receives is the
// short list of plain-language facts built by engine.js; raw data, names and locations
// are never put in the prompt, and nothing the model produces leaves the device.
//
// The model does NOT decide anything. Risk levels come from the deterministic engine;
// the model only rewrites the facts into a warmer message, and a filter rejects any
// output that sounds like a diagnosis, in which case we fall back to a fixed template.

export const MODELS = {
  // IDs from WebLLM's prebuilt model list (src/config.ts), checked 25 Sep 2026.
  // Qwen2.5 handles French, German, Italian and English, which matters in Geneva.
  // Tested 26 Sep 2026 on the "gradual shift" demo: Qwen2.5-0.5B passed the validator 0/8
  // times (it claimed things "improved"); Qwen2.5-1.5B passed 3/8, all accurate. So 1.5B it is.
  phone:  { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 1.5B, about 880 MB (Wi-Fi recommended)" },
  // Apertus (Swiss AI) has 0.5B/1.5B instruct models under Apache-2.0, but no WebLLM/ONNX
  // build exists yet. Converting it is the Swiss-sovereign roadmap item.
};
const WEBLLM_URL = "https://esm.run/@mlc-ai/web-llm@0.2.85";

let engine = null, loading = null, loadedId = null;

export function hasWebGPU() { return typeof navigator !== "undefined" && !!navigator.gpu; }
export function isLoaded() { return !!engine; }
export function loadedModel() { return loadedId; }

export async function loadModel(which = "phone", onProgress) {
  if (!MODELS[which]) which = "phone";
  if (engine) return engine;
  if (loading) return loading;
  if (!hasWebGPU()) throw new Error("This browser has no WebGPU, so the on-device model can't run here. Lueur will use its built-in wording instead.");
  const id = MODELS[which].id;
  loading = (async () => {
    const webllm = await import(WEBLLM_URL);
    const e = await webllm.CreateMLCEngine(id, {
      initProgressCallback: p => onProgress && onProgress(p.progress ?? 0, p.text || ""),
    });
    engine = e; loadedId = id; return e;
  })();
  try { return await loading; } finally { loading = null; }
}

const SYSTEM = `You write one short, gentle note for a wellbeing app.
Rules:
- 2 or 3 sentences, 25 to 55 words, speaking to the reader as "you".
- Mention only the changes you are given, in plain words. Do not use any numbers.
- Do not greet, do not sign off, no names, no lists, no markdown.
- Never name an illness or condition, and never say what the person feels.
- End with one small, optional, kind suggestion.

Example
Changes: later bedtimes, less movement.
Note: Lately your evenings have been running later and your days have been a little less active than usual. That can happen for lots of reasons, and it isn't a verdict on you. If it feels right, a short walk in daylight tomorrow could be a gentle place to start.`;

// Guardrails. A tiny model can invent facts, so its output is checked, not trusted.
const BANNED = /\b(depress\w*|burn[- ]?out|disorder|diagnos\w*|symptom\w*|illness|anxiety|anxious|therap\w*|suicid\w*|medication|patient|clinical|dear|hey|hi)\b/i;
const FORMAT = /[\d\[\]*#_<>{}]|^\s*[-•]/m;
// Every change we report is a change for the worse, so any "improved/better/more" claim is a
// contradiction. The note must also mention at least one of the areas it was given.
const CONTRADICTS = /\b(improv\w*|better|more consistent|increas\w*|nap\w*|diet|meals?|yoga|meditat\w*)\b/i;
// Telling someone what they feel is off-limits; "if it feels right" is fine.
const TELLS_FEELINGS = /\byou(?:'re| are|'ve been| have been)?\s+(?:feel|feeling)\b/i;
const AREA_WORDS = { "shorter sleep": /sleep/i, "longer sleep": /sleep/i, "later bedtimes": /bed|evening|night|late/i, "earlier bedtimes": /bed|evening|early/i,
  "a less regular sleep rhythm": /sleep|rhythm|regular/i, "less movement": /mov|active|walk|step/i, "fewer places visited": /place|out|around/i,
  "lower mood in check-ins": /mood|check/i, "lower energy in check-ins": /energy|check/i };
// Returns null if the note is acceptable, otherwise the reason it was rejected.
export function rejectReason(text, areas = []) {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 12) return "too short";
  if (words > 70) return "too long";
  let m;
  if ((m = text.match(BANNED))) return `clinical or greeting word: ${m[0]}`;
  if ((m = text.match(FORMAT))) return `numbers or formatting: ${m[0]}`;
  if (/\n\s*\n/.test(text)) return "several paragraphs";
  if ((m = text.match(CONTRADICTS))) return `contradicts the facts: ${m[0]}`;
  if ((m = text.match(TELLS_FEELINGS))) return `tells the person what they feel: ${m[0]}`;
  const hits = areas.filter(a => AREA_WORDS[a] && AREA_WORDS[a].test(text)).length;
  if (hits < Math.min(2, areas.length)) return "doesn't mention what changed";
  return null;
}
export const acceptable = (text, areas) => rejectReason(text, areas) === null;
// Kept in memory only, for the "what the guard caught" view. Never stored.
export const attempts = [];

// What the model is allowed to know: which areas moved and in which direction. No numbers.
export function areasFor(result) {
  const phrase = {
    sleepMin: s => s.direction === "down" ? "shorter sleep" : "longer sleep",
    onset: s => s.direction === "up" ? "later bedtimes" : "earlier bedtimes",
    irregularity: () => "a less regular sleep rhythm",
    steps: () => "less movement",
    places: () => "fewer places visited",
    mood: () => "lower mood in check-ins",
    energy: () => "lower energy in check-ins",
  };
  return result.signals.filter(s => s.status === "shift" || s.status === "mild").map(s => phrase[s.key](s));
}

export function templateMessage(result) {
  if (result.learning) return "Lueur is still learning what a usual week looks like for you. Keep going as you are; there is nothing to do yet.";
  if (!result.facts.length) return "Your recent days look close to your usual rhythm. Lueur will keep an eye on things quietly, only on this phone.";
  if (result.level === 0) {
    const s = result.signals.find(x => x.status === "mild");
    return `Your recent days look close to your usual rhythm. ${s ? `There's a small wobble in your ${s.label.toLowerCase()}, well within ordinary ups and downs.` : ""} Nothing to do; Lueur keeps watching quietly.`.replace(/\s+/g, " ");
  }
  const n = result.facts.length;
  const lead = result.level >= 2
    ? `For most of the last two weeks, ${n} parts of your rhythm have moved away from your usual.`
    : "One part of your rhythm has moved a little away from your usual lately.";
  const tip = result.signals.find(s => s.status !== "steady" && (s.key === "onset" || s.key === "irregularity"))
    ? "If it helps, try starting your wind-down twenty minutes earlier tonight."
    : result.signals.find(s => s.status !== "steady" && (s.key === "steps" || s.key === "places"))
    ? "If it helps, a ten-minute walk in daylight is a small, kind place to start."
    : "If it helps, sending a short message to someone you trust is a small, kind place to start.";
  return `${lead} This isn't a verdict on you, just a pattern worth noticing. ${tip}`;
}

export async function aiMessage(result) {
  const fallback = { text: templateMessage(result), ai: false };
  if (!engine || result.learning || !result.facts.length || result.level === 0) return fallback;
  const areas = areasFor(result);
  const user = `Changes: ${areas.join(", ")}.\nNote:`;
  for (const temperature of [0.4, 0.2, 0.1]) {
    try {
      const reply = await engine.chat.completions.create({
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
        temperature, max_tokens: 150,
      });
      const text = (reply.choices?.[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "").replace(/^Note:\s*/i, "");
      const reason = rejectReason(text, areas);
      attempts.unshift({ text, reason, at: new Date().toISOString() }); attempts.length = Math.min(attempts.length, 12);
      if (!reason) return { text, ai: true };
    } catch { break; }
  }
  return { ...fallback, filtered: true };
}
