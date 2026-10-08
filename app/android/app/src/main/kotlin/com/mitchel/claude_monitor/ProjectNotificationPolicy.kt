package com.mitchel.claude_monitor

internal object ProjectNotificationPolicy {
    // Legacy frames without timestamps cannot establish ordering.
    fun isOlder(previousAt: Long, incomingAt: Long): Boolean =
        previousAt > 0 && incomingAt > 0 && incomingAt < previousAt

    fun completesActiveTask(previousStatus: String?, incomingStatus: String): Boolean =
        incomingStatus == "done" && LivePhase.fromStatus(previousStatus).active
}
