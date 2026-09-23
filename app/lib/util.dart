String shortId(String id) => id.length <= 8 ? id : id.substring(0, 8);

/// Last path segment of a working directory, e.g. D:\dev\api-server -> api-server.
String? projectNameFromCwd(String? cwd) {
  if (cwd == null || cwd.isEmpty) return null;
  final parts = cwd.split(RegExp(r'[\\/]')).where((s) => s.isNotEmpty).toList();
  return parts.isEmpty ? null : parts.last;
}

String timeAgo(int? ms) {
  if (ms == null) return '';
  final d = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(ms));
  if (d.inSeconds < 60) return '${d.inSeconds}秒前';
  if (d.inMinutes < 60) return '${d.inMinutes}分钟前';
  if (d.inHours < 24) return '${d.inHours}小时前';
  return '${d.inDays}天前';
}

/// Whether [ms] (epoch millis) falls on today's local calendar date.
bool isToday(int? ms) {
  if (ms == null || ms <= 0) return false;
  final t = DateTime.fromMillisecondsSinceEpoch(ms);
  final n = DateTime.now();
  return t.year == n.year && t.month == n.month && t.day == n.day;
}

String hms(int? ms) {
  if (ms == null) return '';
  final t = DateTime.fromMillisecondsSinceEpoch(ms);
  String two(int n) => n.toString().padLeft(2, '0');
  return '${two(t.hour)}:${two(t.minute)}:${two(t.second)}';
}
