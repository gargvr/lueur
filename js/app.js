import { kv, allDays, putDays, upsertDay, getDay, clearDays, wipeAll, exportAll, prune, RETENTION_DAYS } from "./store.js";
import { analyze, stateCopy, buildSummary, SIGNALS, CONFIG, CONTEXT_TAGS, isoDate, addDays, fmtDur, fmtClock } from "./engine.js";
import { generate, PERSONAS } from "./demo.js";
import { parseCSV, detectFitbitKaggle, fitbitIds, fromFitbitKaggle, fromLueurCSV, fromFitbitTakeout, fromAppleHealth, TEMPLATE_CSV } from "./importers.js";
import { startPlaces, stopPlaces } from "./sensing.js";
import { MODELS, hasWebGPU, loadModel, isLoaded, loadedModel, aiMessage, templateMessage, attempts } from "./slm.js";

const $app = document.getElementById("app");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const DEFAULTS = {
  onboarded: false, step: 0,
  consent: { sleep: false, steps: false, places: false, checkin: false, model: false, agreedAt: null },
  trusted: { name: "", contact: "" },
  name: "", under25: false, goalsDone: {}, snoozeUntil: null, dataLabel: null,
};
const S = { settings: null, days: [], result: null, message: null, tab: "today", sheet: null, modelProgress: null };

// ---------------- icons ----------------
const I = {
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>',
  wave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2.5 14c2.5 0 2.5-4 5-4s2.5 4 5 4 2.5-4 5-4 2.5 4 4 4"/><path d="M2.5 19c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 4 2" opacity=".5"/></svg>',
  circle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="8.5" cy="9" r="3.2"/><circle cx="16.5" cy="10" r="2.6"/><path d="M3 19c.8-3 3-4.6 5.5-4.6S13.2 16 14 19M14.5 15.2c.6-.3 1.3-.5 2-.5 2 0 3.6 1.3 4.2 3.8"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="4.5" y="10.5" width="15" height="10" rx="3"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" width="16" height="16"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" width="14" height="14"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
};

// ---------------- data ----------------
function enabledSources() {
  const c = S.settings.consent;
  return ["sleep", "steps", "places", "checkin"].filter(k => c[k]);
}
async function saveSettings(patch) {
  S.settings = { ...S.settings, ...patch };
  await kv.set("settings", S.settings);
}
async function refresh({ regenerate = true } = {}) {
  S.days = await allDays();
  S.result = analyze(S.days, enabledSources());
  if (regenerate) {
    S.message = { text: templateMessage(S.result), ai: false };
    if (isLoaded()) aiMessage(S.result).then(m => { S.message = m; if (S.tab === "today" && !S.sheet) render(); });
  }
  render();
}
const today = () => isoDate(new Date());
const lastDate = () => S.days.length ? S.days[S.days.length - 1].date : today();

// ---------------- toasts ----------------
function toast(text) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = text; t.setAttribute("role", "status");
  document.body.appendChild(t); setTimeout(() => t.remove(), 2400);
}

// ---------------- charts ----------------
function series(key, n) {
  const days = S.result?.days || [];
  return days.slice(-n).map(d => ({ date: d.date, v: d[key] }));
}
function sparkSVG(sig, n = 21) {
  const pts = series(sig.key, n);
  const vals = pts.map(p => p.v).filter(v => typeof v === "number");
  if (vals.length < 2) return '<svg class="spark" viewBox="0 0 100 36"></svg>';
  const lo0 = isNaN(sig.center) ? Math.min(...vals) : Math.min(...vals, sig.center - sig.scale);
  const hi0 = isNaN(sig.center) ? Math.max(...vals) : Math.max(...vals, sig.center + sig.scale);
  const pad = (hi0 - lo0) * 0.12 || 1, lo = lo0 - pad, hi = hi0 + pad;
  const x = i => (i / (pts.length - 1)) * 100, y = v => 34 - ((v - lo) / (hi - lo)) * 32;
  let d = "", started = false;
  pts.forEach((p, i) => { if (typeof p.v === "number") { d += `${started ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`; started = true; } });
  const band = isNaN(sig.center) ? "" : `<rect x="0" width="100" y="${y(sig.center + sig.scale).toFixed(1)}" height="${(y(sig.center - sig.scale) - y(sig.center + sig.scale)).toFixed(1)}" fill="var(--lake-soft)" rx="3"/>`;
  const col = sig.status === "shift" ? "var(--dawn)" : sig.status === "mild" ? "var(--lilac)" : "var(--lake)";
  const lastI = pts.map(p => typeof p.v === "number").lastIndexOf(true);
  return `<svg class="spark" viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">${band}<path d="${d}" fill="none" stroke="${col}" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>${lastI >= 0 ? `<circle cx="${x(lastI)}" cy="${y(pts[lastI].v)}" r="2.2" fill="${col}"/>` : ""}</svg>`;
}
function bigChart(sig) {
  const n = 42, pts = series(sig.key, n);
  const W = 340, H = 150, L = 44, R = 8, T = 10, B = 22;
  const vals = pts.map(p => p.v).filter(v => typeof v === "number");
  if (vals.length < 2) return `<p class="small muted">Not enough ${esc(sig.label.toLowerCase())} data yet.</p>`;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (!isNaN(sig.center)) { lo = Math.min(lo, sig.center - 1.6 * sig.scale); hi = Math.max(hi, sig.center + 1.6 * sig.scale); }
  const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  const x = i => L + (i / (pts.length - 1)) * (W - L - R), y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const fmt = v => sig.key === "onset" ? fmtClock(v) : sig.key === "sleepMin" ? fmtDur(v) : sig.key === "steps" ? `${Math.round(v / 100) / 10}k` : String(Math.round(v * 10) / 10);
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
  const recentStart = Math.max(0, pts.length - CONFIG.recentDays);
  let path = "", on = false;
  pts.forEach((p, i) => { if (typeof p.v === "number") { path += `${on ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`; on = true; } });
  const col = sig.status === "shift" ? "var(--dawn)" : sig.status === "mild" ? "var(--lilac)" : "var(--lake)";
  const band = isNaN(sig.center) ? "" :
    `<rect x="${L}" width="${W - L - R}" y="${y(sig.center + sig.scale)}" height="${y(sig.center - sig.scale) - y(sig.center + sig.scale)}" fill="var(--lake-soft)"/>
     <line x1="${L}" x2="${W - R}" y1="${y(sig.center)}" y2="${y(sig.center)}" stroke="var(--lake)" stroke-dasharray="3 4" stroke-width="1"/>`;
  const tagged = pts.map((p, i) => (S.result.days.find(d => d.date === p.date)?.tags?.length ? `<rect x="${x(i) - 3}" y="${T}" width="6" height="${H - T - B}" fill="var(--line)" opacity=".7"/>` : "")).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(sig.label)} over the last ${n} days">
    <rect x="${x(recentStart)}" y="${T}" width="${W - R - x(recentStart)}" height="${H - T - B}" fill="var(--surface-2)"/>
    ${band}${tagged}
    ${ticks.map(t => `<text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${esc(fmt(t))}</text>`).join("")}
    <text x="${L}" y="${H - 6}">${esc(pts[0].date.slice(5))}</text>
    <text x="${x(recentStart)}" y="${H - 6}">last 14 days</text>
    <path d="${path}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

