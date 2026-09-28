package com.mitchel.claude_monitor

import org.junit.Assert.*
import org.junit.Test

class LiveNotificationStateTest {
    @Test fun disconnectOverridesStaleRunningOrApprovalState() {
        assertEquals(LivePhase.OFFLINE, LivePhase.forConnection("offline", "running"))
        assertEquals(LivePhase.OFFLINE, LivePhase.forConnection("offline", "needs_approval"))
        assertEquals(LivePhase.CONNECTING, LivePhase.forConnection("syncing", "done"))
        assertEquals(LivePhase.APPROVAL, LivePhase.forConnection("online", "needs_approval"))
        assertEquals(LivePhase.IDLE, LivePhase.forConnection("unconfigured", "running"))
    }

    @Test fun actionableErrorsAndOfflineDoNotBecomeIdle() {
        val statuses = listOf("done", "offline", "running", "error", "needs_approval")
        val ordered = statuses.sortedBy { LivePhase.fromStatus(it).priority }
        assertEquals(listOf("needs_approval", "error", "running", "offline", "done"), ordered)
        assertTrue(LivePhase.OFFLINE.priority < LivePhase.IDLE.priority)
        assertFalse(LivePhase.DONE.active)
        assertFalse(LivePhase.OFFLINE.active)
        assertFalse(LivePhase.IDLE.active)
        assertTrue(LivePhase.RUNNING.active)
    }

    @Test fun absentOrPausedProgressDoesNotInventACompletionPercentage() {
        for ((done, total) in listOf(-1 to 5, 3 to 0, 0 to -1)) {
            assertFalse(LiveNotificationState(LivePhase.RUNNING, "任务", done = done, total = total).hasProgress)
        }
        assertFalse(LiveNotificationState(LivePhase.OFFLINE, "任务", done = 3, total = 5).hasProgress)
        assertFalse(LiveNotificationState(LivePhase.APPROVAL, "任务", done = 3, total = 5).hasProgress)
        assertEquals("5 / 5", LiveNotificationState(LivePhase.RUNNING, "任务", done = 9, total = 5).progressLabel)
        assertEquals("0 / 5", LiveNotificationState(LivePhase.RUNNING, "任务", done = 0, total = 5).progressLabel)
    }

    @Test fun blankSummaryFallsBackToTheActualState() {
        assertEquals("连接已断开，正在尝试重连", LiveNotificationState(LivePhase.OFFLINE, "任务", "  ").detail)
        assertEquals("用户任务摘要", LiveNotificationState(LivePhase.RUNNING, "任务", " 用户任务摘要 ").detail)
    }
}
