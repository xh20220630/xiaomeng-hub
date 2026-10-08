package com.mitchel.claude_monitor

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * Foreground service — the single Android notification source for the app.
 *
 * Keeps its own WebSocket to the bridge server (independent of the Flutter
 * engine, so notifications survive the app being swiped away) and turns the
 * downstream frames into three kinds of notifications:
 *  1. the foreground notification itself = the Android 16 Live-Update capsule
 *     showing the most important project's status,
 *  2. "✅ 任务完成" one-shots when an active task finishes,
 *  3. heads-up approval requests with 批准/拒绝 actions (ApprovalReceiver
 *     POSTs the decision straight to the server, no UI round-trip).
 *
 * Config (baseUrl/wsUrl/token) lives in SharedPreferences "claude_native",
 * written by MainActivity.configureService before (re)starting the service.
 */
class MonitorService : Service() {

    companion object {
        /** Live instance so MainActivity's legacy show()/hide() can delegate. */
        @Volatile
        var instance: MonitorService? = null
            private set
    }

    private data class ProjectState(
        val projectId: String,
        val name: String,
        val status: String,
        val summary: String?,
        val sessionId: String?,
        val progressDone: Int,
        val progressTotal: Int,
        val approvalId: String?,
        val lastEventAt: Long,
    )

