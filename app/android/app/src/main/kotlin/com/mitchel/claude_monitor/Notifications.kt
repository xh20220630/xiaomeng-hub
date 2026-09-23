package com.mitchel.claude_monitor

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build

/**
 * Shared notification plumbing for the three native channels:
 *  - claude_live2   — the foreground-service capsule (Android 16 Live Update).
 *    NOTE: intentionally a NEW id — the old "claude_live" channel was created
 *    as IMPORTANCE_LOW on user devices, and channel importance can't be raised
 *    programmatically after creation.
 *  - claude_tasks   — "task done" one-shots.
 *  - claude_approvals — heads-up approval requests with action buttons.
 */
object Notifications {
    const val PREFS = "claude_native"
    const val CHANNEL_LIVE = "claude_live2"
    const val CHANNEL_TASKS = "claude_tasks"
    const val CHANNEL_APPROVALS = "claude_approvals"

    /** Foreground-service (capsule) notification id. */
    const val FG_NOTIF_ID = 4821

    /** Old MainActivity-posted capsule id — cancelled when the service takes over. */
    const val LEGACY_CAPSULE_ID = 4820

    fun nm(ctx: Context): NotificationManager =
        ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    fun ensureChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = nm(ctx)
        // Retire the superseded LOW-importance capsule channel.
        try {
            nm.deleteNotificationChannel("claude_live")
        } catch (_: Throwable) {
        }
        val live = NotificationChannel(
            CHANNEL_LIVE,
            "Agent 实时状态",
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = "顶部常驻胶囊：当前 Agent 任务状态"
            setShowBadge(false)
            setSound(null, null) // persistent status line — never ding
            enableVibration(false)
        }
        val tasks = NotificationChannel(
            CHANNEL_TASKS,
            "任务完成",
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = "Agent 任务完成提醒"
        }
        val approvals = NotificationChannel(
            CHANNEL_APPROVALS,
            "审批请求",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Agent 正在等待你的批准"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 250, 150, 250)
        }
        nm.createNotificationChannels(listOf(live, tasks, approvals))
    }

    /** Android 16+: can this app post promoted (capsule) notifications? */
    fun canPromote(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < 36) return false
        return try {
            val m = NotificationManager::class.java.getMethod("canPostPromotedNotifications")
            (m.invoke(nm(ctx)) as? Boolean) ?: false
        } catch (_: Throwable) {
            false
        }
    }

    /**
     * Reflectively request the Android 16 status-bar capsule. The promotion
     * APIs are invisible in the compileSdk 36 android.jar (verified: direct
     * calls fail with Unresolved reference), so reflection is mandatory.
     *
     * setShortCriticalText's real signature takes String — try that first and
     * only fall back to a CharSequence lookup for odd OEM builds.
     */
    fun promote(builder: Notification.Builder, shortText: String?) {
        if (Build.VERSION.SDK_INT < 36) return
        try {
            Notification.Builder::class.java
                .getMethod("setRequestPromotedOngoing", Boolean::class.javaPrimitiveType)
                .invoke(builder, true)
        } catch (_: Throwable) {
            // API absent on this build — degrades to a plain ongoing notification.
        }
        if (!shortText.isNullOrEmpty()) {
            try {
                Notification.Builder::class.java
                    .getMethod("setShortCriticalText", String::class.java)
                    .invoke(builder, shortText)
            } catch (_: Throwable) {
                try {
                    Notification.Builder::class.java
                        .getMethod("setShortCriticalText", CharSequence::class.java)
                        .invoke(builder, shortText)
                } catch (_: Throwable) {
                    // ignore
                }
            }
        }
    }
}