// ---------------- screens ----------------
function topbar() {
  return `<div class="topbar">
    <div class="brand"><span class="brand-dot" aria-hidden="true"></span>Lueur</div>
    <button class="help-pill" data-act="help">${I.heart} Talk to someone now</button>
  </div>`;
}
function nav() {
  const b = (id, label, icon) => `<button class="navbtn" data-act="tab" data-arg="${id}" ${S.tab === id ? 'aria-current="page"' : ""}>${icon}<span>${label}</span></button>`;
  return `<nav class="nav" aria-label="Main"><div class="nav-inner">${b("today", "Today", I.sun)}${b("rhythm", "Rhythm", I.wave)}${b("circle", "Support", I.circle)}${b("privacy", "Privacy", I.lock)}</div></nav>`;
}

function valueFor(sig) {
  const v = sig.recentMedian;
  if (sig.key === "sleepMin") return fmtDur(v);
  if (sig.key === "onset") return fmtClock(v);
  if (sig.key === "irregularity") return `±${Math.round(v)}m`;
  if (sig.key === "steps") return Math.round(v).toLocaleString("en-CH").replace(/’/g, "'");
  return String(Math.round(v * 10) / 10);
}
function deltaFor(sig) {
  if (sig.status === "learning") return "Still learning";
  const usual = sig.key === "sleepMin" ? fmtDur(sig.center) : sig.key === "onset" ? fmtClock(sig.center) : sig.key === "irregularity" ? `±${Math.round(sig.center)}m` : sig.key === "steps" ? Math.round(sig.center).toLocaleString("en-CH").replace(/’/g, "'") : String(Math.round(sig.center * 10) / 10);
  return `Usual ${usual}`;
}

const GOALS = [
  { id: "daylight", text: "Ten minutes outside in daylight", when: s => ["steps", "places", "mood", "energy"].includes(s.key) },
  { id: "winddown", text: "Start winding down 20 minutes earlier", when: s => ["onset", "irregularity", "sleepMin"].includes(s.key) },
  { id: "message", text: "Send one message to someone you like", when: s => ["places", "mood"].includes(s.key) },
  { id: "breathe", text: "One minute of slow breathing", when: () => true, act: "breathe" },
  { id: "water", text: "A glass of water and something to eat", when: s => ["energy", "mood"].includes(s.key) },
];

