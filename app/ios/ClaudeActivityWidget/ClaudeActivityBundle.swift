//  ClaudeActivityBundle.swift
//  ClaudeActivityWidget
//
//  WidgetBundle entry point for the widget extension target. Add more widgets
//  (home-screen widgets, etc.) here if needed.
//
//  SCAFFOLD — target not yet added to the Xcode project; cannot be built on
//  Windows. See app/NOTIFICATIONS_AND_LIVE_ACTIVITY.md.

import SwiftUI
import WidgetKit

@main
struct ClaudeActivityBundle: WidgetBundle {
    var body: some Widget {
        if #available(iOS 16.1, *) {
            ClaudeActivityWidget()
        }
    }
}
