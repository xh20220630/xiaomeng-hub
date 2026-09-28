package com.mitchel.claude_monitor

enum class LivePhase(val label: String, val detail: String, val priority: Int, val active: Boolean = false) {
    APPROVAL("待确认", "有件事，等你确认", 0, true),
    ERROR("出错了", "任务遇到问题，打开小梦查看", 1),
    RUNNING("运行中", "小梦正在专注处理", 2, true),
    INPUT("等回复", "打开小梦，继续这次对话", 3, true),
    NOTICE("有更新", "有新的任务消息", 4),
    OFFLINE("已离线", "连接已断开，正在尝试重连", 5),
    DONE("已完成", "这次任务，已顺利完成", 6),
    IDLE("待命中", "小梦在这里，等待新的任务", 7),
    CONNECTING("连接中", "正在同步主机任务状态", 8);

    companion object {
        fun fromStatus(status: String?): LivePhase = when (status) {
            "needs_approval" -> APPROVAL
            "error" -> ERROR
            "running" -> RUNNING
            "waiting_input" -> INPUT
            "notification" -> NOTICE
            "offline" -> OFFLINE
            "done" -> DONE
            "connecting", "syncing" -> CONNECTING
            else -> IDLE
        }

        fun forConnection(connection: String, status: String?): LivePhase = when (connection) {
            "online" -> fromStatus(status)
            "offline" -> OFFLINE
            "connecting", "syncing" -> CONNECTING
            else -> IDLE
        }
    }
}

data class LiveNotificationState(
    val phase: LivePhase,
    val title: String,
    val summary: String? = null,
    val done: Int = -1,
    val total: Int = -1,
) {
    val detail: String get() = summary?.trim()?.takeIf { it.isNotEmpty() } ?: phase.detail
    val hasProgress: Boolean get() = phase == LivePhase.RUNNING && total > 0 && done >= 0
    val progress: Int get() = if (hasProgress) done.coerceIn(0, total) else 0
    val progressLabel: String get() = if (hasProgress) "$progress / $total" else phase.label
}
