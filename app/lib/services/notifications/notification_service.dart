/// Cross-platform notification interface. The concrete implementation is chosen
/// at compile time via conditional import (see notification_factory.dart):
///   - native (mobile/desktop) -> flutter_local_notifications
///   - web                     -> no-op stub (plugin unsupported on web)
abstract class NotificationService {
  Future<void> init();
  Future<void> show(String title, String body, {String? payload});

  /// Show an approval request as a persistent, high-importance notification that
  /// carries inline action buttons (Android: 批准 / 拒绝). Tapping an action lets
  /// the user respond without opening the app. The [approvalId] is embedded in
  /// each action's payload so the tap handler can route the decision. On
  /// platforms that do not support notification actions (iOS uses Live
  /// Activities instead; web is a no-op) this falls back to a plain [show].
  Future<void> showApproval({
    required String approvalId,
    required String title,
    required String body,
  });
}
