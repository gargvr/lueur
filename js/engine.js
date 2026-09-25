// Baseline-drift engine. Deterministic and explainable on purpose: every flag can be traced
// back to a number the person can see. No model decides risk.
//
// Evidence base (see README):
//  - Wang et al. 2018, IMWUT 2(1): sleep duration/onset/irregularity, stationary time,
//    places visited and phone use tracked PHQ-8 / PHQ-4 in students.
//  - Fang et al. 2021, npj Digit Med: shorter, later, more variable sleep preceded
//    depressive symptoms in 2,115 interns under work stress.
//  - Benasi et al. 2021: prodromes repeat within a person, hence a personal baseline.
//  - Müller et al. 2021 / Pratap et al. 2019: population thresholds generalise poorly.
//  - ICD-11 6A70 uses a two-week window, hence the 14-day look-back.

export const SIGNALS = [
  { key: "sleepMin",     label: "Sleep",           bad: "both", floor: 25,  fmt: fmtDur,   source: "sleep" },
  { key: "onset",        label: "Bedtime",         bad: "up",   floor: 25,  fmt: fmtClock, source: "sleep" },
  { key: "irregularity", label: "Sleep rhythm",    bad: "up",   floor: 12,  fmt: v => `±${Math.round(v)} min`, source: "sleep", derived: true },
  { key: "steps",        label: "Movement",        bad: "down", floor: 900, fmt: v => `${fmtInt(v)} steps`, source: "steps" },
  { key: "exercise",     label: "Active minutes", bad: "down", floor: 5, fmt: v => `${Math.round(v)} min`, source: "steps" },
  { key: "places",       label: "Places",          bad: "down", floor: 0.7, fmt: v => `${(Math.round(v * 10) / 10).toString()} a day`, source: "places" },
  // Saeb et al. 2015/2016: more time at home and a smaller range of movement tracked depressive symptoms
  { key: "homeStay",     label: "Time at home",    bad: "up",   floor: 5,   fmt: v => `${Math.round(v)}%`, source: "places" },
  { key: "rangeKm",      label: "Range",           bad: "down", floor: 0.5, fmt: v => `${Math.round(v * 10) / 10} km`, source: "places" },
  // Apple Watch / wearables (added for the iPhone app; Health Connect can supply them too)
  { key: "restingHR",    label: "Resting heart", bad: "up",   floor: 2,   fmt: v => `${Math.round(v)} bpm`, source: "heart" },
  { key: "hrv",          label: "Heart variability", bad: "down", floor: 5, fmt: v => `${Math.round(v)} ms`, source: "heart" },
  { key: "daylight",     label: "Daylight",      bad: "down", floor: 10,  fmt: v => `${Math.round(v)} min`, source: "daylight" },
  { key: "mood",         label: "Mood",            bad: "down", floor: 0.5, fmt: v => `${(Math.round(v * 10) / 10)} / 5`, source: "checkin" },
  { key: "energy",       label: "Energy",          bad: "down", floor: 0.5, fmt: v => `${(Math.round(v * 10) / 10)} / 5`, source: "checkin" },
];

export const CONFIG = {
  minDaysForBaseline: 21,  // days with data before any judgement is made
  recentDays: 14,          // look-back window (ICD-11 two-week convention)
  baselineDays: 28,        // the "usual you" window, right before the look-back
  zFlag: 1.5,              // a day counts as "off" beyond 1.5 robust SDs in the unhelpful direction
  persistShift: 0.6,       // drifting: off on at least 60% of recent days...
  zMedianShift: 1.2,       // ...and the recent week's median is clearly off too
  persistMild: 0.4,
  zMedianMild: 0.8,
};

export const CONTEXT_TAGS = [
  { id: "travel", label: "Travelling" },
  { id: "ill", label: "Unwell" },
  { id: "holiday", label: "Holiday" },
  { id: "deadline", label: "Big deadline" },
  { id: "guests", label: "Visitors" },
  { id: "newborn", label: "New baby" },
  { id: "shift", label: "Night shift" },
];

