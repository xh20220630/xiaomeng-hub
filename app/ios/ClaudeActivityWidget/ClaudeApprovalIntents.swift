//  ClaudeApprovalIntents.swift
//  ClaudeActivityWidget
//
//  App Intents that back the 批准 / 拒绝 buttons in the Live Activity. On iOS 17+
//  a `Button(intent:)` inside a Live Activity runs the intent in-process without
//  unlocking into the app, letting the user resolve an approval from the Lock
//  Screen or Dynamic Island.
//
//  SCAFFOLD — the `perform()` bodies only log. The real implementation must call
//  the bridge server's approval endpoint (or hand off to a shared App Group /
//  background task) and then update / end the Live Activity. Cannot be built or
//  verified on Windows. See app/NOTIFICATIONS_AND_LIVE_ACTIVITY.md.

import AppIntents
import ActivityKit

// MARK: - Approve

@available(iOS 17.0, *)
struct ApproveApprovalIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "批准请求"
    static var description = IntentDescription("批准 Claude 的命令或文件修改请求")

    @Parameter(title: "审批 ID")
    var approvalId: String

    init() {}
    init(approvalId: String) { self.approvalId = approvalId }

    func perform() async throws -> some IntentResult {
        // TODO(ios): POST decision=approve for `approvalId` to the bridge server
        // (reuse the same REST path as MonitorNotifier.respondApproval ->
        // ApiService.resolveApproval), then update/end the matching Live
        // Activity. Network here must tolerate the app being suspended/killed —
        // see the doc's "background approval" section (App Group + URLSession
        // background config, or APNs-triggered handling).
        ClaudeApprovalIntentLog.note("approve", approvalId)
        return .result()
    }
}

// MARK: - Reject

@available(iOS 17.0, *)
struct RejectApprovalIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "拒绝请求"
    static var description = IntentDescription("拒绝 Claude 的命令或文件修改请求")

    @Parameter(title: "审批 ID")
    var approvalId: String

    init() {}
    init(approvalId: String) { self.approvalId = approvalId }

    func perform() async throws -> some IntentResult {
        // TODO(ios): POST decision=reject for `approvalId`; see ApproveApprovalIntent.
        ClaudeApprovalIntentLog.note("reject", approvalId)
        return .result()
    }
}

// MARK: - Placeholder logging

enum ClaudeApprovalIntentLog {
    static func note(_ verb: String, _ approvalId: String) {
        #if DEBUG
        print("[ClaudeActivityWidget] \(verb) intent fired for approval=\(approvalId) (scaffold — no network yet)")
        #endif
    }
}
