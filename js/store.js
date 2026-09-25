// Local-only storage. IndexedDB lives inside this browser profile on this device.
// There is no server, no account and no sync: nothing here is ever transmitted.
const DB_NAME = "lueur";
const DB_VER = 1;
let dbp;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("days")) d.createObjectStore("days", { keyPath: "date" });
        if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx(store, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  }));
}
const req2p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const kv = {
  get: key => db().then(d => req2p(d.transaction("kv").objectStore("kv").get(key))),
  set: (key, val) => tx("kv", "readwrite", s => { s.put(val, key); }),
  del: key => tx("kv", "readwrite", s => { s.delete(key); }),
};

export async function allDays() {
  const d = await db();
  const rows = await req2p(d.transaction("days").objectStore("days").getAll());
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function getDay(date) {
  const d = await db();
  return (await req2p(d.transaction("days").objectStore("days").get(date))) || { date };
}

// Merge fields into a day, keeping anything already recorded from other sources.
export async function upsertDay(date, fields) {
  const cur = await getDay(date);
  const next = { ...cur, ...fields, date };
  await tx("days", "readwrite", s => { s.put(next); });
  return next;
}

export async function putDays(list) {
  const d = await db();
  const existing = new Map((await req2p(d.transaction("days").objectStore("days").getAll())).map(r => [r.date, r]));
  await tx("days", "readwrite", s => {
    for (const row of list) s.put({ ...(existing.get(row.date) || {}), ...row });
  });
}

export async function clearDays() {
  await tx("days", "readwrite", s => { s.clear(); });
}

// "Delete everything" really deletes everything, including the database itself.
export async function wipeAll() {
  try { (await db()).close(); } catch {}
  dbp = null;
  await new Promise(res => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = r.onerror = r.onblocked = () => res();
  });
  try { localStorage.clear(); } catch {}
  // also remove the downloaded AI model and any other cached files
  try { if (window.caches) for (const k of await caches.keys()) await caches.delete(k); } catch {}
  try { if (indexedDB.databases) for (const d of await indexedDB.databases()) if (d.name) indexedDB.deleteDatabase(d.name); } catch {}
}

export async function exportAll() {
  const d = await db();
  const days = await req2p(d.transaction("days").objectStore("days").getAll());
  const keys = await req2p(d.transaction("kv").objectStore("kv").getAllKeys());
  const vals = await req2p(d.transaction("kv").objectStore("kv").getAll());
  const settings = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
  return { exportedAt: new Date().toISOString(), app: "Lueur", days, settings };
}

// Storage limitation: keep about six months. The engine only ever needs the last six weeks.
export const RETENTION_DAYS = 183;
// Counted back from the newest stored day, so an imported history isn't wiped on arrival.
export async function prune() {
  const days = await allDays();
  if (!days.length) return 0;
  const cutoff = new Date(days[days.length - 1].date + "T12:00:00"); cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const c = cutoff.toISOString().slice(0, 10);
  const old = days.filter(d => d.date < c);
  if (old.length) await tx("days", "readwrite", s => { for (const d of old) s.delete(d.date); });
  return old.length;
}
