//  ClaudeActivityAttributes.swift
//  ClaudeActivityWidget
//
//  Live Activity data contract shared between the Runner app (which starts /
//  updates / ends the activity via ActivityKit) and the widget extension (which
//  renders the Dynamic Island + Lock Screen UI).
//
//  SCAFFOLD — this target is not yet added to the Xcode project and cannot be
//  built or verified on Windows (no Apple toolchain). See
//  app/NOTIFICATIONS_AND_LIVE_ACTIVITY.md for the wiring checklist.

import Foundation
import ActivityKit

/// The attributes describe the *static* properties of a Claude task Live
/// Activity (fixed for the lifetime of the activity) plus a nested
/// `ContentState` that holds the *dynamic* part updated over time.
struct ClaudeActivityAttributes: ActivityAttributes {
    public typealias ContentState = ClaudeContentState

    /// Stable, set once when the activity is requested.
    let sessionId: String
    /// Project / task display name, e.g. "cc_project".
    let title: String

    /// Mutable content pushed via `activity.update(...)` or APNs Live Activity
    /// push. Codable + Hashable as required by ActivityKit.
    struct ClaudeContentState: Codable, Hashable {
        /// Short Chinese status line, e.g. 「运行中」「等待审批」「已完成」.
        var status: String
        /// Coarse phase used to pick the icon / accent color.
        /// One of: "running" | "needs_approval" | "done" | "error".
        var phase: String
        /// Non-nil when an approval is pending; drives the 批准 / 拒绝 buttons.
        var approvalId: String?
        /// Optional one-line summary of the current command / file edit.
        var detail: String?
    }
}