function todayScreen() {
  const r = S.result, st = stateCopy(r);
  const td = S.days.find(d => d.date === today());
  const needCheckin = S.settings.consent.checkin && !(td && td.mood);
  const shown = r.signals.filter(s => s.nRecent > 0 || s.status !== "learning");
  const moving = r.signals.filter(s => s.status === "shift" || s.status === "mild");
  const goals = GOALS.filter(g => moving.some(g.when)).slice(0, 3);
  const doneToday = S.settings.goalsDone[today()] || [];
  const dataNote = S.settings.dataLabel && lastDate() !== today() ? `<p class="tiny muted" style="text-align:center">Showing ${esc(S.settings.dataLabel)} up to ${esc(lastDate())}</p>` : S.settings.dataLabel ? `<p class="tiny muted" style="text-align:center">${esc(S.settings.dataLabel)}</p>` : "";
  return `${topbar()}
  <div class="stack-lg">
    <div>
      <div class="orb-wrap"><div class="orb ${st.cls}" role="img" aria-label="${esc(st.title)}"></div></div>
      <h1 class="state-title">${esc(st.title)}</h1>
      <p class="state-sub">${esc(st.sub)}</p>
      ${dataNote}
    </div>

    <div class="card">
      <p class="msg">${esc(S.message?.text || "")}</p>
      <div class="row between wrap">
        <span class="ai-tag">${S.message?.ai ? `${I.spark} Written by the AI on this phone. It can be wrong.` : "Lueur's own words"}</span>
        ${!r.learning && r.facts.length ? `<button class="linkbtn small" data-act="why">Why am I seeing this?</button>` : ""}
      </div>
    </div>

    ${needCheckin ? `<button class="card lilac" data-act="checkin" style="text-align:left;border:0;font:inherit;color:inherit;cursor:pointer">
      <p class="eyebrow">Ten seconds</p><h3>How are you today?</h3><p class="small muted">Two taps: mood and energy. It helps Lueur notice what sensors can't.</p></button>` : ""}

    ${r.level >= 2 && !(S.settings.snoozeUntil && S.settings.snoozeUntil > today()) ? `<div class="card dawn">
      <p class="eyebrow">When you feel ready</p>
      <h3>You don't have to sort this out alone</h3>
      <p class="small">You decide if anyone sees anything. You can start small, with ${S.settings.trusted.name ? esc(S.settings.trusted.name) : "someone you trust"}.</p>
      <div class="row wrap"><button class="btn" data-act="tab" data-arg="circle">See my options</button><button class="btn ghost" data-act="snooze">Not now</button></div>
    </div>` : ""}

    ${goals.length ? `<div class="stack">
      <h2>Small, kind steps</h2>
      ${goals.map(g => `<button class="card soft" data-act="${g.act || "goal"}" data-arg="${g.id}" style="text-align:left;font:inherit;color:inherit;cursor:pointer">
        <div class="row between"><span>${esc(g.text)}</span><span class="pip ${doneToday.includes(g.id) ? "" : "off"}" aria-label="${doneToday.includes(g.id) ? "done" : "not done"}"></span></div></button>`).join("")}
    </div>` : ""}

    ${shown.length ? `<div class="stack">
      <div class="row between"><h2>Your rhythm</h2><button class="linkbtn small" data-act="tab" data-arg="rhythm">Details</button></div>
      <div class="tiles">${shown.map(s => `<button class="tile ${s.status === "shift" ? "shift" : ""}" data-act="tab" data-arg="rhythm">
        <span class="lbl"><span class="pip ${s.status === "shift" ? "shift" : s.status === "learning" ? "off" : ""}"></span>${esc(s.label)}</span>
        <span class="val">${s.status === "learning" && isNaN(s.recentMedian) ? "–" : esc(valueFor(s))}</span>
        ${sparkSVG(s)}
        <span class="delta">${esc(deltaFor(s))}</span></button>`).join("")}</div>
    </div>` : ""}

    <div class="stack">
      <h3>Anything unusual today?</h3>
      <p class="small muted">Tagged days are left out, so a trip or a cold doesn't look like a shift.</p>
      <div class="chips">${CONTEXT_TAGS.map(t => `<button class="chip" data-act="tag" data-arg="${t.id}" aria-pressed="${!!(td?.tags || []).includes(t.id)}">${esc(t.label)}</button>`).join("")}</div>
    </div>

    <div class="row wrap"><button class="btn quiet" data-act="breathe">Breathe for a minute</button>${S.settings.consent.checkin && !needCheckin ? `<button class="btn ghost" data-act="checkin">Update check-in</button>` : ""}</div>
  </div>`;
}

function rhythmScreen() {
  const r = S.result;
  const sigs = r.signals;
  return `${topbar()}
  <div class="stack-lg">
    <div class="stack"><h1>Your rhythm</h1>
      <p class="muted">Each line is you, compared only with you. The shaded band is your usual range from the four weeks before the last two.</p>
      <div class="legend"><span><i style="background:var(--lake-soft)"></i>Your usual range</span><span><i style="background:var(--surface-2);border:1px solid var(--line)"></i>Last 14 days</span><span><i style="background:var(--line)"></i>Tagged day</span></div>
    </div>
    ${r.learning ? `<div class="card lilac"><h3>Still learning</h3><p class="small">Lueur has ${r.learnedDays} of ${CONFIG.minDaysForBaseline} days it needs before comparing anything.</p></div>` : ""}
    ${sigs.map(s => `<div class="card">
      <div class="row between"><h3>${esc(s.label)}</h3><span class="ai-tag">${s.status === "shift" ? "Shifted" : s.status === "mild" ? "A little different" : s.status === "learning" ? "Learning" : "Steady"}</span></div>
      ${bigChart(s)}
      ${s.status !== "learning" ? `<p class="small muted">Off your usual on ${s.offDays || 0} of the last ${s.nRecent} days. ${s.status === "shift" || s.status === "mild" ? "" : "Within your normal ups and downs."}</p>` : ""}
    </div>`).join("")}
    <details class="card soft"><summary><b>How Lueur decides</b></summary>
      <div class="stack small" style="margin-top:10px">
        <p>Lueur never compares you with other people. For each signal it learns your usual level and your usual day-to-day wobble (median and median absolute deviation) from the four weeks before the last two.</p>
        <p>A day counts as "off" when it is more than ${CONFIG.zFlag} of your own usual wobbles away in the less helpful direction. A signal has <b>shifted</b> when it was off on at least ${CONFIG.persistShift * 100}% of the last 14 days and the last week's middle value is clearly off too. Tagged days are left out.</p>
        <p>The gentle suggestion to reach out only appears when three signals have shifted, or two including your own check-ins. These are fixed rules, written down here, not a black box. The AI only rewrites the result in kinder words.</p>
        <p>Based on Wang et al. 2018 (IMWUT), Fang et al. 2021 (npj Digital Medicine), Benasi et al. 2021 and the ICD-11 two-week convention.</p>
      </div></details>
  </div>`;
}

function circleScreen() {
  const t = S.settings.trusted;
  const r = S.result;
  const summary = buildSummary(r, S.settings.name);
  return `${topbar()}
  <div class="stack-lg">
    <div class="stack"><h1>Support, at your pace</h1>
      <p class="muted">Nothing is ever sent automatically. Each step is your choice, and you can stop at any one.</p></div>
    <div class="ladder">
      <div class="step"><span class="n">1</span><div class="stack"><h3>Keep an eye on it</h3>
        <p class="small muted">Carry on as you are. Lueur will keep noticing, and try a small step when it suits you.</p>
        <button class="btn ghost" data-act="snooze">Remind me in a few days</button></div></div>

      <div class="step s2"><span class="n">2</span><div class="stack"><h3>Share with ${t.name ? esc(t.name) : "someone you trust"}</h3>
        <p class="small muted">Send a short summary of what changed, in your own words if you like. No raw data, no labels.</p>
        ${t.name ? "" : `<button class="linkbtn small" data-act="editTrusted">Choose your trusted person</button>`}
        <button class="btn" data-act="share" data-arg="trusted">I'm ready to share my results</button></div></div>

      <div class="step s3"><span class="n">3</span><div class="stack"><h3>Talk with a professional</h3>
        <p class="small muted">In Switzerland, a GP can prescribe sessions with a psychologist-psychotherapist; since July 2022 basic insurance covers them (up to 15 sessions per prescription, minus your deductible). Your summary can help start that conversation.</p>
        <button class="btn warm" data-act="share" data-arg="pro">I'm ready to share my results with a professional</button>
        <button class="linkbtn small" data-act="pros">Where to find one in Geneva</button></div></div>
    </div>

    <div class="card soft stack">
      <div class="row between"><h3>Your trusted person</h3><button class="linkbtn small" data-act="editTrusted">${t.name ? "Change" : "Add"}</button></div>
      <p class="small muted">${t.name ? `${esc(t.name)}${t.contact ? ` · ${esc(t.contact)}` : ""}. They never receive anything unless you press share.` : "Someone who would walk alongside you. Only stored on this phone."}</p>
    </div>

    <details class="card soft"><summary><b>Preview what would be shared</b></summary><pre style="white-space:pre-wrap;font:14px/1.5 var(--body);margin:10px 0 0">${esc(summary)}</pre></details>
  </div>`;
}

function privacyScreen() {
  const c = S.settings.consent;
  const counts = { days: S.days.length, withSleep: S.days.filter(d => d.sleepMin != null).length, withCheckin: S.days.filter(d => d.mood != null).length };
  const toggle = (k, title, desc) => `<div class="toggle-row"><div class="txt"><b>${title}</b><span class="small muted">${desc}</span></div>
    <label class="toggle"><input type="checkbox" data-act="consent" data-arg="${k}" ${c[k] ? "checked" : ""} aria-label="${esc(title)}"><span></span></label></div>`;
  return `${topbar()}
  <div class="stack-lg">
    <div class="stack"><h1>Your data stays here</h1>
      <p class="muted">Lueur has no server and no account. Everything below lives only in this browser on this phone.</p></div>
    <div class="card"><dl class="kv"><dt>Days stored</dt><dd>${counts.days}</dd><dt>Nights of sleep</dt><dd>${counts.withSleep}</dd><dt>Check-ins</dt><dd>${counts.withCheckin}</dd><dt>Places</dt><dd>Only a daily count; never coordinates</dd><dt>Consent given</dt><dd>${c.agreedAt ? esc(new Date(c.agreedAt).toLocaleDateString("en-CH")) : "Not yet"}</dd></dl></div>

    <div class="card"><h3>What Lueur may notice</h3><p class="small muted">Change your mind any time. Turning a signal off stops using it straight away.</p>
      ${toggle("sleep", "Sleep", "Duration, bedtime and regularity, from a file you import.")}
      ${toggle("steps", "Movement", "Daily steps, from a file you import.")}
      ${toggle("places", "Places", "While Lueur is open, counts different places per day. Coordinates are discarded.")}
      ${toggle("checkin", "Daily check-in", "Two taps for mood and energy.")}
    </div>

    <div class="card stack"><div class="row between"><h3>On-device AI</h3><span class="ai-tag">${isLoaded() ? "Ready" : "Off"}</span></div>
      <p class="small muted">A small language model can run on this phone to phrase messages more naturally. It is only told which areas changed, such as "later bedtimes", never numbers, names or raw data. It never decides anything, and any reply with numbers, labels or odd formatting is thrown away. Download once: ${esc(MODELS.phone.label)}.</p>
      ${S.modelProgress != null ? `<div class="bar" aria-label="Model download"><i style="width:${Math.round(S.modelProgress * 100)}%"></i></div><p class="tiny muted">${Math.round(S.modelProgress * 100)}%</p>` : ""}
      ${isLoaded() && attempts.length ? `<details><summary class="small"><b>What the guard checked</b> (${attempts.filter(x => x.reason).length} of ${attempts.length} notes blocked)</summary>
        <ul class="list small" style="margin-top:8px">${attempts.map(x => `<li><span class="${x.reason ? "" : "muted"}">${x.reason ? `Blocked, ${esc(x.reason)}` : "Shown"}</span>: <span class="muted">"${esc(x.text.slice(0, 140))}${x.text.length > 140 ? "…" : ""}"</span></li>`).join("")}</ul>
        <p class="tiny muted">Kept in memory only while the app is open.</p></details>` : ""}
      ${isLoaded() ? `<p class="small">Running: ${esc(loadedModel())}</p>` : hasWebGPU()
        ? `<button class="btn quiet" data-act="loadModel" data-arg="phone">Download the on-device AI</button>`
        : `<p class="small">This browser has no WebGPU, so Lueur uses its own fixed wording. Everything else works the same.</p>`}
    </div>

    <div class="card stack"><h3>Add data</h3>
      <div class="row wrap"><button class="btn quiet" data-act="import">Import a file</button><button class="btn ghost" data-act="demo">Load demo data</button></div>
      <p class="tiny muted">Fitbit (Kaggle CSV or Google Takeout JSON), Apple Health export.xml, or the Lueur CSV template.</p></div>

    <div class="card stack"><h3>Take it with you, or erase it</h3>
      <div class="row wrap"><button class="btn quiet" data-act="export">Download my data</button><button class="btn ghost" data-act="wipe">Delete everything</button></div></div>

    <details class="card soft"><summary><b>Privacy notice</b></summary>
      <dl class="kv small" style="margin-top:10px">
        <dt>Who</dt><dd>The Lueur team, Geneva {ai} Hackathon 2026. We never receive your data, because there is nowhere to send it.</dd>
        <dt>Why</dt><dd>Only to show you changes in your own routine and help you reach support if you choose.</dd>
        <dt>What</dt><dd>The signals you switched on, daily check-ins, tags, your trusted person's name and contact.</dd>
        <dt>Where</dt><dd>This browser on this device (IndexedDB). No cloud, no analytics, no crash reports.</dd>
        <dt>How long</dt><dd>The most recent ${Math.round(RETENTION_DAYS / 30)} months; older days are erased automatically. Or erase all now.</dd>
        <dt>Shared with</dt><dd>No one, unless you press share, and then only the text you see.</dd>
        <dt>Your rights</dt><dd>See, download and delete everything on this screen (FADP Art. 25, 28, 32).</dd>
      </dl></details>

    <details class="card soft"><summary><b>How Lueur follows Swiss rules</b></summary>
      <ul class="list small" style="margin-top:10px">
        <li><b>Health data is sensitive</b> under the Swiss Federal Act on Data Protection (FADP/nDSG, Art. 5, in force since 1 Sept 2023). Lueur asks for express consent (Art. 6(7)), per signal, and every signal is off until you turn it on.</li>
        <li><b>Privacy by design and by default (Art. 7):</b> processing happens on this device; there is no server that could receive your data. You can see, download and delete all of it.</li>
        <li><b>Data minimisation:</b> places are stored as a daily count only; the AI sees only summary sentences.</li>
        <li><b>AI transparency:</b> the FDPIC says the FADP applies directly to AI and people must know when a machine is writing to them. AI-written text is labelled, the rules that raise a flag are published in plain words, and the AI cannot change them.</li>
        <li><b>Not a medical device:</b> under the Medical Devices Ordinance and Swissmedic's guidance, software intended to diagnose, monitor or predict a disease is a medical device. Lueur's purpose is general wellbeing: it shows changes in your own routine and signposts support. It never names a condition or gives a score. Any assessment is made by a professional.</li>
        <li><b>Professional secrecy</b> starts when you choose to talk to a psychologist or doctor; Lueur never contacts anyone for you.</li>
      </ul></details>

    <p class="tiny muted">Lueur is a prototype from the Geneva {ai} Hackathon 2026 (AGPsy challenge). Open source.</p>
  </div>`;
}

// ---------------- onboarding ----------------
function onboarding() {
  const st = S.settings.step || 0;
  const dots = `<div class="dots" aria-hidden="true">${[0, 1, 2, 3, 4].map(i => `<i class="${i === st ? "on" : ""}"></i>`).join("")}</div>`;
  const c = S.settings.consent;
  const any = ["sleep", "steps", "places", "checkin"].some(k => c[k]);
  const screens = [
    `<div class="hero-art" aria-hidden="true"><div class="sun"></div><div class="hill"></div><div class="hill b"></div></div>
     <div class="stack"><p class="eyebrow">Welcome</p><h1>Notice small shifts early, gently</h1>
     <p class="muted">Lueur learns your own rhythm of sleep, movement and mood. When it drifts for a while, it tells you kindly and helps you reach someone you trust, at your pace.</p>
     <div class="card soft small"><b>What Lueur is not.</b> It is not a therapist, it does not diagnose, and it is not for emergencies. If you need help now, call 143 (La Main Tendue) or 144.</div></div>
     <button class="btn block" data-act="next">Begin</button>`,
    `<div class="stack"><p class="eyebrow">Your privacy</p><h1>It all stays on this phone</h1>
     <ul class="list"><li>No account, no server, no cloud. Lueur cannot see your data, and neither can we.</li>
     <li>Your employer and insurer can never access it.</li>
     <li>You choose each signal, and can switch it off or delete everything at any time.</li>
     <li>An optional AI runs on the phone itself, only to phrase messages. It never decides anything and its words are always labelled.</li></ul></div>
     <div class="stack"><button class="btn block" data-act="next">Continue</button><button class="linkbtn" data-act="back">Back</button></div>`,
    `<div class="stack"><p class="eyebrow">Your choice</p><h1>What may Lueur notice?</h1><p class="muted small">Everything starts off. Turn on only what you're comfortable with.</p></div>
     <div class="card">
      ${[["sleep", "Sleep", "From a sleep tracker file you import"], ["steps", "Movement", "Daily steps, from a file you import"], ["places", "Places", "A daily count while Lueur is open; never where"], ["checkin", "Daily check-in", "Two taps: mood and energy"]].map(([k, t, d]) =>
        `<div class="toggle-row"><div class="txt"><b>${t}</b><span class="small muted">${d}</span></div><label class="toggle"><input type="checkbox" data-act="consent" data-arg="${k}" ${c[k] ? "checked" : ""} aria-label="${t}"><span></span></label></div>`).join("")}
     </div>
     <label class="row small" style="align-items:flex-start"><input type="checkbox" id="agree" data-act="agree" ${c.agreedAt ? "checked" : ""} style="margin-top:4px;width:20px;height:20px">
      <span>I agree that Lueur may process these health-related signals on this phone, only to notice changes in my own rhythm. I can withdraw at any time.</span></label>
     <div class="stack"><button class="btn block" data-act="next" ${any && c.agreedAt ? "" : "disabled"}>Continue</button><button class="linkbtn" data-act="back">Back</button></div>`,
    `<div class="stack"><p class="eyebrow">Someone in your corner</p><h1>Who would you want alongside you?</h1>
     <p class="muted">If things shift for a while, Lueur can help you share a short summary with this person, but only when you press share. They are never contacted automatically.</p></div>
     <div class="card stack">
      <label class="field">Your first name (optional)<input type="text" id="f-name" value="${esc(S.settings.name)}" autocomplete="given-name"></label>
      <label class="field">Their name<input type="text" id="f-tname" value="${esc(S.settings.trusted.name)}" placeholder="e.g. Sam"></label>
      <label class="field">How you reach them (optional)<input type="text" id="f-tcontact" value="${esc(S.settings.trusted.contact)}" placeholder="phone, WhatsApp, email"></label>
      <label class="row small"><input type="checkbox" id="f-u25" ${S.settings.under25 ? "checked" : ""} style="width:20px;height:20px"> I'm under 25 (shows youth support lines)</label>
     </div>
     <div class="stack"><button class="btn block" data-act="saveTrusted" data-arg="next">Continue</button><button class="linkbtn" data-act="next">Skip for now</button></div>`,
    `<div class="stack"><p class="eyebrow">Almost there</p><h1>Where should Lueur start?</h1>
     <p class="muted">Lueur needs about three weeks of history to know your usual. You can bring history in, or try it with example data.</p></div>
     <div class="stack">
      ${Object.entries(PERSONAS).map(([k, p]) => `<button class="card soft" data-act="demo" data-arg="${k}" style="text-align:left;font:inherit;color:inherit;cursor:pointer"><h3>Try the demo: ${esc(p.label)}</h3><p class="small muted">${esc(p.blurb)}</p></button>`).join("")}
<button class="card soft" data-act="demo" data-arg="real" style="text-align:left;font:inherit;color:inherit;cursor:pointer"><h3>Try with real data</h3><p class="small muted">Five months of one person's actual Fitbit sleep and steps, with their daily mood and fatigue ratings (PMData, Simula Research Lab, 2020).</p></button>
      <button class="card soft" data-act="import" style="text-align:left;font:inherit;color:inherit;cursor:pointer"><h3>Import my history</h3><p class="small muted">Fitbit, Apple Health, or a CSV. Read on this phone, never uploaded.</p></button>
      <button class="card soft" data-act="fresh" style="text-align:left;font:inherit;color:inherit;cursor:pointer"><h3>Start fresh</h3><p class="small muted">Begin with daily check-ins and let Lueur learn from today.</p></button>
     </div>
     <button class="linkbtn" data-act="back">Back</button>`,
  ];
  return `<div class="stack-lg" style="padding-top:8px">${dots}${screens[st]}</div>`;
}

// ---------------- sheets ----------------
function sheetHTML() {
  const s = S.sheet; if (!s) return "";
  let body = "";
  if (s.type === "help") {
    body = `<h2>Talk to someone now</h2>
      <p class="muted">Free, confidential, any time. You don't need a reason to call.</p>
      <div class="stack">
        <div class="card"><h3>143 · La Main Tendue</h3><p class="small">24/7, anonymous, by phone, chat or email.</p><div class="row wrap"><a class="btn" href="tel:143">Call 143</a><a class="btn ghost" href="https://www.143.ch" target="_blank" rel="noopener">Chat at 143.ch</a></div></div>
        ${S.settings.under25 ? `<div class="card"><h3>147 · Pro Juventute</h3><p class="small">For young people up to 25. Phone, SMS, chat.</p><a class="btn" href="tel:147">Call 147</a></div>` : ""}
        <div class="card"><h3>HUG psychiatric emergencies, Geneva</h3><p class="small">022 372 38 62</p><a class="btn ghost" href="tel:+41223723862">Call</a></div>
        <div class="card dawn"><h3>In danger right now?</h3><p class="small">Call 144 (medical emergency) or 112.</p><a class="btn warm" href="tel:144">Call 144</a></div>
      </div>`;
  }
  if (s.type === "why") {
    body = `<h2>Why am I seeing this?</h2>
      <p class="muted small">Compared with your own usual (${esc(S.result.window?.baseFrom || "")} to ${esc(S.result.window?.baseTo || "")}), over the last 14 days:</p>
      <ul class="list">${S.result.facts.map(f => `<li>${esc(f)}</li>`).join("")}</ul>
      ${S.result.excludedDays ? `<p class="small muted">${S.result.excludedDays} tagged day(s) were left out.</p>` : ""}
      <p class="small muted">The AI never sees these numbers. It is only told which areas changed (for example "later bedtimes"), and its reply is checked before you see it. The decision itself comes from the fixed rules on the Rhythm tab.</p>`;
  }
  if (s.type === "checkin") {
    const td = S.sheet.draft;
    const scale = (k, lo, hi) => `<div class="stack"><div class="scale">${[1, 2, 3, 4, 5].map(v => `<button class="choice" data-act="pick" data-arg="${k}:${v}" aria-pressed="${td[k] === v}" aria-label="${k} ${v} of 5">${v}</button>`).join("")}</div><div class="scale-labels"><span>${lo}</span><span>${hi}</span></div></div>`;
    body = `<h2>How are you today?</h2>
      <div class="stack"><h3>Mood</h3>${scale("mood", "Heavy", "Light")}</div>
      <div class="stack"><h3>Energy</h3>${scale("energy", "Drained", "Full")}</div>
      <button class="btn block" data-act="saveCheckin" ${td.mood && td.energy ? "" : "disabled"}>Save</button>
      <p class="tiny muted" style="text-align:center">Stored only on this phone.</p>`;
  }
  if (s.type === "breathe") {
    body = `<h2 style="text-align:center">Breathe with the circle</h2>
      <div class="breath"><div class="core" id="core"></div></div>
      <p class="breath-label" id="blabel">Get comfortable</p>
      <p class="small muted" style="text-align:center">In for 4, hold for 4, out for 4, hold for 4. About one minute.</p>
      <button class="btn block quiet" data-act="close">Done</button>`;
  }
  if (s.type === "share") {
    const text = buildSummary(S.result, S.settings.name);
    const pro = s.arg === "pro";
    body = `<h2>${pro ? "Share with a professional" : `Share with ${esc(S.settings.trusted.name || "someone you trust")}`}</h2>
      <p class="muted small">Edit anything you like. Nothing is sent until you choose where it goes.</p>
      <textarea id="share-text" rows="11">${esc((pro ? "" : "Hi, I've noticed some changes in my routine lately and wanted to share them with you.\n\n") + text)}</textarea>
      <div class="row wrap"><button class="btn" data-act="doShare">Share…</button><button class="btn ghost" data-act="copyShare">Copy text</button></div>
      ${pro ? `<p class="small muted">Tip: bring this to your GP, who can prescribe psychotherapy with a psychologist. Or contact a psychologist directly through the AGPsy directory.</p><button class="linkbtn small" data-act="pros">Find a psychologist in Geneva</button>` : ""}`;
  }
  if (s.type === "pros") {
    body = `<h2>Finding a professional in Geneva</h2>
      <div class="stack">
        <div class="card"><h3>Your GP (médecin de famille)</h3><p class="small">Can prescribe up to 15 sessions with a psychologist-psychotherapist, covered by basic insurance since July 2022 (minus deductible and co-pay).</p></div>
        <div class="card"><h3>AGPsy directory</h3><p class="small">900+ psychologists in Geneva. Or call the association on 022 735 53 83.</p><a class="btn ghost" href="https://www.agpsy.ch/members/search" target="_blank" rel="noopener">Open the directory</a></div>
        <div class="card"><h3>Not sure where to start?</h3><p class="small">143 can talk it through with you, anonymously, any time.</p><a class="btn ghost" href="tel:143">Call 143</a></div>
      </div>`;
  }
  if (s.type === "editTrusted") {
    body = `<h2>Your trusted person</h2>
      <div class="card stack">
        <label class="field">Their name<input type="text" id="f-tname" value="${esc(S.settings.trusted.name)}"></label>
        <label class="field">How you reach them<input type="text" id="f-tcontact" value="${esc(S.settings.trusted.contact)}"></label>
        <label class="field">Your first name<input type="text" id="f-name" value="${esc(S.settings.name)}"></label>
        <label class="row small"><input type="checkbox" id="f-u25" ${S.settings.under25 ? "checked" : ""} style="width:20px;height:20px"> I'm under 25</label>
      </div>
      <button class="btn block" data-act="saveTrusted" data-arg="close">Save</button>`;
  }
  if (s.type === "import") {
    body = `<h2>Import your history</h2>
      <p class="small muted">Files are read here on the phone and never uploaded. Choose one or several.</p>
      <label class="btn block quiet" style="position:relative">Choose files<input type="file" id="file-in" multiple accept=".csv,.json,.xml,text/csv,application/json,text/xml" style="position:absolute;inset:0;opacity:0;cursor:pointer" data-act="files"></label>
      ${s.ids ? `<label class="field">This file has several people. Which one?<select id="pick-id">${s.ids.map(id => `<option>${esc(id)}</option>`).join("")}</select></label><button class="btn block" data-act="pickId">Use this person</button>` : ""}
      ${s.progress != null ? `<div class="bar"><i style="width:${Math.round(s.progress * 100)}%"></i></div>` : ""}
      ${s.error ? `<p class="small" style="color:#A8674A">${esc(s.error)}</p>` : ""}
      <details class="card soft small"><summary><b>Which files work?</b></summary><ul class="list" style="margin-top:8px">
        <li><b>Fitbit dataset (Kaggle):</b> dailyActivity_merged.csv, sleepDay_merged.csv, minuteSleep_merged.csv</li>
        <li><b>Fitbit via Google Takeout:</b> sleep-*.json and steps-*.json</li>
        <li><b>Apple Health:</b> export.xml from Health › profile › Export All Health Data (unzip first)</li>
        <li><b>Lueur CSV:</b> columns date, sleep_minutes, bedtime, steps, places, mood, energy</li></ul>
        <button class="linkbtn" data-act="template">Get the CSV template</button></details>`;
  }
  if (s.type === "demo") {
    body = `<h2>Load demo data</h2><p class="small muted">This replaces what's stored now.</p>
      <div class="stack">${Object.entries(PERSONAS).map(([k, p]) => `<button class="card soft" data-act="demo" data-arg="${k}" style="text-align:left;font:inherit;color:inherit;cursor:pointer"><h3>${esc(p.label)}</h3><p class="small muted">${esc(p.blurb)}</p></button>`).join("")}<button class="card soft" data-act="demo" data-arg="real" style="text-align:left;font:inherit;color:inherit;cursor:pointer"><h3>A real person</h3><p class="small muted">Five months of one person's actual Fitbit sleep and steps, with their daily mood and fatigue ratings (PMData, Simula Research Lab, 2020).</p></button></div>`;
  }
  if (s.type === "wipe") {
    body = `<h2>Delete everything?</h2><p class="muted">This erases all days, check-ins, your trusted person and settings from this phone. It can't be undone.</p>
      <div class="row wrap"><button class="btn warm" data-act="wipeYes">Delete everything</button><button class="btn ghost" data-act="close">Keep my data</button></div>`;
  }
  return `<div class="scrim" data-act="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(s.type)}"><div class="grabber"></div><div class="stack-lg">${body}</div></div></div>`;
}

