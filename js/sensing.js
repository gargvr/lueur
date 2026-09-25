// Places, counted with data minimisation in mind.
// A web page can only read location while it is open, so this is a light, optional signal.
// Coordinates are rounded to a ~110 m cell, hashed with a random per-install salt, and only
// the hash is kept. The raw position is discarded immediately. Lueur can count "how many
// different places today", but cannot say where any of them are.
import { kv, getDay, upsertDay } from "./store.js";
import { isoDate } from "./engine.js";

async function salt() {
  let s = await kv.get("placeSalt");
  if (!s) { s = crypto.getRandomValues(new Uint32Array(4)).join("-"); await kv.set("placeSalt", s); }
  return s;
}

async function cellHash(lat, lon) {
  const key = `${await salt()}:${lat.toFixed(3)}:${lon.toFixed(3)}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(buf)].slice(0, 6).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function samplePlace() {
  return new Promise(resolve => {
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(async pos => {
      try {
        const h = await cellHash(pos.coords.latitude, pos.coords.longitude);
        const today = isoDate(new Date());
        const day = await getDay(today);
        const cells = new Set(day.cells || []);
        cells.add(h);
        await upsertDay(today, { cells: [...cells], places: cells.size });
        resolve(cells.size);
      } catch { resolve(null); }
    }, () => resolve(null), { enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout: 15000 });
  });
}

let timer = null;
export function startPlaces(onUpdate) {
  stopPlaces();
  const tick = async () => { if (document.visibilityState === "visible") { const n = await samplePlace(); if (n != null) onUpdate && onUpdate(n); } };
  tick();
  timer = setInterval(tick, 10 * 60 * 1000);
  document.addEventListener("visibilitychange", tick);
  startPlaces._tick = tick;
}
export function stopPlaces() {
  if (timer) clearInterval(timer);
  timer = null;
  if (startPlaces._tick) document.removeEventListener("visibilitychange", startPlaces._tick);
}
