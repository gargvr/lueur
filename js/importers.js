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
