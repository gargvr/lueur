package ch.lueur.app

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Process
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.Period
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit
import kotlin.coroutines.resume

/**
 * Everything Lueur collects, in one place. All of it stays in this app's private storage.
 *
 * A day is keyed by the date you wake up on. Bedtime ("onset") is stored as minutes after
 * noon of the previous day, the same convention as engine.js (23:30 -> 690, 01:00 -> 780).
 */
data class Day(
    var steps: Long? = null, var stepsSrc: String? = null,
    var sleepMin: Int? = null, var onset: Int? = null, var sleepSrc: String? = null,
    var nightUnlocks: Int? = null,
    var places: Int? = null, var homeStay: Int? = null, var rangeKm: Double? = null,
)

object Collector {
    val HC_PERMISSIONS = setOf(
        HealthPermission.getReadPermission(StepsRecord::class),
        HealthPermission.getReadPermission(SleepSessionRecord::class),
    )
    const val HISTORY_PERMISSION = "android.permission.health.READ_HEALTH_DATA_HISTORY"

    private fun store(ctx: Context) = File(ctx.filesDir, "lueur_days.json")
    private val zone: ZoneId get() = ZoneId.systemDefault()

    fun load(ctx: Context): MutableMap<String, Day> {
        val out = sortedMapOf<String, Day>()
        val f = store(ctx)
        if (!f.exists()) return out
        runCatching {
            val j = JSONObject(f.readText())
            for (k in j.keys()) {
                val o = j.getJSONObject(k)
                out[k] = Day(
                    steps = if (o.has("steps")) o.getLong("steps") else null, stepsSrc = o.optString("stepsSrc", null),
                    sleepMin = if (o.has("sleepMin")) o.getInt("sleepMin") else null,
                    onset = if (o.has("onset")) o.getInt("onset") else null, sleepSrc = o.optString("sleepSrc", null),
                    nightUnlocks = if (o.has("nightUnlocks")) o.getInt("nightUnlocks") else null,
                    places = if (o.has("places")) o.getInt("places") else null,
                    homeStay = if (o.has("homeStay")) o.getInt("homeStay") else null,
                    rangeKm = if (o.has("rangeKm")) o.getDouble("rangeKm") else null,
                )
            }
        }
        return out
    }

    fun save(ctx: Context, days: Map<String, Day>) {
        val j = JSONObject()
        // storage limitation: keep the most recent ~6 months only
        val keep = days.keys.sorted().takeLast(183).toSet()
        for ((k, d) in days) if (k in keep) j.put(k, toJson(d))
        store(ctx).writeText(j.toString())
    }

    fun wipe(ctx: Context) {
        store(ctx).delete()
        ctx.getSharedPreferences("lueur", Context.MODE_PRIVATE).edit().clear().apply()
    }

    fun toJson(d: Day): JSONObject = JSONObject().apply {
        d.steps?.let { put("steps", it) }; d.stepsSrc?.let { put("stepsSrc", it) }
        d.sleepMin?.let { put("sleepMin", it) }; d.onset?.let { put("onset", it) }; d.sleepSrc?.let { put("sleepSrc", it) }
        d.nightUnlocks?.let { put("nightUnlocks", it) }
        d.places?.let { put("places", it) }; d.homeStay?.let { put("homeStay", it) }; d.rangeKm?.let { put("rangeKm", it) }
    }

    // ---------- availability ----------
    fun hcStatus(ctx: Context): String = when (HealthConnectClient.getSdkStatus(ctx)) {
        HealthConnectClient.SDK_AVAILABLE -> "available"
        HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "update_required"
        else -> "unavailable"
    }

    suspend fun hcGranted(ctx: Context): Set<String> =
        if (hcStatus(ctx) != "available") emptySet()
        else runCatching { HealthConnectClient.getOrCreate(ctx).permissionController.getGrantedPermissions() }.getOrDefault(emptySet())

