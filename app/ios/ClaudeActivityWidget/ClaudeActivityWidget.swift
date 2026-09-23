//  ClaudeActivityWidget.swift
//  ClaudeActivityWidget
//
//  The WidgetKit + ActivityKit widget that renders the Claude task Live
//  Activity on the Lock Screen and in the Dynamic Island (compact + expanded).
//
//  SCAFFOLD — placeholder layout only, pixel polish deferred. Colors mirror the
//  warm-paper theme: accent #D97757 (primary), ink #3A352F, success #6F8F6A.
//  Requires iOS 16.1+. Not yet added to the Xcode project; cannot be built on
//  Windows. See app/NOTIFICATIONS_AND_LIVE_ACTIVITY.md.

import SwiftUI
import WidgetKit
import ActivityKit

// MARK: - Theme (mirrors lib/theme/tokens.dart)

private enum ClaudeTheme {
    static let primary = Color(red: 0xD9 / 255, green: 0x77 / 255, blue: 0x57 / 255)
    static let ink = Color(red: 0x3A / 255, green: 0x35 / 255, blue: 0x2F / 255)
    static let success = Color(red: 0x6F / 255, green: 0x8F / 255, blue: 0x6A / 255)
    static let danger = Color(red: 0xD9 / 255, green: 0x8A / 255, blue: 0x7A / 255)

    /// Accent color for a given coarse phase string.
    static func accent(for phase: String) -> Color {
        switch phase {
        case "done": return success
        case "error": return danger
        default: return primary // running / needs_approval
        }
    }

    /// SF Symbol for a given coarse phase string.
    static func symbol(for phase: String) -> String {
        switch phase {
        case "done": return "checkmark.circle.fill"
        case "error": return "exclamationmark.triangle.fill"
        case "needs_approval": return "bell.badge.fill"
        default: return "arrow.triangle.2.circlepath" // running
        }
    }
}

// MARK: - Widget

@available(iOS 16.1, *)
struct ClaudeActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ClaudeActivityAttributes.self) { context in
            // ---- Lock Screen / banner presentation ----
            ClaudeLockScreenView(context: context)
                .activityBackgroundTint(Color.black.opacity(0.04))
                .activitySystemActionForegroundColor(ClaudeTheme.ink)
        } dynamicIsland: { context in
            // ---- Dynamic Island ----
            DynamicIsland {
                // Expanded regions.
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: ClaudeTheme.symbol(for: context.state.phase))
                        .foregroundColor(ClaudeTheme.accent(for: context.state.phase))
                        .font(.title2)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.status)
                        .font(.caption.weight(.semibold))
                        .foregroundColor(ClaudeTheme.ink)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.title)
                        .font(.headline)
                        .lineLimit(1)
                        .foregroundColor(ClaudeTheme.ink)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if let approvalId = context.state.approvalId {
                        ClaudeApprovalButtons(approvalId: approvalId)
                    } else if let detail = context.state.detail {
                        Text(detail)
                            .font(.caption2)
                            .lineLimit(1)
                            .foregroundColor(.secondary)
                    }
                }
            } compactLeading: {
                Image(systemName: ClaudeTheme.symbol(for: context.state.phase))
                    .foregroundColor(ClaudeTheme.accent(for: context.state.phase))
            } compactTrailing: {
                Text(context.state.status)
                    .font(.caption2.weight(.semibold))
                    .foregroundColor(ClaudeTheme.accent(for: context.state.phase))
                    .lineLimit(1)
            } minimal: {
                Image(systemName: ClaudeTheme.symbol(for: context.state.phase))
                    .foregroundColor(ClaudeTheme.accent(for: context.state.phase))
            }
            .widgetURL(URL(string: "claudemonitor://session/\(context.attributes.sessionId)"))
            .keylineTint(ClaudeTheme.accent(for: context.state.phase))
        }
    }
}

// MARK: - Lock Screen view

@available(iOS 16.1, *)
private struct ClaudeLockScreenView: View {
    let context: ActivityViewContext<ClaudeActivityAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: ClaudeTheme.symbol(for: context.state.phase))
                    .foregroundColor(ClaudeTheme.accent(for: context.state.phase))
                    .font(.title3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(context.attributes.title)
                        .font(.headline)
                        .foregroundColor(ClaudeTheme.ink)
                        .lineLimit(1)
                    Text(context.state.status)
                        .font(.subheadline)
                        .foregroundColor(ClaudeTheme.accent(for: context.state.phase))
                        .lineLimit(1)
                }
                Spacer()
            }
            if let detail = context.state.detail {
                Text(detail)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(2)
            }
            if let approvalId = context.state.approvalId {
                ClaudeApprovalButtons(approvalId: approvalId)
            }
        }
        .padding(14)
    }
}

// MARK: - Approval action buttons (App Intents)

/// 批准 / 拒绝 buttons backed by App Intents so the user can resolve an approval
/// straight from the Lock Screen / Dynamic Island without unlocking into the app.
@available(iOS 16.1, *)
private struct ClaudeApprovalButtons: View {
    let approvalId: String

    var body: some View {
        if #available(iOS 17.0, *) {
            HStack(spacing: 10) {
                // `Button(intent:)` requires iOS 17 / AppIntents interactivity.
                Button(intent: RejectApprovalIntent(approvalId: approvalId)) {
                    Text("拒绝").frame(maxWidth: .infinity)
                }
                .tint(ClaudeTheme.ink)

                Button(intent: ApproveApprovalIntent(approvalId: approvalId)) {
                    Text("批准").frame(maxWidth: .infinity)
                }
                .tint(ClaudeTheme.primary)
            }
            .buttonStyle(.borderedProminent)
            .font(.subheadline.weight(.bold))
        } else {
            // iOS 16.x: interactive buttons in Live Activities are unavailable;
            // tapping the activity deep-links into the in-app approval drawer.
            Text("点按打开以批准")
                .font(.caption)
                .foregroundColor(ClaudeTheme.primary)
        }
    }
}
