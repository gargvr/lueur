// Native bridge (Android app only). In a normal browser every call is a no-op and isNative is false.
const X = window.capacitorExports;
const C = X?.Capacitor || window.Capacitor;
export const isNative = !!(C && C.isNativePlatform && C.isNativePlatform());
export const platform = isNative ? C.getPlatform() : "web";
const P = isNative && X ? X.registerPlugin("LueurHealth") : null;

const safe = fn => async (...a) => { if (!P) return null; try { return await fn(...a); } catch (e) { console.warn("LueurHealth", e); return null; } };

export const native = {
  status: safe(() => P.status()),
  requestHealth: safe(() => P.requestHealth()),
  openUsageAccess: safe(() => P.openUsageAccess()),
  requestActivity: safe(() => P.requestActivity()),
  requestNotifications: safe(() => P.requestNotifications()),
  setPrefs: safe(prefs => P.setPrefs(prefs)),
  previewNotification: safe(() => P.previewNotification()),
  wipe: safe(() => P.wipe()),
  debugSeed: safe(() => P.debugSeed()),
  requestLocation: safe(() => P.requestLocation()),
  openTimeline: safe(() => P.openTimeline()),
  // Returns Lueur-shaped days: { date, steps, sleepMin, onset, source }
  sync: safe(async (days = 60) => {
    const r = await P.sync({ days });
    return (r?.days || []).map(d => {
      const out = { date: d.date };
      if (d.steps != null) out.steps = d.steps;
      if (d.sleepMin != null) out.sleepMin = d.sleepMin;
      if (d.onset != null) out.onset = d.onset;
      for (const k of ["restingHR", "hrv", "daylight", "exercise", "moodHealth", "places", "homeStay", "rangeKm"]) if (d[k] != null) out[k] = d[k];
      out.sleepSrc = d.sleepSrc; out.stepsSrc = d.stepsSrc;
      out.source = platform === "ios" ? "apple_health" : d.sleepSrc === "health_connect" || d.stepsSrc === "health_connect" ? "health_connect" : "phone";
      return out;
    });
  }),
};
