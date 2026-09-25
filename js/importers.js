// Importers run entirely in the browser. Files are read from the device and never uploaded.
import { clockToOnset, isoDate } from "./engine.js";

// ---------- CSV ----------
export function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  const keys = head.map(h => h.trim());
  return body.map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

// "4/12/2016" or "4/12/2016 2:47:30 AM" -> { date: "2016-04-12", mins: minutes since midnight }
function parseUSDateTime(s) {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
  if (!m) return null;
  let [, mo, d, y, h, mi, , ap] = m;
  if (y.length === 2) y = "20" + y;
  let hh = h ? +h : 0;
  if (ap) { ap = ap.toUpperCase(); if (ap === "PM" && hh < 12) hh += 12; if (ap === "AM" && hh === 12) hh = 0; }
  return { date: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`, mins: hh * 60 + (mi ? +mi : 0) };
}
// Apple / ISO-ish "2024-03-01 23:12:00 +0100" -> wall-clock parts (the time the person lived)
function parseWall(s) {
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  return m ? { date: m[1], mins: +m[2] * 60 + +m[3] } : null;
}
const nextDate = iso => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + 1); return isoDate(d); };
// A night belongs to the morning you wake up in. Onset is minutes after noon of the previous day.
function onsetFrom(start, wakeDate) {
  // after midnight (same date as waking): 01:00 -> 780; evening before: 23:30 -> 690
  return start.date === wakeDate ? start.mins + 12 * 60 : start.mins - 12 * 60;
}

// ---------- 1. Kaggle "Fitbit Fitness Tracker Data" (Möbius, CC0) ----------
// dailyActivity_merged.csv: Id, ActivityDate, TotalSteps, ... SedentaryMinutes, Calories
// sleepDay_merged.csv:      Id, SleepDay, TotalSleepRecords, TotalMinutesAsleep, TotalTimeInBed
// minuteSleep_merged.csv:   Id, date, value, logId   (optional, gives bedtime)
export function detectFitbitKaggle(name, rows) {
  const k = rows[0] ? Object.keys(rows[0]) : [];
  if (k.includes("ActivityDate") && k.includes("TotalSteps")) return "activity";
  if (k.includes("SleepDay") && k.includes("TotalMinutesAsleep")) return "sleepDay";
  if (k.includes("logId") && k.includes("value") && k.includes("date")) return "minuteSleep";
  if (k.includes("date") && (k.includes("sleep_minutes") || k.includes("steps") || k.includes("mood"))) return "lueur";
  return null;
}

export function fitbitIds(files) {
  const ids = new Set();
  for (const f of files) for (const r of f.rows) if (r.Id) ids.add(r.Id);
  return [...ids];
}

export function fromFitbitKaggle(files, id) {
  const days = new Map();
  const get = d => { if (!days.has(d)) days.set(d, { date: d, source: "fitbit" }); return days.get(d); };
  for (const f of files) {
    const rows = f.rows.filter(r => !id || r.Id === id);
    if (f.kind === "activity") for (const r of rows) {
      const t = parseUSDateTime(r.ActivityDate); if (!t) continue;
      const steps = +r.TotalSteps;
      if (steps > 0) get(t.date).steps = steps; // 0 steps = watch not worn
    }
    if (f.kind === "sleepDay") for (const r of rows) {
      const t = parseUSDateTime(r.SleepDay); if (!t) continue;
      get(t.date).sleepMin = +r.TotalMinutesAsleep;
    }
    if (f.kind === "minuteSleep") {
      const logs = new Map();
      const key = t => t.date + String(t.mins).padStart(4, "0");
      for (const r of rows) {
        const t = parseUSDateTime(r.date); if (!t) continue;
        const L = logs.get(r.logId) || { first: t, last: t };
        if (key(t) < key(L.first)) L.first = t;
        if (key(t) > key(L.last)) L.last = t;
        logs.set(r.logId, L);
      }
      for (const L of logs.values()) {
        const wake = L.last.date; // Fitbit files a night under the date you wake up
        const on = onsetFrom(L.first, wake);
        if (on < 0 || on > 20 * 60) continue; // skip daytime naps
        const d = get(wake);
        if (d.onset == null || on < d.onset) d.onset = on;
      }
    }
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- 2. Lueur template CSV ----------
// date, sleep_minutes, bedtime (HH:MM), steps, places, mood (1-5), energy (1-5)
export function fromLueurCSV(rows) {
  return rows.map(r => {
    const d = { date: r.date, source: "csv" };
    if (r.sleep_minutes) d.sleepMin = +r.sleep_minutes;
    if (r.bedtime) d.onset = clockToOnset(r.bedtime);
    if (r.steps) d.steps = +r.steps;
    if (r.places) d.places = +r.places;
    if (r.mood) d.mood = +r.mood;
    if (r.energy) d.energy = +r.energy;
    return d;
  }).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date));
}

// ---------- 3. Google / Fitbit Takeout JSON ----------
// sleep-YYYY-MM-DD.json: [{ dateOfSleep, startTime, endTime, minutesAsleep, mainSleep }]
// steps-YYYY-MM-DD.json: [{ dateTime: "03/01/24 08:15:00", value: "12" }]
export function fromFitbitTakeout(jsonFiles) {
  const days = new Map();
  const get = d => { if (!days.has(d)) days.set(d, { date: d, source: "fitbit" }); return days.get(d); };
  for (const { name, data } of jsonFiles) {
    if (!Array.isArray(data)) continue;
    if (/sleep/i.test(name)) for (const s of data) {
      if (s.mainSleep === false || !s.dateOfSleep) continue;
      const day = get(s.dateOfSleep);
      day.sleepMin = (day.sleepMin || 0) + (+s.minutesAsleep || 0);
      const st = parseWall(String(s.startTime).replace("T", " "));
      if (st) { const on = onsetFrom(st, s.dateOfSleep); if (on >= 0 && on <= 20 * 60) day.onset = on; }
    }
    if (/steps/i.test(name)) for (const p of data) {
      const t = parseUSDateTime(String(p.dateTime)); if (!t) continue;
      const day = get(t.date); day.steps = (day.steps || 0) + (+p.value || 0);
    }
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- 4. Apple Health export.xml (streamed; these files are often hundreds of MB) ----------
export async function fromAppleHealth(file, onProgress) {
  const steps = new Map();
  const sleep = new Map(); // wakeDate -> [[startAbsMin, endAbsMin]]
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let buf = "", read = 0;
  const attr = (tag, a) => { const m = tag.match(new RegExp(`${a}="([^"]*)"`)); return m ? m[1] : null; };
  const abs = w => Date.parse(w.date + "T00:00:00Z") / 60000 + w.mins;
  const handle = tag => {
    const type = attr(tag, "type");
    if (type === "HKQuantityTypeIdentifierStepCount") {
      const s = parseWall(attr(tag, "startDate") || ""); if (!s) return;
      steps.set(s.date, (steps.get(s.date) || 0) + (+attr(tag, "value") || 0));
    } else if (type === "HKCategoryTypeIdentifierSleepAnalysis") {
      const v = attr(tag, "value") || "";
      if (!/Asleep/.test(v)) return; // ignore InBed and Awake
      const s = parseWall(attr(tag, "startDate") || ""), e = parseWall(attr(tag, "endDate") || "");
      if (!s || !e) return;
      const wake = e.mins < 16 * 60 ? e.date : nextDate(e.date);
      if (!sleep.has(wake)) sleep.set(wake, []);
      sleep.get(wake).push([abs(s), abs(e), s]);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    read += value.length; buf += value;
    let i;
    while ((i = buf.indexOf("<Record ")) !== -1) {
      const j = buf.indexOf(">", i);
      if (j === -1) break;
      handle(buf.slice(i, j + 1));
      buf = buf.slice(j + 1);
    }
    if (buf.length > 1e6) buf = buf.slice(-2000);
    onProgress && onProgress(Math.min(0.99, read / file.size));
  }
  const days = new Map();
  const get = d => { if (!days.has(d)) days.set(d, { date: d, source: "apple" }); return days.get(d); };
  for (const [d, n] of steps) if (n > 0) get(d).steps = Math.round(n);
  for (const [wake, segs] of sleep) {
    // several devices can log the same night: merge overlapping intervals before summing
    segs.sort((a, b) => a[0] - b[0]);
    let total = 0, cur = null;
    for (const [s, e] of segs) {
      if (!cur || s > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [s, e]; } else cur[1] = Math.max(cur[1], e);
    }
    if (cur) total += cur[1] - cur[0];
    const day = get(wake);
    day.sleepMin = Math.round(total);
    const on = onsetFrom(segs[0][2], wake);
    if (on >= 0 && on <= 20 * 60) day.onset = on;
  }
  onProgress && onProgress(1);
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export const TEMPLATE_CSV = "date,sleep_minutes,bedtime,steps,places,mood,energy\n2026-09-01,440,23:20,8200,3,4,4\n";

// ---------- 5. Google Maps Timeline export (past places) ----------
// Handles the on-device exports (Android: { semanticSegments: [...] }, iPhone: a bare array)
// and the older Takeout files (Semantic Location History "timelineObjects", Records.json).
// Everything is reduced here, on the phone, to three numbers a day (places, % of the day at
// home, range in km); coordinates are never stored.
const DAY_MS = 86400000;
const wall = s => { const m = String(s).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/); return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4] || "00"}Z`) : NaN; };
function latLngOf(v) {
  if (v == null) return null;
  if (typeof v === "object") {
    if (v.latitudeE7 != null) return [v.latitudeE7 / 1e7, v.longitudeE7 / 1e7];
    if (v.latLng) return latLngOf(v.latLng);
    if (v.latitude != null) return [+v.latitude, +v.longitude];
  }
  const m = String(v).replace(/^geo:/, "").match(/(-?\d+(?:\.\d+)?)°?\s*,\s*(-?\d+(?:\.\d+)?)/);
  return m ? [+m[1], +m[2]] : null;
}

export function isTimeline(data) {
  const arr = Array.isArray(data) ? data : data?.semanticSegments || data?.timelineObjects || data?.locations;
  if (!Array.isArray(arr) || !arr.length) return false;
  const x = arr.find(o => o && typeof o === "object") || {};
  return !!(x.visit || x.activity || x.timelinePath || x.placeVisit || x.activitySegment || x.latitudeE7 != null);
}

export function fromTimeline(files) {
  const visits = [];   // { a, b, ll, home }
  const points = [];   // { t, ll }
  for (const data of files) {
    if (data?.locations) {                                     // Records.json
      for (const r of data.locations) {
        const t = r.timestamp ? wall(r.timestamp) : +r.timestampMs + 0;
        const ll = latLngOf(r); if (ll && !isNaN(t)) points.push({ t, ll });
      }
      continue;
    }
    const segs = Array.isArray(data) ? data : data?.semanticSegments || data?.timelineObjects || [];
    for (const s of segs) {
      if (s.placeVisit) {                                      // legacy Semantic Location History
        const pv = s.placeVisit, ll = latLngOf(pv.location);
        const a = wall(pv.duration?.startTimestamp), b = wall(pv.duration?.endTimestamp);
        if (ll && a < b) visits.push({ a, b, ll, home: /HOME/i.test(pv.location?.semanticType || "") });
        continue;
      }
      const a = wall(s.startTime), b = wall(s.endTime);
      if (s.visit) {
        const tc = s.visit.topCandidate || {};
        const ll = latLngOf(tc.placeLocation || tc.placeLocation?.latLng);
        if (ll && a < b) visits.push({ a, b, ll, home: /HOME/i.test(tc.semanticType || "") });
      }
      for (const p of s.timelinePath || []) {
        const ll = latLngOf(p.point); const t = wall(p.time);
        if (ll && !isNaN(t)) points.push({ t, ll });
      }
    }
  }
  if (!visits.length && !points.length) return [];

  // Home: Google's own label if present, otherwise the spot most often occupied at 03:00.
  const cellOf = ll => `${ll[0].toFixed(3)},${ll[1].toFixed(3)}`;
  let homeCells = new Set(visits.filter(v => v.home).map(v => cellOf(v.ll)));
  if (!homeCells.size) {
    const votes = new Map();
    for (const v of visits) for (let d = Math.floor(v.a / DAY_MS); d <= Math.floor(v.b / DAY_MS); d++) {
      const three = d * DAY_MS + 3 * 3600000; if (v.a <= three && v.b >= three) votes.set(cellOf(v.ll), (votes.get(cellOf(v.ll)) || 0) + 1);
    }
    const best = [...votes].sort((x, y) => y[1] - x[1])[0]; if (best) homeCells = new Set([best[0]]);
  }

  const days = new Map();
  const get = d => { if (!days.has(d)) days.set(d, { cells: new Set(), home: 0, pts: [] }); return days.get(d); };
  const key = d => new Date(d * DAY_MS).toISOString().slice(0, 10);
  for (const v of visits) {
    for (let d = Math.floor(v.a / DAY_MS); d <= Math.floor((v.b - 1) / DAY_MS); d++) {
      const day = get(key(d));
      day.cells.add(cellOf(v.ll)); day.pts.push(v.ll);
      if (homeCells.has(cellOf(v.ll))) day.home += Math.min(v.b, (d + 1) * DAY_MS) - Math.max(v.a, d * DAY_MS);
    }
  }
  for (const p of points) get(key(Math.floor(p.t / DAY_MS))).pts.push(p.ll);

  const out = [];
  for (const [date, d] of days) {
    if (d.pts.length < 2 && !d.cells.size) continue;
    const mLat = d.pts.reduce((s, p) => s + p[0], 0) / d.pts.length, mLon = d.pts.reduce((s, p) => s + p[1], 0) / d.pts.length;
    const kx = 111.32 * Math.cos(mLat * Math.PI / 180);
    const rg = Math.sqrt(d.pts.reduce((s, p) => s + ((p[1] - mLon) * kx) ** 2 + ((p[0] - mLat) * 110.57) ** 2, 0) / d.pts.length);
    const row = { date, source: "timeline", rangeKm: Math.round(rg * 10) / 10 };
    if (d.cells.size) row.places = d.cells.size;
    if (homeCells.size && d.cells.size) row.homeStay = Math.min(100, Math.round(100 * d.home / DAY_MS));
    out.push(row);
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  out.pop(); // the export's last day is only partly covered; keeping it would look like a shift
  return out;
}
