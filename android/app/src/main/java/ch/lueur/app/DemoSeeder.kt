package ch.lueur.app

import android.content.Context
import android.content.pm.ApplicationInfo
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.metadata.Metadata
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import kotlin.math.max
import kotlin.random.Random

/**
 * Debug builds only. Writes six weeks of sample steps and sleep into Health Connect, with the
 * same "gradual shift" pattern as js/demo.js, so the full band -> Health Connect -> Lueur path
 * can be shown on a phone or emulator without a real wearable.
 */
object DemoSeeder {
    val WRITE = setOf(
        HealthPermission.getWritePermission(StepsRecord::class),
        HealthPermission.getWritePermission(SleepSessionRecord::class),
    )

    fun isDebug(ctx: Context) = (ctx.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    suspend fun seed(ctx: Context, days: Int = 42): Int {
        val client = HealthConnectClient.getOrCreate(ctx)
        val zone = ZoneId.systemDefault()
        val rnd = Random(42)
        fun g() = (rnd.nextDouble() + rnd.nextDouble() + rnd.nextDouble() - 1.5) * 1.4   // ~N(0,1)
        val records = mutableListOf<androidx.health.connect.client.records.Record>()
        val today = LocalDate.now()
        for (i in days downTo 1) {
            val wake = today.minusDays(i.toLong())
            val p = if (i <= 21) minOf(1.0, (22 - i) / 12.0) else 0.0               // drift over the last 3 weeks
            val weekend = wake.dayOfWeek.value >= 6
            val onsetMin = 23 * 60 + 20 + (if (weekend) 35 else 0) + (p * 85).toInt() + (g() * (18 + p * 32)).toInt()
            val sleepMin = max(200, 445 + (if (weekend) 30 else 0) - (p * 70).toInt() + (g() * 24).toInt())
            val start = wake.minusDays(1).atStartOfDay(zone).plusMinutes(onsetMin.toLong())
            val end = start.plusMinutes(sleepMin.toLong())
            records += SleepSessionRecord(
                startTime = start.toInstant(), startZoneOffset = start.offset,
                endTime = end.toInstant(), endZoneOffset = end.offset,
                metadata = Metadata.manualEntry(), title = "Sample night",
            )
            val steps = max(300.0, (if (weekend) 9400.0 else 8100.0) * (1 - p * 0.5) + g() * 1500).toLong()
            val s0 = wake.atTime(LocalTime.of(9, 0)).atZone(zone)
            val s1 = wake.atTime(LocalTime.of(19, 0)).atZone(zone)
            records += StepsRecord(
                startTime = s0.toInstant(), startZoneOffset = s0.offset,
                endTime = s1.toInstant(), endZoneOffset = s1.offset,
                count = steps, metadata = Metadata.manualEntry(),
            )
        }
        client.insertRecords(records)
        return days
    }
}