// ---------------- render ----------------
function render() {
  if (!S.settings.onboarded) { $app.innerHTML = onboarding() + sheetHTML(); return; }
  const screen = S.tab === "rhythm" ? rhythmScreen() : S.tab === "circle" ? circleScreen() : S.tab === "privacy" ? privacyScreen() : todayScreen();
  $app.innerHTML = screen + nav() + sheetHTML();
  if (S.sheet?.type === "breathe") runBreath();
}

let breathTimer = null;
function runBreath() {
  clearInterval(breathTimer);
  const phases = [["Breathe in", 1.6], ["Hold", 1.6], ["Breathe out", 1], ["Hold", 1]];
  let i = 0, cycles = 0;
  const step = () => {
    const core = document.getElementById("core"), lab = document.getElementById("blabel");
    if (!core || S.sheet?.type !== "breathe") return clearInterval(breathTimer);
    const [t, sc] = phases[i % 4];
    lab.textContent = cycles >= 4 ? "Well done" : t;
    core.style.transform = `scale(${sc})`;
    i++; if (i % 4 === 0) cycles++;
    if (cycles >= 4) clearInterval(breathTimer);
  };
  setTimeout(step, 300);
  breathTimer = setInterval(step, 4000);
}

// ---------------- actions ----------------
async function loadDemo(persona) {
  await clearDays();
  await putDays(generate(persona, 63, today()));
  const consent = { ...S.settings.consent, sleep: true, steps: true, places: true, checkin: true, agreedAt: S.settings.consent.agreedAt || new Date().toISOString() };
  await saveSettings({ onboarded: true, consent, dataLabel: `Demo: ${PERSONAS[persona].label}` });
  S.sheet = null; S.tab = "today";
  await refresh();
  toast("Demo loaded");
}

