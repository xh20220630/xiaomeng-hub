import 'notification_service.dart';

/// Web build: notifications are not supported by flutter_local_notifications,
/// so this is a no-op. (Live updates still arrive via WebSocket in-app.)
class NotificationServiceImpl implements NotificationService {
  @override
  Future<void> init() async {}

  @override
  Future<void> show(String title, String body, {String? payload}) async {}

  @override
  Future<void> showApproval({
    required String approvalId,
    required String title,
    required String body,
  }) async {}
}
