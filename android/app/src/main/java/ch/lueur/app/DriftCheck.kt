package ch.lueur.app

import java.time.LocalDate
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt

/**
 * The same rules as js/engine.js, for the background check only (sensor signals only; the
 * mood/energy check-ins live inside the app's web storage). Keep the two in step.
 */
object DriftCheck {
    private const val RECENT = 14
    private const val BASE = 28
    private const val Z_FLAG = 1.5
    private const val PERSIST = 0.6
    private const val Z_MEDIAN = 1.2

    private data class Sig(val key: String, val bad: String, val floor: Double, val get: (Map<String, Day>, String) -> Double?)

    private fun median(a: List<Double>): Double { val s = a.sorted(); val m = s.size / 2; return if (s.size % 2 == 1) s[m] else (s[m - 1] + s[m]) / 2 }
    private fun badZ(z: Double, dir: String) = when (dir) { "up" -> z; "down" -> -z; else -> abs(z) }

    private fun irregularity(days: Map<String, Day>, date: String): Double? {
        val d0 = LocalDate.parse(date)
        val vals = (0..6).mapNotNull { days[d0.minusDays(it.toLong()).toString()]?.onset?.toDouble() }
        if (vals.size < 4) return null
        val m = vals.average()
        return sqrt(vals.sumOf { (it - m) * (it - m) } / vals.size)
    }

    private val SIGNALS = listOf(
        Sig("sleepMin", "both", 25.0) { d, k -> d[k]?.sleepMin?.toDouble() },
        Sig("onset", "up", 25.0) { d, k -> d[k]?.onset?.toDouble() },
        Sig("irregularity", "up", 12.0) { d, k -> irregularity(d, k) },
        Sig("steps", "down", 900.0) { d, k -> d[k]?.steps?.toDouble() },
        Sig("places", "down", 0.7) { d, k -> d[k]?.places?.toDouble() },
        Sig("homeStay", "up", 5.0) { d, k -> d[k]?.homeStay?.toDouble() },
        Sig("rangeKm", "down", 0.5) { d, k -> d[k]?.rangeKm },
    )

    /** Number of sensor signals that have clearly shifted over the last two weeks. */
    fun shiftedCount(days: Map<String, Day>, today: LocalDate = LocalDate.now()): Int {
        val recent = (0 until RECENT).map { today.minusDays(it.toLong()).toString() }
        val base = (RECENT until RECENT + BASE).map { today.minusDays(it.toLong()).toString() }
        var shifted = 0
        for (s in SIGNALS) {
            val b = base.mapNotNull { s.get(days, it) }
            val r = recent.reversed().mapNotNull { s.get(days, it) }
            if (b.size < 10 || r.size < 5) continue
            val c = median(b)
            val sc = max(1.4826 * median(b.map { abs(it - c) }), s.floor)
            val off = r.count { badZ((it - c) / sc, s.bad) >= Z_FLAG }
            val zm = badZ((median(r.takeLast(7)) - c) / sc, s.bad)
            if (off.toDouble() / r.size >= PERSIST && zm >= Z_MEDIAN) shifted++
        }
        return shifted
    }
}