    fun hasUsageAccess(ctx: Context): Boolean {
        val ops = ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName)
        return mode == AppOpsManager.MODE_ALLOWED
    }

    // ---------- the one entry point used by the app and the background worker ----------
    suspend fun collect(ctx: Context, daysBack: Int): Map<String, Day> {
        val days = load(ctx)
        val granted = hcGranted(ctx)
        if (granted.contains(HealthPermission.getReadPermission(StepsRecord::class))) runCatching { readHcSteps(ctx, daysBack, days) }
        if (granted.contains(HealthPermission.getReadPermission(SleepSessionRecord::class))) runCatching { readHcSleep(ctx, daysBack, days) }
        if (hasUsageAccess(ctx)) runCatching { readPhoneNights(ctx, days) }
        save(ctx, days)
        return days
    }

    // ---------- Health Connect: any band or health app that writes there ----------
    private suspend fun readHcSteps(ctx: Context, daysBack: Int, days: MutableMap<String, Day>) {
        val client = HealthConnectClient.getOrCreate(ctx)
        val end = LocalDate.now().plusDays(1).atStartOfDay()
        val start = LocalDate.now().minusDays(daysBack.toLong()).atStartOfDay()
        val groups = client.aggregateGroupByPeriod(
            AggregateGroupByPeriodRequest(
                metrics = setOf(StepsRecord.COUNT_TOTAL),
                timeRangeFilter = TimeRangeFilter.between(start, end),
                timeRangeSlicer = Period.ofDays(1),
            )
        )
        for (g in groups) {
            val n = g.result[StepsRecord.COUNT_TOTAL] ?: continue
            if (n <= 0) continue
            val d = days.getOrPut(g.startTime.toLocalDate().toString()) { Day() }
            d.steps = n; d.stepsSrc = "health_connect"
        }
    }

    private suspend fun readHcSleep(ctx: Context, daysBack: Int, days: MutableMap<String, Day>) {
        val client = HealthConnectClient.getOrCreate(ctx)
        val filter = TimeRangeFilter.between(Instant.now().minus(daysBack.toLong(), ChronoUnit.DAYS), Instant.now())
        val byWake = mutableMapOf<String, MutableList<SleepSessionRecord>>()
        var token: String? = null
        do {
            val resp = client.readRecords(ReadRecordsRequest(SleepSessionRecord::class, filter, pageToken = token))
            for (s in resp.records) {
                val endLocal = s.endTime.atZone(zone)
                val minutes = Duration(s.startTime, s.endTime)
                if (minutes < 60) continue                       // naps don't count
                val wake = if (endLocal.hour < 16) endLocal.toLocalDate() else endLocal.toLocalDate().plusDays(1)
                byWake.getOrPut(wake.toString()) { mutableListOf() }.add(s)
            }
            token = resp.pageToken
        } while (!token.isNullOrEmpty())
        val awake = setOf(SleepSessionRecord.STAGE_TYPE_AWAKE, SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED, SleepSessionRecord.STAGE_TYPE_OUT_OF_BED)
        for ((wake, sessions) in byWake) {
            var asleep = 0L
            for (s in sessions) {
                asleep += if (s.stages.isNotEmpty()) s.stages.filter { it.stage !in awake }.sumOf { Duration(it.startTime, it.endTime) }
                          else Duration(s.startTime, s.endTime)
            }
            val first = sessions.minBy { it.startTime }.startTime.atZone(zone)
            val d = days.getOrPut(wake) { Day() }
            d.sleepMin = asleep.toInt(); d.onset = onsetOf(first, LocalDate.parse(wake)); d.sleepSrc = "health_connect"
        }
    }

    // ---------- No wearable: nights from the screen's on/off pattern (Wang et al. 2018 used the same idea) ----------
    // Longest stretch with the screen off between 20:00 and 12:00 is taken as the night's sleep.
    // Android keeps these events for a limited time, so the daily worker stores each night as it goes.
    private fun readPhoneNights(ctx: Context, days: MutableMap<String, Day>) {
        val usm = ctx.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val now = System.currentTimeMillis()
        val from = now - 10L * 24 * 3600 * 1000
        val events = usm.queryEvents(from, now)
        val offOn = mutableListOf<Pair<Long, Boolean>>()   // (time, screenOn)
        val unlocks = mutableListOf<Long>()
        val e = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(e)
            when (e.eventType) {
                UsageEvents.Event.SCREEN_INTERACTIVE -> offOn.add(e.timeStamp to true)
                UsageEvents.Event.SCREEN_NON_INTERACTIVE -> offOn.add(e.timeStamp to false)
                UsageEvents.Event.KEYGUARD_HIDDEN -> unlocks.add(e.timeStamp)
            }
        }
        if (offOn.isEmpty()) return
        val today = LocalDate.now()
        var wake = Instant.ofEpochMilli(from).atZone(zone).toLocalDate().plusDays(1)
        while (!wake.isAfter(today)) {
            val winStart = ZonedDateTime.of(wake.minusDays(1), LocalTime.of(20, 0), zone).toInstant().toEpochMilli()
            val winEnd = ZonedDateTime.of(wake, LocalTime.of(12, 0), zone).toInstant().toEpochMilli()
            if (winEnd <= now) {
                var best = 0L; var bestStart = 0L
                var offSince: Long? = if (offOn.lastOrNull { it.first < winStart }?.second == false) winStart else null
                for ((t, on) in offOn) {
                    if (t < winStart || t > winEnd) continue
                    if (!on && offSince == null) offSince = t
                    if (on && offSince != null) { if (t - offSince > best) { best = t - offSince; bestStart = offSince }; offSince = null }
                }
                if (offSince != null && winEnd - offSince > best) { best = winEnd - offSince; bestStart = offSince }
                val mins = (best / 60000).toInt()
                if (mins in 180..900) {
                    val d = days.getOrPut(wake.toString()) { Day() }
                    // a real sleep tracker always wins over the phone's estimate
                    if (d.sleepSrc != "health_connect") {
                        d.sleepMin = mins
                        d.onset = onsetOf(Instant.ofEpochMilli(bestStart).atZone(zone), wake)
                        d.sleepSrc = "phone"
                    }
                    val n0 = ZonedDateTime.of(wake, LocalTime.MIDNIGHT, zone).toInstant().toEpochMilli()
                    val n5 = ZonedDateTime.of(wake, LocalTime.of(5, 0), zone).toInstant().toEpochMilli()
                    d.nightUnlocks = unlocks.count { it in n0..n5 }
                }
            }
            wake = wake.plusDays(1)
        }
    }

    // ---------- No wearable: the phone's own step counter, sampled by the hourly worker ----------
    suspend fun sampleStepCounter(ctx: Context) {
        val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val sensor = sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) ?: return
        val value = withTimeoutOrNull(10_000) {
            suspendCancellableCoroutine<Float> { cont ->
                val l = object : SensorEventListener {
                    override fun onSensorChanged(ev: SensorEvent) { sm.unregisterListener(this); if (cont.isActive) cont.resume(ev.values[0]) }
                    override fun onAccuracyChanged(s: Sensor?, a: Int) {}
                }
                sm.registerListener(l, sensor, SensorManager.SENSOR_DELAY_NORMAL)
                cont.invokeOnCancellation { sm.unregisterListener(l) }
            }
        } ?: return
        val prefs = ctx.getSharedPreferences("lueur", Context.MODE_PRIVATE)
        val last = prefs.getFloat("stepCounter", -1f)
        val lastDate = prefs.getString("stepCounterDate", null)
        val today = LocalDate.now().toString()
        prefs.edit().putFloat("stepCounter", value).putString("stepCounterDate", today).apply()
        if (last < 0 || lastDate == null) return
        val delta = (if (value >= last) value - last else value).toLong()   // counter resets on reboot
        if (delta <= 0 || delta > 60_000) return
        val days = load(ctx)
        val d = days.getOrPut(lastDate) { Day() }
        if (d.stepsSrc != "health_connect") { d.steps = (d.steps ?: 0) + delta; d.stepsSrc = "phone" }
        save(ctx, days)
    }

    // ---------- helpers ----------
    private fun Duration(a: Instant, b: Instant): Long = ChronoUnit.MINUTES.between(a, b)

    fun onsetOf(start: ZonedDateTime, wake: LocalDate): Int {
        val mins = start.hour * 60 + start.minute
        return if (start.toLocalDate() == wake) mins + 12 * 60 else mins - 12 * 60
    }

    @Suppress("unused")
    private fun LocalDateTime.label() = toLocalDate().toString()
}
