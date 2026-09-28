package com.mitchel.claude_monitor

import android.app.Notification
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Shader
import android.graphics.drawable.Icon
import android.os.Build
import android.view.View
import android.widget.RemoteViews

object LiveNotificationTheme {
    private val lime = Color.rgb(217, 246, 111)
    private val amber = Color.rgb(240, 199, 97)
    private val muted = Color.rgb(173, 181, 170)
    private val error = Color.rgb(239, 157, 143)
    private val badges = mutableMapOf<Int, Bitmap>()

    private fun accent(phase: LivePhase) = when (phase) {
        LivePhase.APPROVAL, LivePhase.INPUT -> amber
        LivePhase.ERROR -> error
        LivePhase.OFFLINE, LivePhase.IDLE, LivePhase.CONNECTING -> muted
        else -> lime
    }

    private fun artwork(phase: LivePhase) = when (phase) {
        LivePhase.APPROVAL, LivePhase.INPUT -> R.drawable.meng_live_approval
        LivePhase.DONE -> R.drawable.meng_live_completed
        LivePhase.ERROR, LivePhase.OFFLINE -> R.drawable.meng_live_offline
        LivePhase.IDLE, LivePhase.CONNECTING -> R.drawable.meng_live_tracker
        else -> R.drawable.meng_live_running
    }

    @Synchronized
    private fun badge(context: Context, phase: LivePhase): Bitmap {
        val id = artwork(phase)
        return badges.getOrPut(id) {
            val source = BitmapFactory.decodeResource(context.resources, id)
            val sized = Bitmap.createScaledBitmap(source, 192, 192, true)
            val result = Bitmap.createBitmap(192, 192, Bitmap.Config.ARGB_8888)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                shader = BitmapShader(sized, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
            }
            Canvas(result).drawCircle(96f, 96f, 96f, paint)
            if (sized !== source) source.recycle()
            sized.recycle()
            result
        }
    }

    fun apply(context: Context, builder: Notification.Builder, state: LiveNotificationState, live: Boolean) {
        builder.setSmallIcon(R.drawable.ic_stat_meng_live)
            .setLargeIcon(badge(context, state.phase))
            .setContentTitle(state.title)
            .setContentText(state.detail)
            .setSubText("小梦 · ${state.phase.label}")
            .setColor(accent(state.phase))
            .setShowWhen(false)
        // Android 16 promotion rejects both RemoteViews and colorized notifications.
        if (live && Build.VERSION.SDK_INT >= 36) {
            builder.setColorized(false)
            if (state.phase == LivePhase.RUNNING) {
                val progress = Notification.ProgressStyle()
                    .setProgressTrackerIcon(Icon.createWithResource(context, R.drawable.meng_live_tracker))
                    .setProgressSegments(listOf(Notification.ProgressStyle.Segment(
                        if (state.hasProgress) state.total else 100,
                    ).setColor(lime)))
                    .setStyledByProgress(true)
                if (state.hasProgress) {
                    progress.setProgress(state.progress)
                    builder.setContentText("${state.detail} · ${state.progressLabel}")
                } else {
                    progress.setProgressIndeterminate(true)
                }
                builder.setStyle(progress)
            } else {
                builder.setStyle(Notification.BigTextStyle().bigText(state.detail))
            }
            if (state.phase.active) Notifications.promote(builder, state.phase.label)
        } else {
            builder.setStyle(Notification.DecoratedCustomViewStyle())
                .setCustomContentView(content(context, state, false))
                .setCustomBigContentView(content(context, state, true))
        }
    }

    private fun content(context: Context, state: LiveNotificationState, expanded: Boolean): RemoteViews {
        val view = RemoteViews(context.packageName,
            if (expanded) R.layout.notification_meng_expanded else R.layout.notification_meng_compact)
        view.setImageViewBitmap(R.id.meng_portrait, badge(context, state.phase))
        view.setTextViewText(R.id.meng_title, state.title)
        view.setTextViewText(R.id.meng_status, state.phase.label)
        view.setTextColor(R.id.meng_status, accent(state.phase))
        if (expanded) {
            view.setTextViewText(R.id.meng_detail, state.detail)
            view.setViewVisibility(R.id.meng_progress_group, if (state.hasProgress) View.VISIBLE else View.GONE)
            view.setProgressBar(R.id.meng_progress, state.total.coerceAtLeast(1), state.progress, false)
            view.setTextViewText(R.id.meng_progress_text, state.progressLabel)
        }
        return view
    }
}
