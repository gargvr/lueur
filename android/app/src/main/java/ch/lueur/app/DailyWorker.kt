package ch.lueur.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.time.LocalDate
import java.time.LocalTime
import java.util.concurrent.TimeUnit

/**
 * Runs about once an hour in the background, entirely on the device:
 *  - samples the phone's step counter (for people without a wearable),
 *  - once a day, collects Health Connect and screen-pattern data,
 *  - once a day after 10:00, checks for a sustained shift and, at most once a week,
 *    shows one gentle notification. It never names a condition and never contacts anyone.
 */
class DailyWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val ctx = applicationContext
        val prefs = ctx.getSharedPreferences("lueur", Context.MODE_PRIVATE)
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED) {
            runCatching { Collector.sampleStepCounter(ctx) }
        }
        runCatching { LocationDay.sample(ctx) }
        val today = LocalDate.now().toString()
        if (prefs.getString("lastCollect", null) != today) {
            runCatching { Collector.collect(ctx, 45) }
            prefs.edit().putString("lastCollect", today).apply()
        }
        if (LocalTime.now().hour >= 10 && prefs.getString("lastCheck", null) != today) {
            prefs.edit().putString("lastCheck", today).apply()
            maybeNotify(ctx)
        }
        return Result.success()
    }

    private fun maybeNotify(ctx: Context) {
        val prefs = ctx.getSharedPreferences("lueur", Context.MODE_PRIVATE)
        if (!prefs.getBoolean("notify", true)) return
        val today = LocalDate.now()
        prefs.getString("snoozeUntil", null)?.let { if (LocalDate.parse(it) > today) return }
        prefs.getString("lastNotified", null)?.let { if (LocalDate.parse(it).plusDays(7) > today) return }
        val shifted = DriftCheck.shiftedCount(Collector.load(ctx), today)
        if (shifted < 2) return
        show(ctx, "Your rhythm has shifted a little lately", "Have a look when you have a moment. Nothing is shared unless you choose to.")
        prefs.edit().putString("lastNotified", today.toString()).apply()
    }

    companion object {
        private const val CHANNEL = "gentle"

        fun schedule(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<DailyWorker>(1, TimeUnit.HOURS).build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("lueur-daily", ExistingPeriodicWorkPolicy.KEEP, req)
        }

        fun show(ctx: Context, title: String, text: String) {
            if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            // Low importance: no sound, no pop-up. Gentle by design.
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Gentle check-ins", NotificationManager.IMPORTANCE_LOW).apply {
                description = "At most one quiet note a week when your rhythm has shifted for a while."
            })
            val open = PendingIntent.getActivity(ctx, 0,
                Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val n = NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_lueur)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(open)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build()
            NotificationManagerCompat.from(ctx).notify(7, n)
        }
    }
}