    private val handler = Handler(Looper.getMainLooper())
    private val projects = LinkedHashMap<String, ProjectState>()
    private val notifiedApprovals = HashSet<String>()

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS) // WS: no read timeout
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }

    private var ws: WebSocket? = null
    private var backoffMs = 1_000L
    private var destroyed = false
    private var foregroundStarted = false
    private var connectionState = "unconfigured"
    private val reconnectRunnable = Runnable { connect() }

    private val netCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            // Network came (back) — drop the backoff and retry right now.
            handler.post {
                if (destroyed) return@post
                backoffMs = 1_000L
                handler.removeCallbacks(reconnectRunnable)
                connect()
            }
        }
    }

    // ---------------------------------------------------------------- lifecycle

    override fun onCreate() {
        super.onCreate()
        instance = this
        Notifications.ensureChannels(this)
        // The service is now the only capsule owner; drop MainActivity's legacy one.
        try {
            Notifications.nm(this).cancel(Notifications.LEGACY_CAPSULE_ID)
        } catch (_: Throwable) {
        }
        goForeground(buildCapsule())
        if (Build.VERSION.SDK_INT >= 24) {
            try {
                val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
                cm.registerDefaultNetworkCallback(netCallback)
            } catch (_: Throwable) {
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Every (re)configure restarts the connection with fresh prefs.
        backoffMs = 1_000L
        handler.removeCallbacks(reconnectRunnable)
        connect()
        return START_STICKY
    }

    override fun onDestroy() {
        destroyed = true
        instance = null
        handler.removeCallbacksAndMessages(null)
        try {
            ws?.cancel()
        } catch (_: Throwable) {
        }
        ws = null
        if (Build.VERSION.SDK_INT >= 24) {
            try {
                val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
                cm.unregisterNetworkCallback(netCallback)
            } catch (_: Throwable) {
            }
        }
        if (Build.VERSION.SDK_INT >= 24) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        super.onDestroy()
    }

    /** Android 15+ enforces a time limit on dataSync services — stop cleanly. */
    override fun onTimeout(startId: Int) {
        stopSelf()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun goForeground(n: Notification) {
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(Notifications.FG_NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(Notifications.FG_NOTIF_ID, n)
        }
        foregroundStarted = true
    }

    // ---------------------------------------------------------------- websocket

    // OkHttp's Request.Builder.url() only accepts http/https — it upgrades to a
    // WebSocket internally. A ws://…/wss://… URL throws IllegalArgumentException
    // (which connect() would swallow, so the service would never connect). Dart
    // hands us ws://…, so normalise the scheme here.
    private fun toHttpScheme(url: String): String = when {
        url.startsWith("wss://", true) -> "https://" + url.substring(6)
        url.startsWith("ws://", true) -> "http://" + url.substring(5)
        else -> url
    }

    private fun currentWsUrl(): String? {
        val p = getSharedPreferences(Notifications.PREFS, Context.MODE_PRIVATE)
        val wsUrl = p.getString("wsUrl", null)?.takeIf { it.isNotBlank() } ?: return null
        val token = p.getString("token", null)?.takeIf { it.isNotBlank() }
        val withToken = if (token == null) {
            wsUrl
        } else {
            // Dart's settings.wsUrl already carries ?token= — don't duplicate.
            val hasToken = wsUrl.substringAfter('?', "").split('&').any { it.startsWith("token=") }
            if (hasToken) wsUrl else {
                val sep = if (wsUrl.contains('?')) '&' else '?'
                "$wsUrl${sep}token=${URLEncoder.encode(token, "UTF-8")}"
            }
        }
        return toHttpScheme(withToken)
    }

    private fun connect() {
        if (destroyed) return
        val url = currentWsUrl() ?: return
        connectionState = "connecting"
        refreshCapsule()
        try {
            ws?.cancel()
        } catch (_: Throwable) {
        }
        val request = try {
            Request.Builder().url(url).build()
        } catch (_: Throwable) {
            connectionState = "offline"
            refreshCapsule()
            return // malformed URL — wait for a proper configureService
        }
        ws = client.newWebSocket(request, SocketListener())
    }

    private fun scheduleReconnect() {
        if (destroyed) return
        connectionState = "offline"
        refreshCapsule()
        handler.removeCallbacks(reconnectRunnable)
        handler.postDelayed(reconnectRunnable, backoffMs)
        backoffMs = (backoffMs * 2).coerceAtMost(60_000L) // 1s→2s→…→60s cap
    }

    private inner class SocketListener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            handler.post {
                if (webSocket === ws && !destroyed) {
                    backoffMs = 1_000L
                    connectionState = "syncing"
                    refreshCapsule()
                }
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            handler.post { if (webSocket === ws && !destroyed) handleMessage(text) }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            handler.post { if (webSocket === ws) scheduleReconnect() }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            handler.post { if (webSocket === ws) scheduleReconnect() }
        }
    }

    // ---------------------------------------------------------------- protocol

    /** optString that treats JSON null / "" as absent (Android org.json quirk). */
    private fun JSONObject.str(key: String): String? {
        if (!has(key) || isNull(key)) return null
        return optString(key).takeIf { it.isNotEmpty() }
    }

    private fun handleMessage(text: String) {
        val obj = try {
            JSONObject(text)
        } catch (_: Throwable) {
            return
        }
        when (obj.optString("type")) {
            "projects.snapshot" -> onSnapshot(obj.optJSONArray("projects") ?: JSONArray())
            "project.update" -> obj.optJSONObject("project")?.let { onProjectUpdate(it) }
            "approval.request" -> obj.optJSONObject("approval")?.let { notifyApprovalIfNew(it) }
            "approval.resolved" -> onApprovalResolved(obj.str("approvalId"))
            // event.append / assistant.done are UI-level frames — Dart handles those.
        }
    }

    private fun parseProject(o: JSONObject): ProjectState? {
        val id = o.str("projectId") ?: return null
        val progress = o.optJSONObject("progress")
        return ProjectState(
            projectId = id,
            name = listOfNotNull(o.str("name") ?: id, o.str("agentName"), o.str("nodeName")).joinToString(" · "),
            status = if (o.optBoolean("online", true)) o.str("status") ?: "running" else "offline",
            summary = o.str("summary"),
            sessionId = o.str("activeSessionId"),
            progressDone = progress?.optInt("done", -1) ?: -1,
            progressTotal = progress?.optInt("total", -1) ?: -1,
            approvalId = o.optJSONObject("pendingApproval")?.str("approvalId"),
            lastEventAt = o.optLong("lastEventAt", 0L),
        )
    }

    private fun onSnapshot(arr: JSONArray) {
        connectionState = "online"
        val previous = projects.toMap()
        projects.clear()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val p = parseProject(o) ?: continue
            val prev = previous[p.projectId]
            // A snapshot may have been read before an already-delivered update.
            if (prev != null && ProjectNotificationPolicy.isOlder(prev.lastEventAt, p.lastEventAt)) {
                projects[p.projectId] = prev
                continue
            }
            projects[p.projectId] = p
            // Approvals still pending at (re)connect time deserve a heads-up too.
            if (p.status != "offline") o.optJSONObject("pendingApproval")?.let { notifyApprovalIfNew(it) }
        }
        refreshCapsule()
    }

    private fun onProjectUpdate(o: JSONObject) {
        val p = parseProject(o) ?: return
        val prev = projects[p.projectId]
        if (prev != null && ProjectNotificationPolicy.isOlder(prev.lastEventAt, p.lastEventAt)) return
        projects[p.projectId] = p

        if (ProjectNotificationPolicy.completesActiveTask(prev?.status, p.status)) notifyTaskDone(p)

        // (c) embedded pending approval that we haven't announced yet.
        if (p.status == "needs_approval") {
            o.optJSONObject("pendingApproval")?.let { notifyApprovalIfNew(it) }
        }

        // (a) capsule always reflects the latest state.
        refreshCapsule()
    }

    private fun onApprovalResolved(approvalId: String?) {
        if (approvalId.isNullOrEmpty()) return
        notifiedApprovals.remove(approvalId)
        try {
            Notifications.nm(this).cancel(approvalNotifId(approvalId))
        } catch (_: Throwable) {
        }
        // Clear the stale approval from local state so the capsule updates even
        // before the follow-up project.update lands.
        for ((key, p) in projects) {
            if (p.approvalId == approvalId) {
                projects[key] = p.copy(
                    approvalId = null,
                    status = if (p.status == "needs_approval") "running" else p.status,
                )
            }
        }
        refreshCapsule()
    }

    // ---------------------------------------------------------------- notifications

    private fun approvalNotifId(approvalId: String): Int =
        approvalId.hashCode() and 0x7fffffff

    private fun builder(channelId: String): Notification.Builder =
        if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, channelId)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this).apply {
                if (channelId == Notifications.CHANNEL_APPROVALS) {
                    setPriority(Notification.PRIORITY_HIGH)
                    setDefaults(Notification.DEFAULT_VIBRATE)
                } else {
                    setPriority(Notification.PRIORITY_DEFAULT)
                }
            }
        }

    private fun action(label: String, pi: PendingIntent): Notification.Action =
        if (Build.VERSION.SDK_INT >= 23) {
            Notification.Action.Builder(null as Icon?, label, pi).build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Action.Builder(0, label, pi).build()
        }

    /** Deep link into MainActivity; extras are picked up via getLaunchDeeplink/onDeeplink. */
    private fun activityIntent(projectId: String?, sessionId: String?, approvalId: String?): PendingIntent {
        val i = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_SINGLE_TOP or
                Intent.FLAG_ACTIVITY_CLEAR_TOP
            projectId?.let { putExtra("projectId", it) }
            sessionId?.let { putExtra("sessionId", it) }
            approvalId?.let { putExtra("approvalId", it) }
        }
        val req = ("${projectId ?: ""}|${sessionId ?: ""}|${approvalId ?: ""}").hashCode() and 0x7fffffff
        return PendingIntent.getActivity(
            this, req, i,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private fun notifyApprovalIfNew(ap: JSONObject) {
        val id = ap.str("approvalId") ?: return
        if (!notifiedApprovals.add(id)) return // already announced

        val kind = ap.str("kind")
        val title = ap.str("title") ?: if (kind == "file_edit") "修改文件" else "执行命令"
        val subject = ap.str("command") ?: ap.str("filePath") ?: ""
        val danger = ap.str("risk") == "danger"
        val projectId = ap.str("projectId")
        val sessionId = ap.str("sessionId")
        val expiresAt = ap.optLong("expiresAt", 0L)
        val notifId = approvalNotifId(id)

        val piFlags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        val approvePi = PendingIntent.getBroadcast(
            this, notifId,
            Intent(this, ApprovalReceiver::class.java)
                .setAction(ApprovalReceiver.ACTION_APPROVE)
                .putExtra(ApprovalReceiver.EXTRA_APPROVAL_ID, id)
                .putExtra(ApprovalReceiver.EXTRA_NOTIF_ID, notifId),
            piFlags,
        )
        val rejectPi = PendingIntent.getBroadcast(
            this, notifId,
            Intent(this, ApprovalReceiver::class.java)
                .setAction(ApprovalReceiver.ACTION_REJECT)
                .putExtra(ApprovalReceiver.EXTRA_APPROVAL_ID, id)
                .putExtra(ApprovalReceiver.EXTRA_NOTIF_ID, notifId),
            piFlags,
        )

        val b = builder(Notifications.CHANNEL_APPROVALS)
            .setContentTitle(if (danger) "⚠️ 需要审批：$title" else "需要审批：$title")
            .setContentText(subject)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(false)
            .setContentIntent(activityIntent(projectId, sessionId, id))
        if (kind == "input") {
            b.setContentTitle("需要回复：$title")
                .setContentText("打开小梦回答主机上的问题")
                .addAction(action("回复", activityIntent(projectId, sessionId, id)))
        } else {
            b.addAction(action("批准", approvePi)).addAction(action("拒绝", rejectPi))
        }
        LiveNotificationTheme.apply(this, b, LiveNotificationState(
            phase = if (kind == "input") LivePhase.INPUT else LivePhase.APPROVAL,
            title = if (kind == "input") "需要回复：$title" else if (danger) "⚠ 需要审批：$title" else "需要审批：$title",
            summary = if (kind == "input") "打开小梦回答主机上的问题" else subject,
        ), live = false)
        if (Build.VERSION.SDK_INT >= 26 && expiresAt > System.currentTimeMillis()) {
            b.setTimeoutAfter(expiresAt - System.currentTimeMillis())
        }
        try {
            Notifications.nm(this).notify(notifId, b.build())
        } catch (_: Throwable) {
        }
    }

    private fun notifyTaskDone(p: ProjectState) {
        val b = builder(Notifications.CHANNEL_TASKS)
            .setAutoCancel(true)
            .setContentIntent(activityIntent(p.projectId, p.sessionId, null))
        LiveNotificationTheme.apply(this, b, LiveNotificationState(
            LivePhase.DONE, "任务完成 · ${p.name}", p.summary,
        ), live = false)
        try {
            Notifications.nm(this).notify("done:${p.projectId}".hashCode() and 0x7fffffff, b.build())
        } catch (_: Throwable) {
        }
    }

    // ---------------------------------------------------------------- capsule

    private fun statusPriority(s: String): Int = LivePhase.fromStatus(s).priority

    /** Actionable states win; failures and offline projects must not disappear as idle. */
    private fun pickTop(): ProjectState? =
        projects.values
            .filter { statusPriority(it.status) < LivePhase.IDLE.priority }
            .minWithOrNull(compareBy({ statusPriority(it.status) }, { -it.lastEventAt }))

    private fun buildCapsule(): Notification {
        val top = pickTop()
        val phase = LivePhase.forConnection(connectionState, top?.status)
        val state = LiveNotificationState(
            phase, top?.name ?: "小梦 · 实时状态",
            if (connectionState == "online") top?.summary else null,
            top?.progressDone ?: -1, top?.progressTotal ?: -1,
        )
        val b = builder(Notifications.CHANNEL_LIVE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(activityIntent(top?.projectId, top?.sessionId, top?.approvalId))
        if (top != null) {
            b.addAction(action(if (phase == LivePhase.APPROVAL) "查看审批" else "查看任务",
                activityIntent(top.projectId, top.sessionId, top.approvalId)))
        }
        LiveNotificationTheme.apply(this, b, state, live = true)
        return b.build()
    }

    private fun refreshCapsule() {
        val n = buildCapsule()
        if (!foregroundStarted) {
            goForeground(n)
        } else {
            try {
                Notifications.nm(this).notify(Notifications.FG_NOTIF_ID, n)
            } catch (_: Throwable) {
            }
        }
    }

    /** Legacy MethodChannel show() lands here when the service is alive. */
    fun refreshExternal() {
        handler.post {
            if (!destroyed) refreshCapsule()
        }
    }
}
