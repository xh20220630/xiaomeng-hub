package com.mitchel.claude_monitor

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Hosts the Flutter UI and bridges native concerns over the
 * "claude/liveupdate" MethodChannel:
 *
 *  dart → native
 *   - canPromote(): whether Android 16 promoted (capsule) notifications work
 *   - openPromotedSettings(): jump to the promoted-notification settings page
 *   - show(...) / hide(): legacy capsule控制 — now delegates to MonitorService
 *     when it's alive (the service owns all Android notifications), falls back
 *     to a locally-posted notification otherwise
 *   - configureService({baseUrl,wsUrl,token}): persist config to the native
 *     SharedPreferences "claude_native" and (re)start the foreground service
 *   - stopService()
 *   - getLaunchDeeplink(): one-shot {projectId?,sessionId?,approvalId?} from
 *     the launching notification tap
 *
 *  native → dart
 *   - onDeeplink({...}): pushed when a notification is tapped while the
 *     engine is alive (onNewIntent path)
 */
class MainActivity : FlutterActivity() {
    private val channelName = "claude/liveupdate"
    private var channel: MethodChannel? = null
    private var appUpdates: AppUpdateBridge? = null
    private val previewHandler = Handler(Looper.getMainLooper())
    private var pendingDeeplink: Map<String, String>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Cold start from a notification tap: stash extras until Dart asks.
        deeplinkFrom(intent)?.let { pendingDeeplink = it }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val link = deeplinkFrom(intent) ?: return
        val ch = channel
        if (ch != null) {
            ch.invokeMethod("onDeeplink", link)
        } else {
            pendingDeeplink = link
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        appUpdates = AppUpdateBridge(this, flutterEngine.dartExecutor.binaryMessenger)
        val ch = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
        channel = ch
        ch.setMethodCallHandler { call, result ->
            when (call.method) {
                "canPromote" -> result.success(Notifications.canPromote(this))
                "previewTheme" -> result.success(showThemePreview(call.argument<String>("status")))
                "openPromotedSettings" -> result.success(openPromotedSettings())
                "show" -> {
                    val svc = MonitorService.instance
                    if (svc != null) {
                        // Service owns notifications — just have it re-render.
                        svc.refreshExternal()
                    } else {
                        showLocalCapsule(
                            title = call.argument<String>("title") ?: "小梦 · Claude 监控",
                            text = call.argument<String>("text") ?: "",
                            shortText = call.argument<String>("shortText"),
                            status = call.argument<String>("status"),
                            progressDone = call.argument<Int>("progressDone"),
                            progressTotal = call.argument<Int>("progressTotal"),
                        )
                    }
                    result.success(true)
                }
                "hide" -> {
                    if (MonitorService.instance == null) hideLocalCapsule()
                    result.success(true)
                }
                "configureService" -> result.success(
                    configureService(
                        baseUrl = call.argument<String>("baseUrl"),
                        wsUrl = call.argument<String>("wsUrl"),
                        token = call.argument<String>("token"),
                    ),
                )
                "stopService" -> {
                    try {
                        stopService(Intent(this, MonitorService::class.java))
                    } catch (_: Throwable) {
                    }
                    result.success(true)
                }
                "getLaunchDeeplink" -> {
                    val link = pendingDeeplink
                    pendingDeeplink = null
                    result.success(link)
                }
                else -> result.notImplemented()
            }
        }
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        previewHandler.removeCallbacksAndMessages(null)
        Notifications.nm(this).cancel("theme-preview", 4822)
        appUpdates?.dispose()
        appUpdates = null
        super.cleanUpFlutterEngine(flutterEngine)
    }

    // ---------------------------------------------------------------- deeplink

    private fun deeplinkFrom(intent: Intent?): Map<String, String>? {
        intent ?: return null
        val m = mutableMapOf<String, String>()
        intent.getStringExtra("projectId")?.let { m["projectId"] = it }
        intent.getStringExtra("sessionId")?.let { m["sessionId"] = it }
        intent.getStringExtra("approvalId")?.let { m["approvalId"] = it }
        return if (m.isEmpty()) null else m
    }

    // ---------------------------------------------------------------- service

    private fun configureService(baseUrl: String?, wsUrl: String?, token: String?): Boolean {
        if (wsUrl.isNullOrBlank()) return false
        getSharedPreferences(Notifications.PREFS, Context.MODE_PRIVATE).edit()
            .putString("baseUrl", baseUrl ?: "")
            .putString("wsUrl", wsUrl)
            .putString("token", token ?: "")
            .apply()
        return try {
            val i = Intent(this, MonitorService::class.java)
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i) else startService(i)
            true
        } catch (_: Throwable) {
            false
        }
    }

    // ---------------------------------------------------------------- settings

    private fun openPromotedSettings(): Boolean {
        if (Build.VERSION.SDK_INT >= 36) {
            try {
                // Constant not visible in compileSdk 36's android.jar — hardcoded.
                val i = Intent("android.settings.MANAGE_APP_PROMOTED_NOTIFICATIONS_SETTINGS")
                    .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                startActivity(i)
                return true
            } catch (_: Throwable) {
                // fall through to the app notification settings
            }
        }
        return try {
            val i = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
            startActivity(i)
            true
        } catch (_: Throwable) {
            false
        }
    }

    // ------------------------------------------------- legacy local capsule
    // Only used when MonitorService isn't running (e.g. before first
    // configureService). The service supersedes this entirely.

    private fun showLocalCapsule(
        title: String,
        text: String,
        shortText: String?,
        status: String?,
        progressDone: Int?,
        progressTotal: Int?,
    ) {
        if (Build.VERSION.SDK_INT < 26) return
        Notifications.ensureChannels(this)
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val builder = Notification.Builder(this, Notifications.CHANNEL_LIVE)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openIntent)
        val phase = LivePhase.fromStatus(status ?: if (shortText == "待审批") "needs_approval" else "running")
        LiveNotificationTheme.apply(this, builder, LiveNotificationState(
            phase, title, text, progressDone ?: -1, progressTotal ?: -1,
        ), live = true)
        Notifications.nm(this).notify(Notifications.LEGACY_CAPSULE_ID, builder.build())
    }

    private fun hideLocalCapsule() {
        try {
            Notifications.nm(this).cancel(Notifications.LEGACY_CAPSULE_ID)
        } catch (_: Throwable) {
        }
    }

    private fun showThemePreview(status: String?): Boolean {
        Notifications.ensureChannels(this)
        if (!Notifications.nm(this).areNotificationsEnabled()) return false
        val phase = LivePhase.fromStatus(status)
        val open = PendingIntent.getActivity(this, 4822, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, Notifications.CHANNEL_LIVE)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        builder.setOngoing(phase.active).setOnlyAlertOnce(true).setContentIntent(open)
        if (Build.VERSION.SDK_INT >= 26) builder.setTimeoutAfter(20_000)
        LiveNotificationTheme.apply(this, builder, LiveNotificationState(
            phase, "样式预览 · 示例任务", phase.detail, 3, 5,
        ), live = true)
        return try {
            Notifications.nm(this).notify("theme-preview", 4822, builder.build())
            previewHandler.removeCallbacksAndMessages(null)
            previewHandler.postDelayed({ Notifications.nm(this).cancel("theme-preview", 4822) }, 20_000)
            true
        } catch (_: SecurityException) {
            false
        }
    }
}
