// Synthetic demo data. Ranges follow what consumer trackers report for working adults;
// the "gradual shift" persona plants the pattern described by Wang 2018 and Fang 2021:
// later and more irregular sleep, shorter sleep, fewer steps, fewer places, lower check-ins.
import { addDays, isoDate } from "./engine.js";

function rng(seed) { // mulberry32, so the demo is identical on every phone
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function gauss(r) { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const PERSONAS = {
  shift: { label: "Gradual shift", blurb: "Six steady weeks, then three weeks where sleep slides later, movement drops and check-ins dip." },
  steady: { label: "Steady rhythm", blurb: "Eight ordinary weeks, with the normal ups and downs and one tagged trip." },
};

export function generate(persona = "shift", nDays = 63, endDate = isoDate(new Date())) {
  const r = rng(persona === "shift" ? 42 : 7);
  const start = addDays(endDate, -(nDays - 1));
  const driftStart = nDays - 21;
  const out = [];
  for (let i = 0; i < nDays; i++) {
    const date = addDays(start, i);
    const dow = new Date(date + "T12:00:00").getDay();
    const weekend = dow === 0 || dow === 6;
    // drift progress 0 -> 1 over the last three weeks (only for the shift persona)
    const p = persona === "shift" && i >= driftStart ? Math.min(1, (i - driftStart + 1) / 12) : 0;

    const onset = 680 + (weekend ? 35 : 0) + p * 85 + gauss(r) * (18 + p * 32);      // 23:20 -> ~00:45, noisier
    const sleepMin = 445 + (weekend ? 30 : 0) - p * 70 + gauss(r) * (24 + p * 10);    // 7h25 -> ~6h15
    const steps = (weekend ? 9400 : 8100) * (1 - p * 0.5) + gauss(r) * 1500;          // ~8.3k -> ~4.2k
    const places = Math.round(clamp((weekend ? 3.6 : 3) * (1 - p * 0.55) + gauss(r) * 0.9, 0, 8));
    const homeStay = Math.round(clamp((weekend ? 62 : 55) + p * 28 + gauss(r) * 5, 20, 98));     // % of day at home
    const rangeKm = Math.round(clamp((weekend ? 8 : 6) * (1 - p * 0.6) + gauss(r) * 1.1, 0.3, 40) * 10) / 10;
    const checked = r() < 0.82;
    const mood = checked ? Math.round(clamp(3.8 - p * 1.5 + gauss(r) * 0.6, 1, 5)) : undefined;
    const energy = checked ? Math.round(clamp(3.7 - p * 2 + gauss(r) * 0.55, 1, 5)) : undefined;

    const day = { date, onset: Math.round(onset), sleepMin: Math.round(sleepMin), steps: Math.max(300, Math.round(steps)), places, homeStay, rangeKm, source: "demo" };
    if (mood) { day.mood = mood; day.energy = energy; }
    if (persona === "steady" && i >= 30 && i <= 33) day.tags = ["travel"];
    if (persona === "shift" && i === 12) day.tags = ["ill"];
    out.push(day);
  }
  return out;
}