async function loadDataset() {
  const text = await (await fetch("data/pmdata-p01.csv")).text();
  const days = fromLueurCSV(parseCSV(text)).map(d => ({ ...d, source: "dataset" }));
  await clearDays();
  await putDays(days);
  const consent = { ...S.settings.consent, sleep: true, steps: true, checkin: true, agreedAt: S.settings.consent.agreedAt || new Date().toISOString() };
  await saveSettings({ onboarded: true, consent, dataLabel: "Real data: PMData participant 1 (Simula, CC BY-NC 4.0)" });
  S.sheet = null; S.tab = "today";
  await refresh();
  toast("Loaded 5 months of real Fitbit data");
}

async function handleFiles(files) {
  S.sheet.error = null;
  const csvs = [], jsons = [];
  let appleDays = null;
  try {
    for (const f of files) {
      if (/\.xml$/i.test(f.name)) {
        S.sheet.progress = 0; render();
        appleDays = await fromAppleHealth(f, p => { S.sheet.progress = p; const bar = document.querySelector(".sheet .bar i"); if (bar) bar.style.width = `${Math.round(p * 100)}%`; });
      } else if (/\.json$/i.test(f.name)) {
        jsons.push({ name: f.name, data: JSON.parse(await f.text()) });
      } else {
        const rows = parseCSV(await f.text());
        csvs.push({ name: f.name, rows, kind: detectFitbitKaggle(f.name, rows) });
      }
    }
  } catch (e) { S.sheet.error = `Couldn't read that file: ${e.message}`; S.sheet.progress = null; render(); return; }

  let days = [];
  if (appleDays) days = days.concat(appleDays);
  if (jsons.length) days = days.concat(fromFitbitTakeout(jsons));
  const lueur = csvs.filter(c => c.kind === "lueur");
  lueur.forEach(c => { days = days.concat(fromLueurCSV(c.rows)); });
  const fitbit = csvs.filter(c => c.kind && c.kind !== "lueur");
  const unknown = csvs.filter(c => !c.kind);
  if (unknown.length) { S.sheet.error = `Didn't recognise ${unknown.map(u => u.name).join(", ")}. See "Which files work?".`; }
  if (fitbit.length) {
    const ids = fitbitIds(fitbit);
    if (ids.length > 1) { S.sheet.pending = { fitbit, days }; S.sheet.ids = ids; S.sheet.progress = null; render(); return; }
    days = days.concat(fromFitbitKaggle(fitbit, ids[0]));
  }
  await finishImport(days, fitbit.length ? "Fitbit data" : appleDays ? "Apple Health data" : "Imported data");
}

