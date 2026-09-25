package ch.lueur.app

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.PermissionController
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** Bridge between the web UI (js/native.js) and the on-device collectors. Nothing here uses the network. */
@CapacitorPlugin(
    name = "LueurHealth",
    permissions = [
        Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS]),
        Permission(alias = "activity", strings = [Manifest.permission.ACTIVITY_RECOGNITION]),
        Permission(alias = "location", strings = [Manifest.permission.ACCESS_COARSE_LOCATION]),
    ]
)
class LueurHealthPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val contract = PermissionController.createRequestPermissionResultContract()

    @PluginMethod
    fun status(call: PluginCall) {
        scope.launch {
            val ctx = context
            val granted = Collector.hcGranted(ctx)
            val ret = JSObject()
            ret.put("healthConnect", Collector.hcStatus(ctx))
            ret.put("hcSteps", granted.any { it.endsWith("READ_STEPS") })
            ret.put("hcSleep", granted.any { it.endsWith("READ_SLEEP") })
            ret.put("usageAccess", Collector.hasUsageAccess(ctx))
            ret.put("activity", Build.VERSION.SDK_INT < 29 || getPermissionState("activity") == PermissionState.GRANTED)
            ret.put("notifications", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED)
            ret.put("location", LocationDay.hasPermission(ctx, background = false))
            ret.put("locationAlways", LocationDay.hasPermission(ctx, background = true))
            ret.put("debug", DemoSeeder.isDebug(ctx))
            // what the background check would see right now (sensor signals only)
            ret.put("sensorShifts", DriftCheck.shiftedCount(Collector.load(ctx)))
            ret.put("stepSensor", (ctx.getSystemService(android.content.Context.SENSOR_SERVICE) as android.hardware.SensorManager)
                .getDefaultSensor(android.hardware.Sensor.TYPE_STEP_COUNTER) != null)
            call.resolve(ret)
        }
    }

    @PluginMethod
    fun requestHealth(call: PluginCall) {
        when (Collector.hcStatus(context)) {
            "available" -> {
                val perms = Collector.HC_PERMISSIONS + Collector.HISTORY_PERMISSION
                startActivityForResult(call, contract.createIntent(context, perms), "onHealthResult")
            }
            "update_required" -> {
                // Health Connect needs installing or updating from the Play Store
                val uri = Uri.parse("market://details?id=com.google.android.apps.healthdata&url=healthconnect%3A%2F%2Fonboarding")
                runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, uri).setPackage("com.android.vending")) }
                call.resolve(JSObject().put("granted", false).put("reason", "update_required"))
            }
            else -> call.resolve(JSObject().put("granted", false).put("reason", "unavailable"))
        }
    }

    @ActivityCallback
    private fun onHealthResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val granted = contract.parseResult(result.resultCode, result.data)
        val arr = JSArray(); granted.forEach { arr.put(it) }
        call.resolve(JSObject().put("granted", granted.isNotEmpty()).put("permissions", arr))
    }

    @PluginMethod
    fun openUsageAccess(call: PluginCall) {
        val i = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
        runCatching { i.data = Uri.parse("package:" + context.packageName) }
        runCatching { activity.startActivity(i) }.onFailure { activity.startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)) }
        call.resolve()
    }

    @PluginMethod
    fun requestNotifications(call: PluginCall) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(JSObject().put("granted", true)); return
        }
        requestPermissionForAlias("notifications", call, "onNotifications")
    }

    @PermissionCallback
    private fun onNotifications(call: PluginCall) {
        call.resolve(JSObject().put("granted", getPermissionState("notifications") == PermissionState.GRANTED))
    }

    /** Step 1: coarse location while in use. Step 2 (Android 10+): "Allow all the time" lives in Settings. */
    @PluginMethod
    fun requestLocation(call: PluginCall) {
        if (!LocationDay.hasPermission(context, background = false)) { requestPermissionForAlias("location", call, "onLocation"); return }
        openBackgroundLocationSettings(call)
    }

    @PermissionCallback
    private fun onLocation(call: PluginCall) {
        if (!LocationDay.hasPermission(context, background = false)) { call.resolve(JSObject().put("granted", false)); return }
        openBackgroundLocationSettings(call)
    }

    private fun openBackgroundLocationSettings(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= 29 && !LocationDay.hasPermission(context, background = true)) {
            // Android only grants "all the time" from the app's permission page
            val i = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName))
            runCatching { activity.startActivity(i) }
            call.resolve(JSObject().put("granted", false).put("needsSettings", true)); return
        }
        scope.launch(Dispatchers.IO) { LocationDay.sample(context) }
        call.resolve(JSObject().put("granted", true))
    }

    /** Opens the Timeline settings where "Export Timeline data" lives (falls back to Location settings). */
    @PluginMethod
    fun openTimeline(call: PluginCall) {
        val tries = listOf(
            Intent("com.google.android.gms.location.settings.LOCATION_HISTORY"),
            Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS),
        )
        for (i in tries) if (runCatching { activity.startActivity(i) }.isSuccess) break
        call.resolve()
    }

    @PluginMethod
    fun requestActivity(call: PluginCall) {
        if (Build.VERSION.SDK_INT < 29 || getPermissionState("activity") == PermissionState.GRANTED) {
            call.resolve(JSObject().put("granted", true)); return
        }
        requestPermissionForAlias("activity", call, "onActivity")
    }

    @PermissionCallback
    private fun onActivity(call: PluginCall) {
        val ok = getPermissionState("activity") == PermissionState.GRANTED
        if (ok) scope.launch(Dispatchers.IO) { Collector.sampleStepCounter(context) } // set the first reading
        call.resolve(JSObject().put("granted", ok))
    }

    /** Collects from every granted source and returns the stored days. */
    @PluginMethod
    fun sync(call: PluginCall) {
        val daysBack = call.getInt("days", 60) ?: 60
        scope.launch(Dispatchers.IO) {
            val days = runCatching { Collector.collect(context, daysBack) }.getOrElse { Collector.load(context) }
            val arr = JSArray()
            for ((date, d) in days.toSortedMap()) arr.put(Collector.toJson(d).put("date", date))
            call.resolve(JSObject().put("days", arr))
        }
    }

    /** The web app tells the background check about snoozes and whether notes are wanted. */
    @PluginMethod
    fun setPrefs(call: PluginCall) {
        val e = context.getSharedPreferences("lueur", android.content.Context.MODE_PRIVATE).edit()
        call.getString("snoozeUntil")?.let { e.putString("snoozeUntil", it) }
        call.getBoolean("notify")?.let { e.putBoolean("notify", it) }
        e.apply()
        call.resolve()
    }

    /** For the demo: show what the gentle note looks like, right now. */
    @PluginMethod
    fun previewNotification(call: PluginCall) {
        DailyWorker.show(context, "Your rhythm has shifted a little lately", "Have a look when you have a moment. Nothing is shared unless you choose to.")
        call.resolve()
    }

    /** Debug builds only: fill Health Connect with six weeks of sample data (asks for write access first). */
    @PluginMethod
    fun debugSeed(call: PluginCall) {
        if (!DemoSeeder.isDebug(context)) { call.reject("Only available in debug builds"); return }
        scope.launch {
            val granted = Collector.hcGranted(context)
            if (granted.containsAll(DemoSeeder.WRITE)) doSeed(call)
            else startActivityForResult(call, contract.createIntent(context, DemoSeeder.WRITE), "onSeedPermission")
        }
    }

    @ActivityCallback
    private fun onSeedPermission(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        if (contract.parseResult(result.resultCode, result.data).containsAll(DemoSeeder.WRITE)) scope.launch { doSeed(call) }
        else call.resolve(JSObject().put("seeded", 0))
    }

    private suspend fun doSeed(call: PluginCall) {
        val n = runCatching { DemoSeeder.seed(context) }.getOrElse { call.reject(it.message ?: "seed failed"); return }
        call.resolve(JSObject().put("seeded", n))
    }

    @PluginMethod
    fun wipe(call: PluginCall) {
        Collector.wipe(context)
        LocationDay.wipe(context)
        call.resolve()
    }
}
