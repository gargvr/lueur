package ch.lueur.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import androidx.core.content.ContextCompat
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.time.LocalDate
import java.time.LocalTime
import kotlin.coroutines.resume
import kotlin.math.cos
import kotlin.math.sqrt

/**
 * Location, reduced to three numbers a day (Saeb et al. 2015/2016 used the same kind of features):
 *   places    distinct ~150 m spots visited
 *   homeStay  share of samples spent at home (%)
 *   rangeKm   radius of gyration: how far from your centre of the day you ranged
 *
 * Samples are kept, coarsened to ~110 m, for the current day only. When the day changes they are
 * reduced to the three numbers above and the coordinates are deleted. "Home" is stored only as a
 * salted hash of a coarse cell, so the app can tell "at home or not" but never where home is.
 */
object LocationDay {
    private fun file(ctx: Context) = File(ctx.filesDir, "loc_today.json")
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("lueur", Context.MODE_PRIVATE)

    fun hasPermission(ctx: Context, background: Boolean = true): Boolean {
        val fg = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!background || Build.VERSION.SDK_INT < 29) return fg
        return fg && ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED
    }

    private fun salt(ctx: Context): String {
        val p = prefs(ctx)
        return p.getString("locSalt", null) ?: java.util.UUID.randomUUID().toString().also { p.edit().putString("locSalt", it).apply() }
    }

    private fun cellHash(ctx: Context, lat: Double, lon: Double): String {
        val key = "${salt(ctx)}:${"%.3f".format(lat)}:${"%.3f".format(lon)}"
        return MessageDigest.getInstance("SHA-256").digest(key.toByteArray()).take(6).joinToString("") { "%02x".format(it) }
    }

    /** Called about hourly by DailyWorker. */
    suspend fun sample(ctx: Context) {
        if (!hasPermission(ctx)) return
        val loc = current(ctx) ?: return
        val today = LocalDate.now().toString()
        val f = file(ctx)
        var j = if (f.exists()) runCatching { JSONObject(f.readText()) }.getOrNull() else null
        if (j != null && j.optString("date") != today) { finish(ctx, j); j = null }
        if (j == null) j = JSONObject().put("date", today).put("s", JSONArray())
        val lat = Math.round(loc.latitude * 1000) / 1000.0
        val lon = Math.round(loc.longitude * 1000) / 1000.0
        val hour = LocalTime.now().hour
        j.getJSONArray("s").put(JSONObject().put("lat", lat).put("lon", lon).put("h", hour).put("c", cellHash(ctx, lat, lon)))
        f.writeText(j.toString())
    }

    /** Reduce a finished day to three numbers, store them, delete the coordinates. */
    private fun finish(ctx: Context, j: JSONObject) {
        val s = j.getJSONArray("s")
        if (s.length() >= 4) {
            val cells = mutableListOf<String>(); val lats = mutableListOf<Double>(); val lons = mutableListOf<Double>()
            val night = mutableListOf<String>()
            for (i in 0 until s.length()) {
                val o = s.getJSONObject(i)
                cells += o.getString("c"); lats += o.getDouble("lat"); lons += o.getDouble("lon")
                val h = o.getInt("h"); if (h < 6 || h >= 22) night += o.getString("c")
            }
            // home = the cell seen most often at night, remembered across days (hash only)
            val p = prefs(ctx)
            val counts = JSONObject(p.getString("homeVotes", "{}")!!)
            for (c in night) counts.put(c, counts.optInt(c) + 1)
            p.edit().putString("homeVotes", counts.toString()).apply()
            val home = counts.keys().asSequence().maxByOrNull { counts.getInt(it) }
            val mLat = lats.average(); val mLon = lons.average()
            val kx = 111.32 * cos(Math.toRadians(mLat)); val ky = 110.57
            val rg = sqrt(lats.indices.sumOf { val dx = (lons[it] - mLon) * kx; val dy = (lats[it] - mLat) * ky; dx * dx + dy * dy } / lats.size)
            val days = Collector.load(ctx)
            val d = days.getOrPut(j.getString("date")) { Day() }
            d.places = cells.toSet().size
            d.homeStay = if (home != null) Math.round(100.0 * cells.count { it == home } / cells.size).toInt() else null
            d.rangeKm = Math.round(rg * 10) / 10.0
            Collector.save(ctx, days)
        }
        file(ctx).delete()
    }

    fun wipe(ctx: Context) { file(ctx).delete(); prefs(ctx).edit().remove("homeVotes").remove("locSalt").apply() }

    @Suppress("MissingPermission")
    private suspend fun current(ctx: Context): Location? {
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val provider = listOf(LocationManager.NETWORK_PROVIDER, LocationManager.FUSED_PROVIDER, LocationManager.GPS_PROVIDER)
            .firstOrNull { runCatching { lm.isProviderEnabled(it) }.getOrDefault(false) } ?: return null
        if (Build.VERSION.SDK_INT >= 30) {
            val fresh = withTimeoutOrNull(20_000) {
                suspendCancellableCoroutine<Location?> { cont ->
                    lm.getCurrentLocation(provider, null, ctx.mainExecutor) { if (cont.isActive) cont.resume(it) }
                }
            }
            if (fresh != null) return fresh
        }
        return runCatching { lm.getLastKnownLocation(provider) }.getOrNull()
    }
}
