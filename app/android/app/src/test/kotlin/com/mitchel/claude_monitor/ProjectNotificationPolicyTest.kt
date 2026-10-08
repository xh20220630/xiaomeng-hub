package com.mitchel.claude_monitor

import org.junit.Assert.*
import org.junit.Test

class ProjectNotificationPolicyTest {
    @Test fun lateRunningStateCannotUndoACompletedTask() {
        assertTrue(ProjectNotificationPolicy.isOlder(previousAt = 200, incomingAt = 100))
        assertFalse(ProjectNotificationPolicy.isOlder(previousAt = 200, incomingAt = 300))
        assertFalse(ProjectNotificationPolicy.isOlder(previousAt = 200, incomingAt = 200))
    }

    @Test fun missingTimestampsRemainCompatibleWithLegacyProjects() {
        assertFalse(ProjectNotificationPolicy.isOlder(previousAt = 200, incomingAt = 0))
        assertFalse(ProjectNotificationPolicy.isOlder(previousAt = 0, incomingAt = 100))
        assertFalse(ProjectNotificationPolicy.isOlder(previousAt = 0, incomingAt = 0))
    }

    @Test fun completionAlertsIncludeTasksWaitingForApprovalOrInput() {
        for (status in listOf("running", "needs_approval", "waiting_input")) {
            assertTrue(ProjectNotificationPolicy.completesActiveTask(status, "done"))
            assertFalse(ProjectNotificationPolicy.completesActiveTask(status, "error"))
            assertFalse(ProjectNotificationPolicy.completesActiveTask(status, "paused"))
        }
    }

    @Test fun initialAndRepeatedCompletedStatesDoNotAlert() {
        for (status in listOf(null, "done", "offline", "error", "paused", "ended", "rejected")) {
            assertFalse(ProjectNotificationPolicy.completesActiveTask(status, "done"))
        }
    }
}
