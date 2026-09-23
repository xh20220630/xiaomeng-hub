import 'notification_service.dart';
// Pick the implementation at compile time: native uses dart:io + the plugin,
// web falls back to the no-op stub.
import 'notification_service_stub.dart'
    if (dart.library.io) 'notification_service_io.dart';

NotificationService createNotificationService() => NotificationServiceImpl();
