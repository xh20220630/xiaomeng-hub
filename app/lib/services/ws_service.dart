import 'dart:async';
import 'dart:convert';
import 'package:web_socket_channel/web_socket_channel.dart';

enum WsStatus { connecting, connected, disconnected }

/// WebSocket client with automatic exponential-backoff reconnection.
/// Emits decoded JSON messages and connection-status changes as streams.
class WsService {
  final String url;
  WsService(this.url);

  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  Timer? _retry;
  int _attempt = 0;
  bool _disposed = false;
  bool _connected = false;

  final _messages = StreamController<Map<String, dynamic>>.broadcast();
  final _status = StreamController<WsStatus>.broadcast();

  Stream<Map<String, dynamic>> get messages => _messages.stream;
  Stream<WsStatus> get status => _status.stream;

  void connect() {
    if (_disposed) return;
    _status.add(WsStatus.connecting);
    try {
      final ch = WebSocketChannel.connect(Uri.parse(url));
      _channel = ch;
      ch.ready.then((_) {
        if (!_disposed && identical(_channel, ch)) {
          _connected = true;
          _status.add(WsStatus.connected);
        }
      }, onError: (Object _) => _scheduleReconnect());
      _sub = ch.stream.listen(
        (data) {
          _attempt = 0;
          _status.add(WsStatus.connected);
          try {
            _messages.add(jsonDecode(data as String) as Map<String, dynamic>);
          } catch (_) {
            /* ignore malformed frame */
          }
        },
        onError: (_) => _scheduleReconnect(),
        onDone: () => _scheduleReconnect(),
        cancelOnError: true,
      );
    } catch (_) {
      _scheduleReconnect();
    }
  }

  /// Upstream send (approval.respond / message.send / session.control).
  /// Returns true if the frame was handed to the socket, false if not connected.
  bool send(Map<String, dynamic> msg) {
    final ch = _channel;
    if (ch == null || !_connected) return false;
    try {
      ch.sink.add(jsonEncode(msg));
      return true;
    } catch (_) {
      return false;
    }
  }

  void _scheduleReconnect() {
    if (_disposed) return;
    _connected = false;
    _status.add(WsStatus.disconnected);
    _sub?.cancel();
    _sub = null;
    _channel = null;
    _retry?.cancel();
    final ms = (500 * (1 << _attempt)).clamp(500, 10000);
    if (_attempt < 5) _attempt++;
    _retry = Timer(Duration(milliseconds: ms), connect);
  }

  void dispose() {
    _disposed = true;
    _connected = false;
    _retry?.cancel();
    _sub?.cancel();
    _channel?.sink.close();
    _messages.close();
    _status.close();
  }
}
