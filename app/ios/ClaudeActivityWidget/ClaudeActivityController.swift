//  ClaudeActivityController.swift
//  Runner (app side — NOT the widget extension)
//
//  Bridges the Flutter MethodChannel `app.claude.monitor/live_activity`
//  (see lib/services/live_activity/live_activity_channel.dart) to ActivityKit.
//  This file belongs to the *Runner* target, not the widget extension, but
//  lives alongside the widget for discoverability.
//
//  SCAFFOLD — not yet registered in AppDelegate and not built on Windows. The
//  method bodies show the intended ActivityKit calls but are commented where
//  they need a real device / iOS 16.1+ to compile against. See
//  app/NOTIFICATIONS_AND_LIVE_ACTIVITY.md for the wiring checklist.

import Foundation
import ActivityKit

@available(iOS 16.1, *)
final class ClaudeActivityController {
    static let shared = ClaudeActivityController()
    private init() {}

    /// activityId (UUID string) -> live Activity handle.
    private var activities: [String: Activity<ClaudeActivityAttributes>] = [:]

    /// TODO(ios): call from a FlutterMethodChannel handler registered in
    /// AppDelegate.didFinishLaunchingWithOptions:
    ///
    ///   let channel = FlutterMethodChannel(
    ///     name: "app.claude.monitor/live_activity",
    ///     binaryMessenger: controller.binaryMessenger)
    ///   channel.setMethodCallHandler { call, result in
    ///     switch call.method {
    ///     case "start":  result(ClaudeActivityController.shared.start(call.arguments))
    ///     case "update": ClaudeActivityController.shared.update(call.arguments); result(nil)
    ///     case "end":    ClaudeActivityController.shared.end(call.arguments); result(nil)
    ///     default:       result(FlutterMethodNotImplemented)
    ///     }
    ///   }

    func start(sessionId: String, title: String, status: String, approvalId: String?) -> String? {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return nil }
        let attributes = ClaudeActivityAttributes(sessionId: sessionId, title: title)
        let state = ClaudeActivityAttributes.ContentState(
            status: status,
            phase: approvalId == nil ? "running" : "needs_approval",
            approvalId: approvalId,
            detail: nil
        )
        do {
            // iOS 16.2+ uses ActivityContent; 16.1 uses the deprecated overload.
            let activity = try Activity.request(
                attributes: attributes,
                content: .init(state: state, staleDate: nil),
                pushType: nil // TODO(ios): set .token to receive APNs Live Activity push updates.
            )
            activities[activity.id] = activity
            return activity.id
        } catch {
            return nil
        }
    }

    func update(activityId: String, status: String, approvalId: String?) {
        guard let activity = activities[activityId] else { return }
        let state = ClaudeActivityAttributes.ContentState(
            status: status,
            phase: approvalId == nil ? "running" : "needs_approval",
            approvalId: approvalId,
            detail: nil
        )
        Task { await activity.update(.init(state: state, staleDate: nil)) }
    }

    func end(activityId: String, finalStatus: String) {
        guard let activity = activities[activityId] else { return }
        let state = ClaudeActivityAttributes.ContentState(
            status: finalStatus,
            phase: "done",
            approvalId: nil,
            detail: nil
        )
        Task {
            await activity.end(.init(state: state, staleDate: nil), dismissalPolicy: .default)
            activities[activityId] = nil
        }
    }
}