// ---------- helpers ----------
export function fmtDur(min) {
  if (min == null || isNaN(min)) return "–";
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return `${h}h ${String(m).padStart(2, "0")}`;
}
export function fmtDelta(min) { const m = Math.round(min); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}`; }
// onset is stored as minutes after 12:00 (noon), so 23:30 -> 690 and 01:00 -> 780.
export function fmtClock(minAfterNoon) {
  if (minAfterNoon == null || isNaN(minAfterNoon)) return "–";
  const t = (Math.round(minAfterNoon) + 12 * 60) % (24 * 60);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
export function clockToOnset(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  let mins = h * 60 + m - 12 * 60;
  if (mins < 0) mins += 24 * 60;
  return mins;
}
function fmtInt(v) { return Math.round(v).toLocaleString("en-CH").replace(/’/g, "'"); }
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mad = (a, c) => median(a.map(v => Math.abs(v - c)));
const sd = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
const isNum = v => typeof v === "number" && !isNaN(v);
export function isoDate(d) { const z = new Date(d); z.setMinutes(z.getMinutes() - z.getTimezoneOffset()); return z.toISOString().slice(0, 10); }
export function addDays(iso, n) { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return isoDate(d); }

function badZ(z, dir) { return dir === "up" ? z : dir === "down" ? -z : Math.abs(z); }

// Fill calendar gaps so windows are real calendar windows, and derive sleep irregularity.
export function prepare(rawDays) {
  if (!rawDays.length) return [];
  const byDate = new Map(rawDays.map(d => [d.date, d]));
  const first = rawDays[0].date, last = rawDays[rawDays.length - 1].date;
  const out = [];
  for (let d = first; d <= last; d = addDays(d, 1)) out.push({ ...(byDate.get(d) || { date: d }) });
  for (let i = 0; i < out.length; i++) {
    const win = out.slice(Math.max(0, i - 6), i + 1).map(x => x.onset).filter(isNum);
    out[i].irregularity = win.length >= 4 ? sd(win) : undefined;
  }
  return out;
}

const excluded = d => Array.isArray(d.tags) && d.tags.length > 0;

export function analyze(rawDays, enabledSources) {
  const days = prepare(rawDays);
  const withData = days.filter(d => SIGNALS.some(s => isNum(d[s.key])));
  const result = { days, level: 0, learning: false, learnedDays: withData.length, signals: [], facts: [], offDays: 0, window: null };
  if (withData.length < CONFIG.minDaysForBaseline) { result.learning = true; return result; }

  const end = days.length;
  const recent = days.slice(Math.max(0, end - CONFIG.recentDays), end);
  const base = days.slice(Math.max(0, end - CONFIG.recentDays - CONFIG.baselineDays), Math.max(0, end - CONFIG.recentDays));
  result.window = { from: recent[0]?.date, to: recent[recent.length - 1]?.date, baseFrom: base[0]?.date, baseTo: base[base.length - 1]?.date };
  const recentValid = recent.filter(d => !excluded(d));
  const baseValid = base.filter(d => !excluded(d));
  const offCount = new Map();

  for (const s of SIGNALS) {
    if (enabledSources && !enabledSources.includes(s.source)) continue;
    const bVals = baseValid.map(d => d[s.key]).filter(isNum);
    const rDays = recentValid.filter(d => isNum(d[s.key]));
    const sig = { ...s, status: "learning", center: NaN, scale: NaN, recentMedian: NaN, persist: 0, zMedian: 0, nRecent: rDays.length };
    if (bVals.length >= 10 && rDays.length >= 5) {
      const c = median(bVals);
      const sc = Math.max(1.4826 * mad(bVals, c), s.floor);
      let off = 0;
      for (const d of rDays) {
        const bz = badZ((d[s.key] - c) / sc, s.bad);
        if (bz >= CONFIG.zFlag) { off++; offCount.set(d.date, (offCount.get(d.date) || 0) + 1); }
      }
      const last7 = rDays.slice(-7).map(d => d[s.key]);
      const rm = median(last7);
      const zm = badZ((rm - c) / sc, s.bad);
      Object.assign(sig, { center: c, scale: sc, recentMedian: rm, persist: off / rDays.length, zMedian: zm, offDays: off });
      sig.status = sig.persist >= CONFIG.persistShift && zm >= CONFIG.zMedianShift ? "shift"
                 : sig.persist >= CONFIG.persistMild && zm >= CONFIG.zMedianMild ? "mild" : "steady";
      sig.direction = rm > c ? "up" : "down";
    }
    result.signals.push(sig);
  }

  const shifts = result.signals.filter(s => s.status === "shift");
  const milds = result.signals.filter(s => s.status === "mild");
  const feel = shifts.some(s => s.key === "mood" || s.key === "energy");
  result.level = shifts.length >= 3 || (shifts.length >= 2 && feel) ? 2 : (shifts.length >= 1 || milds.length >= 2) ? 1 : 0;
  result.offDays = [...offCount.values()].filter(n => n >= 2).length;
  result.excludedDays = recent.length - recentValid.length;
  result.facts = [...shifts, ...milds].map(factFor).filter(Boolean);
  return result;
}

// Plain-language facts. These are the only thing the on-device language model ever sees.
export function factFor(s) {
  const c = s.center, r = s.recentMedian;
  switch (s.key) {
    case "sleepMin": return `Sleep: about ${fmtDur(r)} a night lately, compared with your usual ${fmtDur(c)}.`;
    case "onset": return `Bedtime: falling asleep around ${fmtClock(r)}, about ${fmtDelta(Math.abs(r - c))} ${r > c ? "later" : "earlier"} than your usual ${fmtClock(c)}.`;
    case "irregularity": return `Sleep rhythm: bedtime has varied by about ±${Math.round(r)} minutes night to night, versus your usual ±${Math.round(c)}.`;
    case "steps": return `Movement: about ${fmtInt(r)} steps a day, down from your usual ${fmtInt(c)}.`;
    case "homeStay": return `Time at home: about ${Math.round(r)}% of the day lately, more than your usual ${Math.round(c)}%.`;
    case "rangeKm": return `Range: you've moved within about ${Math.round(r * 10) / 10} km of your day's centre, less than your usual ${Math.round(c * 10) / 10} km.`;
    case "places": return `Places: about ${Math.round(r * 10) / 10} ${Math.round(r * 10) / 10 === 1 ? "place" : "places"} a day, fewer than your usual ${Math.round(c * 10) / 10}.`;
    case "exercise": return `Active minutes: about ${Math.round(r)} a day, down from your usual ${Math.round(c)}.`;
    case "restingHR": return `Resting heart rate, a sign of how rested your body is: around ${Math.round(r)} bpm lately, higher than your usual ${Math.round(c)}.`;
    case "hrv": return `Heart rate variability: around ${Math.round(r)} ms lately, lower than your usual ${Math.round(c)}.`;
    case "daylight": return `Daylight: about ${Math.round(r)} minutes outside a day, down from your usual ${Math.round(c)}.`;
    case "mood": return `Mood (your check-ins and any moods logged in Health): around ${Math.round(r * 10) / 10} out of 5, lower than your usual ${Math.round(c * 10) / 10}.`;
    case "energy": return `Energy check-ins: around ${Math.round(r * 10) / 10} out of 5, lower than your usual ${Math.round(c * 10) / 10}.`;
  }
}

export function stateCopy(result) {
  if (result.learning) return {
    cls: "learning",
    title: "Getting to know your rhythm",
    sub: `Lueur needs about ${CONFIG.minDaysForBaseline} days to learn what is usual for you. Day ${Math.min(result.learnedDays, CONFIG.minDaysForBaseline)} of ${CONFIG.minDaysForBaseline}.`,
  };
  if (result.level === 2) return {
    cls: "s2",
    title: "A few things have shifted for a while",
    sub: "Several of your rhythms have moved away from your usual for most of the last two weeks. It could be a good moment to share how you are with someone.",
  };
  if (result.level === 1) return {
    cls: "s1",
    title: "Something has shifted a little",
    sub: "One part of your rhythm looks different from your usual lately. Nothing to fix, just worth noticing.",
  };
  return { cls: "", title: "Your rhythm looks steady", sub: "Things look close to your usual. Lueur keeps quietly watching, only on this phone." };
}

// The one-page summary a person can choose to share. Behaviour only, no labels, no diagnosis.
export function buildSummary(result, name) {
  const lines = [];
  lines.push(`${name ? name + "'s" : "My"} Lueur summary`);
  if (result.window) lines.push(`Period: ${result.window.from} to ${result.window.to}, compared with ${result.window.baseFrom} to ${result.window.baseTo}.`);
  lines.push("");
  lines.push("What changed compared with my usual:");
  if (result.facts.length) result.facts.forEach(f => lines.push(`- ${f}`));
  else lines.push("- Nothing stands out right now.");
  const steady = result.signals.filter(s => s.status === "steady").map(s => s.label.toLowerCase());
  if (steady.length) lines.push(`Steady: ${steady.join(", ")}.`);
  if (result.excludedDays) lines.push(`${result.excludedDays} day(s) were left out because I tagged them (travel, illness, etc.).`);
  lines.push("");
  lines.push("This is not a diagnosis. Lueur compares me only with my own usual patterns, and I chose to share this.");
  return lines.join("\n");
}
