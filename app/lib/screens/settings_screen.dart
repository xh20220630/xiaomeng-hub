import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../services/api_service.dart';
import '../services/live_update.dart';
import '../state/settings.dart';
import '../theme/tokens.dart';
import '../widgets/studio_widgets.dart';
import '../widgets/dream_motion.dart';
import 'pair_host_screen.dart';

class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  late final TextEditingController _host;
  late final TextEditingController _port;
  late final TextEditingController _token;
  String? _testResult;
  bool _testing = false;
  bool _showToken = false;
  late Future<bool> _canPromote;

  @override
  void initState() {
    super.initState();
    final s = ref.read(settingsProvider);
    _host = TextEditingController(text: s.host);
    _port = TextEditingController(text: s.port.toString());
    _token = TextEditingController(text: s.token);
    _canPromote = LiveUpdate.canPromote();
  }

  @override
  void dispose() {
    _host.dispose();
    _port.dispose();
    _token.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final port = int.tryParse(_port.text.trim()) ?? 4820;
    await ref
        .read(settingsProvider.notifier)
        .update(_host.text.trim(), port, token: _token.text.trim());
    if (mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('已保存，正在用新地址重连')));
    }
  }

  Future<void> _scan() async {
    await Navigator.push<bool>(
      context,
      MaterialPageRoute(builder: (_) => const PairHostScreen()),
    );
    if (!mounted) return;
    final settings = ref.read(settingsProvider);
    _host.text = settings.host;
    _port.text = settings.port.toString();
    _token.text = settings.token;
    setState(() => _testResult = null);
  }

  Future<void> _test() async {
    setState(() {
      _testing = true;
      _testResult = null;
    });
    final port = int.tryParse(_port.text.trim()) ?? 4820;
    final ok = await ApiService(
      'http://${_host.text.trim()}:$port',
      token: _token.text.trim(),
    ).ping();
    if (mounted) {
      setState(() {
        _testing = false;
        _testResult = ok ? '连接成功 ✓' : '连接失败 ✗（检查 IP/端口与同一网络）';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(settingsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('连接设置')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              const DreamPageIntro(
                title: '让小梦，\n找到你的电脑。',
                subtitle: '灵感在设备之间，自由接力。',
                icon: Icons.link_rounded,
                art: 'assets/ui-v3/settings-art.png',
              ),
              const SizedBox(height: 28),
              FilledButton.icon(
                onPressed: _scan,
                icon: const Icon(Icons.qr_code_scanner_rounded),
                label: const Text('扫码绑定宿主机'),
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 18),
                ),
              ),
              const SizedBox(height: 10),
              Text(
                '推荐 · 扫描电脑连接页面的二维码，自动填写连接信息',
                style: AppFont.ui(size: 12, color: AppColors.textSecondary),
              ),
              const SizedBox(height: 28),
              Text(
                '手动连接',
                style: AppFont.ui(size: 19, weight: FontWeight.w600),
              ),
              const SizedBox(height: 14),
              DreamReveal(
                child: Container(
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: AppColors.card,
                    borderRadius: BorderRadius.circular(AppRadii.card),
                    border: Border.all(color: AppColors.borderWarm),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      TextField(
                        controller: _host,
                        decoration: const InputDecoration(
                          labelText: '主机 (PC 的局域网 IP)',
                          hintText: '例如 192.168.0.194',
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: _port,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(
                          labelText: '端口',
                          hintText: '4820',
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: _token,
                        obscureText: !_showToken,
                        decoration: InputDecoration(
                          suffixIcon: IconButton(
                            tooltip: _showToken ? '隐藏令牌' : '显示令牌',
                            onPressed: () =>
                                setState(() => _showToken = !_showToken),
                            icon: Icon(
                              _showToken
                                  ? Icons.visibility_off_outlined
                                  : Icons.visibility_outlined,
                            ),
                          ),
                          labelText: '访问令牌 Token（可选）',
                          hintText: '填写主机中心提供的访问令牌',
                        ),
                      ),
                      const SizedBox(height: 20),
                      FilledButton.icon(
                        onPressed: _save,
                        icon: const Icon(Icons.check_rounded, size: 18),
                        label: const Text('保存并重连'),
                      ),
                      const SizedBox(height: 10),
                      OutlinedButton.icon(
                        onPressed: _testing ? null : _test,
                        icon: _testing
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.wifi_tethering, size: 18),
                        label: const Text('测试连接'),
                        style: OutlinedButton.styleFrom(
                          padding: const EdgeInsets.symmetric(vertical: 16),
                        ),
                      ),
                      if (_testResult != null) ...[
                        const SizedBox(height: 12),
                        Text(
                          _testResult!,
                          style: TextStyle(
                            color: _testResult!.contains('成功')
                                ? AppColors.success
                                : AppColors.danger,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 28),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        '当前连接',
                        style: TextStyle(fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(height: 8),
                      _kv('中心地址', settings.baseUrl),
                      _kv('Token', settings.token.isEmpty ? '（未设置）' : '已设置'),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),
              if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android)
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          '通知诊断',
                          style: TextStyle(fontWeight: FontWeight.w600),
                        ),
                        const SizedBox(height: 10),
                        FutureBuilder<bool>(
                          future: _canPromote,
                          builder: (context, snap) {
                            final checking =
                                snap.connectionState != ConnectionState.done;
                            final ok = snap.data ?? false;
                            return Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Icon(
                                      checking
                                          ? Icons.hourglass_empty
                                          : (ok
                                                ? Icons.check_circle
                                                : Icons.cancel),
                                      size: 18,
                                      color: checking
                                          ? AppColors.textPlaceholder
                                          : (ok
                                                ? AppColors.success
                                                : AppColors.danger),
                                    ),
                                    const SizedBox(width: 8),
                                    Text(
                                      checking
                                          ? '正在检测实时通知胶囊…'
                                          : (ok ? '实时通知胶囊可用 ✓' : '实时通知胶囊不可用'),
                                      style: const TextStyle(fontSize: 13),
                                    ),
                                  ],
                                ),
                                if (!checking && !ok) ...[
                                  const SizedBox(height: 10),
                                  OutlinedButton.icon(
                                    onPressed: () async {
                                      await LiveUpdate.openPromotedSettings();
                                      if (mounted) {
                                        setState(
                                          () => _canPromote =
                                              LiveUpdate.canPromote(),
                                        );
                                      }
                                    },
                                    icon: const Icon(
                                      Icons.notifications_active_outlined,
                                    ),
                                    label: const Text('去开启实时通知'),
                                  ),
                                ],
                              ],
                            );
                          },
                        ),
                        const SizedBox(height: 10),
                        const Text(
                          'ColorOS(OPPO/一加/realme) 用户：请在「通知与状态栏」里允许本应用的'
                          '「实时通知 / 流体云」，并到「应用自启动」把本应用加入白名单，'
                          '否则通知胶囊与后台连接可能被系统限制。',
                          style: TextStyle(
                            color: AppColors.textPlaceholder,
                            fontSize: 12,
                            height: 1.5,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              const SizedBox(height: 16),
              const Text(
                '提示：手机与电脑需在同一 Wi-Fi。在电脑上启动服务器后，它会打印可用的局域网 IP，填到上面即可。',
                style: TextStyle(
                  color: AppColors.textPlaceholder,
                  fontSize: 12,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _kv(String k, String v) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 2),
    child: Row(
      children: [
        SizedBox(
          width: 90,
          child: Text(
            k,
            style: const TextStyle(
              color: AppColors.textSecondary,
              fontSize: 13,
            ),
          ),
        ),
        Expanded(
          child: Text(
            v,
            style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
          ),
        ),
      ],
    ),
  );
}
