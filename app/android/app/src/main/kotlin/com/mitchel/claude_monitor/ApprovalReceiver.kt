package com.mitchel.claude_monitor

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Handles 批准/拒绝 taps on approval notifications: POSTs the decision to
 * {baseUrl}/api/approvals/{id} (idempotent on the server) and cancels the
 * notification on success. Runs the network call off the main thread via
 * goAsync so the broadcast doesn't ANR.
 */
class ApprovalReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_APPROVE = "com.mitchel.claude_monitor.action.APPROVE"
        const val ACTION_REJECT = "com.mitchel.claude_monitor.action.REJECT"
        const val EXTRA_APPROVAL_ID = "approvalId"
        const val EXTRA_NOTIF_ID = "notifId"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val decision = when (intent.action) {
            ACTION_APPROVE -> "approve"
            ACTION_REJECT -> "reject"
            else -> return
        }
        val approvalId = intent.getStringExtra(EXTRA_APPROVAL_ID) ?: return
        val notifId = intent.getIntExtra(EXTRA_NOTIF_ID, -1)

        val prefs = context.getSharedPreferences(Notifications.PREFS, Context.MODE_PRIVATE)
        val baseUrl = prefs.getString("baseUrl", null)?.takeIf { it.isNotBlank() } ?: return
        val token = prefs.getString("token", null)?.takeIf { it.isNotBlank() }
        val appContext = context.applicationContext

        val pending = goAsync()
        Thread {
            try {
                val body = JSONObject()
                    .put("decision", decision)
                    .put("scope", "once")
                    .toString()
                    .toRequestBody("application/json; charset=utf-8".toMediaType())
                val req = Request.Builder()
                    .url(baseUrl.trimEnd('/') + "/api/approvals/" + approvalId)
                    .post(body)
                    .apply { if (token != null) header("Authorization", "Bearer $token") }
                    .build()
                val client = OkHttpClient.Builder()
                    .connectTimeout(10, TimeUnit.SECONDS)
                    .readTimeout(15, TimeUnit.SECONDS)
                    .build()
                client.newCall(req).execute().use { resp ->
                    val result = if (resp.isSuccessful) JSONObject(resp.body?.string() ?: "{}") else null
                    // A queued remote decision stays visible until the agent acknowledges it.
                    if (resp.isSuccessful && result?.optString("status") in listOf("approved", "denied", "expired") && notifId != -1) {
                        val nm = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                        nm.cancel(notifId)
                    }
                }
            } catch (_: Throwable) {
                // Network failed — keep the notification so the user can retry.
            } finally {
                pending.finish()
            }
        }.start()
    }
}