async function finishImport(days, label) {
  if (!days.length) { S.sheet.error = S.sheet.error || "No usable days found in those files."; S.sheet.progress = null; render(); return; }
  await putDays(days);
  const has = k => days.some(d => d[k] != null);
  const consent = { ...S.settings.consent };
  if (has("sleepMin") && !consent.sleep) consent.sleep = true;
  if (has("steps") && !consent.steps) consent.steps = true;
  consent.agreedAt = consent.agreedAt || new Date().toISOString();
  await saveSettings({ onboarded: true, consent, dataLabel: label });
  S.sheet = null; S.tab = "today";
  await refresh();
  toast(`Imported ${days.length} days`);
}

function readTrustedForm() {
  const v = id => document.getElementById(id)?.value?.trim() ?? "";
  return { trusted: { name: v("f-tname"), contact: v("f-tcontact") }, name: v("f-name"), under25: !!document.getElementById("f-u25")?.checked };
}

async function act(name, arg, el, ev) {
  switch (name) {
    case "tab": S.tab = arg; S.sheet = null; render(); window.scrollTo({ top: 0 }); break;
    case "next": await saveSettings({ step: Math.min(4, (S.settings.step || 0) + 1) }); render(); window.scrollTo({ top: 0 }); break;
    case "back": await saveSettings({ step: Math.max(0, (S.settings.step || 0) - 1) }); render(); break;
    case "consent": {
      const consent = { ...S.settings.consent, [arg]: el.checked };
      await saveSettings({ consent });
      if (arg === "places") el.checked ? startPlaces(() => refresh({ regenerate: false })) : stopPlaces();
      if (S.settings.onboarded) await refresh(); else render();
      break;
    }
    case "agree": await saveSettings({ consent: { ...S.settings.consent, agreedAt: el.checked ? new Date().toISOString() : null } }); render(); break;
    case "saveTrusted": await saveSettings(readTrustedForm()); if (arg === "next") await act("next"); else { S.sheet = null; render(); toast("Saved"); } break;
    case "fresh": await saveSettings({ onboarded: true, dataLabel: null, consent: { ...S.settings.consent, checkin: true } }); await refresh(); if (S.settings.consent.places) startPlaces(() => refresh({ regenerate: false })); S.sheet = { type: "checkin", draft: {} }; render(); break;
    case "demo": if (arg === "real") await loadDataset(); else if (arg) await loadDemo(arg); else { S.sheet = { type: "demo" }; render(); } break;
    case "import": S.sheet = { type: "import" }; render(); break;
    case "files": if (el.files?.length) await handleFiles([...el.files]); break;
    case "pickId": { const id = document.getElementById("pick-id").value; const p = S.sheet.pending; await finishImport(p.days.concat(fromFitbitKaggle(p.fitbit, id)), "Fitbit data"); break; }
    case "template": { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([TEMPLATE_CSV], { type: "text/csv" })); a.download = "lueur-template.csv"; a.click(); break; }
    case "help": case "why": case "breathe": case "pros": case "editTrusted": case "wipe": S.sheet = { type: name }; render(); break;
    case "checkin": { const td = S.days.find(d => d.date === today()) || {}; S.sheet = { type: "checkin", draft: { mood: td.mood, energy: td.energy } }; render(); break; }
    case "pick": { const [k, v] = arg.split(":"); S.sheet.draft[k] = +v; render(); break; }
    case "saveCheckin": await upsertDay(today(), { mood: S.sheet.draft.mood, energy: S.sheet.draft.energy }); S.sheet = null; await refresh(); toast("Thank you"); break;
    case "tag": {
      const d = await getDay(today()); const tags = new Set(d.tags || []);
      tags.has(arg) ? tags.delete(arg) : tags.add(arg);
      await upsertDay(today(), { tags: [...tags] }); await refresh({ regenerate: false }); break;
    }
    case "goal": { const done = { ...S.settings.goalsDone }; const t = today(); done[t] = [...new Set([...(done[t] || []), arg])]; await saveSettings({ goalsDone: done }); render(); toast("Nice. That counts."); break; }
    case "snooze": await saveSettings({ snoozeUntil: addDays(today(), 3) }); render(); toast("Okay. Lueur will check in again in a few days."); break;
    case "share": S.sheet = { type: "share", arg }; render(); break;
    case "doShare": {
      const text = document.getElementById("share-text").value;
      if (navigator.share) { try { await navigator.share({ title: "My Lueur summary", text }); } catch {} }
      else { await copy(text); }
      break;
    }
    case "copyShare": await copy(document.getElementById("share-text").value); break;
    case "loadModel": {
      S.modelProgress = 0; render();
      try {
        await loadModel(arg, p => { S.modelProgress = p; const bar = document.querySelector(".bar i"); if (bar) bar.style.width = `${Math.round(p * 100)}%`; });
        await saveSettings({ consent: { ...S.settings.consent, model: arg } });
        S.modelProgress = null; toast("On-device AI ready"); await refresh();
      } catch (e) { S.modelProgress = null; render(); toast(e.message.slice(0, 120)); }
      break;
    }
    case "export": {
      const data = await exportAll();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      a.download = `lueur-export-${today()}.json`; a.click(); break;
    }
    case "wipeYes": stopPlaces(); await wipeAll(); S.settings = structuredClone(DEFAULTS); S.days = []; S.sheet = null; S.tab = "today"; await kv.set("settings", S.settings); render(); toast("Everything deleted"); break;
    case "close": S.sheet = null; render(); break;
    case "scrim": if (ev.target === el) { S.sheet = null; render(); } break;
  }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); }
  catch { const t = document.getElementById("share-text"); if (t) { t.select(); } toast("Select and copy the text"); }
}

document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]");
  if (!el || el.tagName === "INPUT") return;
  act(el.dataset.act, el.dataset.arg, el, e);
});
document.addEventListener("change", e => {
  const el = e.target.closest("input[data-act]");
  if (el) act(el.dataset.act, el.dataset.arg, el, e);
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && S.sheet) { S.sheet = null; render(); } });

// ---------------- boot ----------------
(async function boot() {
  S.settings = { ...structuredClone(DEFAULTS), ...((await kv.get("settings")) || {}) };
  S.settings.consent = { ...DEFAULTS.consent, ...S.settings.consent };
  try { await prune(); } catch {}
  await refresh();
  if (S.settings.onboarded && S.settings.consent.places) startPlaces(() => refresh({ regenerate: false }));
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
