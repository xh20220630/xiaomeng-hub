import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../services/pairing_service.dart';
import '../state/settings.dart';
import '../state/device_identity.dart';
import '../theme/tokens.dart';

class PairHostScreen extends ConsumerStatefulWidget {
  const PairHostScreen({super.key});
  @override
  ConsumerState<PairHostScreen> createState() => _PairHostScreenState();
}

class _PairHostScreenState extends ConsumerState<PairHostScreen> {
  final _service = PairingService();
  final _deviceName = TextEditingController();
  PairingLink? _link;
  String _nonce = '';
  String? _error;
  bool _scanning = true;
  bool _busy = false;
  bool _success = false;
  int _cameraKey = 0;

  bool get _mobile =>
      !kIsWeb &&
      [
        TargetPlatform.android,
        TargetPlatform.iOS,
      ].contains(defaultTargetPlatform);

  @override
  void initState() {
    super.initState();
    _deviceName.text = defaultTargetPlatform == TargetPlatform.iOS
        ? '我的 iPhone'
        : '我的 Android 手机';
  }

  @override
  void dispose() {
    _service.close();
    _deviceName.dispose();
    super.dispose();
  }

  void _read(String raw) {
    if (_busy || _link != null) return;
    setState(() {
      _scanning = false;
      _error = null;
      try {
        _link = PairingLink.parse(raw);
        _nonce = newPairingNonce();
      } on PairingException catch (error) {
        _error = error.message;
      }
    });
  }

  void _reset() => setState(() {
    _link = null;
    _error = null;
    _scanning = true;
    _cameraKey++;
  });

  Future<void> _paste() async {
    setState(() => _scanning = false);
    final value = await showDialog<String>(
      context: context,
      builder: (context) => const _PairingLinkDialog(),
    );
    if (!mounted) return;
    if (value != null && value.trim().isNotEmpty) {
      _read(value);
    } else {
      _reset();
    }
  }

  Future<void> _bind() async {
    if (_link == null || _busy) return;
    if (_deviceName.text.trim().isEmpty) {
      setState(() => _error = '请为这台手机填写一个名称。');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final settings = await _service.exchange(
        _link!,
        clientNonce: _nonce,
        installationId: await ref.read(pairingIdentityProvider.future),
        currentSettings: ref.read(settingsProvider),
        deviceName: _deviceName.text,
        platform: defaultTargetPlatform == TargetPlatform.iOS
            ? 'ios'
            : 'android',
      );
      if (!mounted) return;
      await ref
          .read(settingsProvider.notifier)
          .update(settings.host, settings.port, token: settings.token);
      if (mounted) setState(() => _success = true);
    } catch (error) {
      if (mounted) {
        setState(
          () => _error = error is PairingException
              ? error.message
              : '未能保存连接，请重试。',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: !_busy,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('扫码连接'),
          leading: IconButton(
            tooltip: '返回',
            icon: const Icon(Icons.arrow_back_rounded),
            onPressed: _busy ? null : () => Navigator.pop(context, _success),
          ),
        ),
        body: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: ListView(
              padding: const EdgeInsets.all(24),
              children: [
                Text(
                  _success
                      ? '连接已就绪。'
                      : _link == null
                      ? '扫一扫，\n和电脑连在一起。'
                      : '找到你的电脑了。',
                  style: AppFont.ui(
                    size: 29,
                    weight: FontWeight.w600,
                    height: 1.4,
                  ),
                ),
                const SizedBox(height: 10),
                Text(
                  _success
                      ? '连接信息已保存，小梦正在同步主机上的任务。'
                      : _link == null
                      ? '在电脑上打开后端连接页面，将二维码放入取景框。'
                      : '核对主机信息，确认后即可绑定。',
                  style: AppFont.ui(
                    color: AppColors.textSecondary,
                    height: 1.7,
                  ),
                ),
                const SizedBox(height: 26),
                if (_success)
                  _successCard()
                else if (_link != null)
                  _confirmation()
                else ...[
                  ClipRRect(
                    borderRadius: BorderRadius.circular(AppRadii.card),
                    child: AspectRatio(
                      aspectRatio: 1,
                      child: ColoredBox(
                        color: AppColors.night,
                        child: _mobile && _scanning
                            ? MobileScanner(
                                key: ValueKey(_cameraKey),
                                tapToFocus: true,
                                onDetect: (capture) {
                                  if (!_scanning || _link != null) return;
                                  for (final barcode in capture.barcodes) {
                                    if (barcode.rawValue != null) {
                                      _read(barcode.rawValue!);
                                      break;
                                    }
                                  }
                                },
                                errorBuilder: (context, error) =>
                                    _cameraMessage(
                                      '相机暂时无法使用',
                                      '请在系统设置中允许小梦使用相机，返回后点击重试。',
                                      retry: true,
                                    ),
                                overlayBuilder: (context, constraints) =>
                                    IgnorePointer(
                                      child: Center(
                                        child: FractionallySizedBox(
                                          widthFactor: .76,
                                          heightFactor: .76,
                                          child: DecoratedBox(
                                            decoration: BoxDecoration(
                                              border: Border.all(
                                                color: AppColors.lime,
                                                width: 2,
                                              ),
                                              borderRadius:
                                                  BorderRadius.circular(
                                                    AppRadii.card,
                                                  ),
                                            ),
                                          ),
                                        ),
                                      ),
                                    ),
                              )
                            : _cameraMessage(
                                _mobile ? '准备好后，重新扫一扫' : '请使用手机 APP 扫码',
                                _mobile
                                    ? '也可以粘贴电脑上的绑定链接。'
                                    : '桌面和网页端请使用连接设置中的手动连接。',
                                retry: _mobile,
                              ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 18),
                  if (_mobile)
                    OutlinedButton.icon(
                      onPressed: _paste,
                      icon: const Icon(Icons.content_paste_rounded, size: 19),
                      label: const Text('粘贴绑定链接'),
                    ),
                  const SizedBox(height: 18),
                  const Text(
                    '电脑端入口： http://localhost:4820/pair/\n手机与电脑需处于同一 Wi-Fi 或局域网。自定义端口请使用后端启动时显示的地址。',
                    style: TextStyle(
                      color: AppColors.textSecondary,
                      fontSize: 12,
                      height: 1.8,
                    ),
                  ),
                ],
                if (_error != null) ...[
                  const SizedBox(height: 18),
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: AppColors.warnBarBg,
                      borderRadius: BorderRadius.circular(16),
                    ),
                    child: Text(
                      _error!,
                      style: AppFont.ui(
                        size: 13,
                        color: AppColors.danger,
                        height: 1.6,
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _cameraMessage(
    String title,
    String subtitle, {
    bool retry = false,
  }) => Padding(
    padding: const EdgeInsets.all(26),
    child: Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        const Icon(
          Icons.qr_code_scanner_rounded,
          color: AppColors.lime,
          size: 48,
        ),
        const SizedBox(height: 18),
        Text(
          title,
          textAlign: TextAlign.center,
          style: AppFont.ui(color: AppColors.onNight, size: 17),
        ),
        const SizedBox(height: 10),
        Text(
          subtitle,
          textAlign: TextAlign.center,
          style: AppFont.ui(color: AppColors.nightMuted, size: 12, height: 1.6),
        ),
        if (retry) ...[
          const SizedBox(height: 14),
          TextButton(
            onPressed: _reset,
            child: const Text('重新扫码', style: TextStyle(color: AppColors.lime)),
          ),
        ],
      ],
    ),
  );

  Widget _confirmation() => Container(
    padding: const EdgeInsets.all(24),
    decoration: BoxDecoration(
      color: AppColors.card,
      borderRadius: BorderRadius.circular(AppRadii.card),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Align(
          alignment: Alignment.centerLeft,
          child: CircleAvatar(
            radius: 28,
            backgroundColor: AppColors.halo,
            child: Icon(Icons.computer_rounded, color: AppColors.ink, size: 28),
          ),
        ),
        const SizedBox(height: 20),
        Text(
          _link!.hostName,
          style: AppFont.ui(size: 22, weight: FontWeight.w600),
        ),
        const SizedBox(height: 8),
        Text(
          _link!.server.toString(),
          style: AppFont.mono(size: 13, color: AppColors.textSecondary),
        ),
        const SizedBox(height: 24),
        TextField(
          controller: _deviceName,
          enabled: !_busy,
          maxLength: 60,
          decoration: const InputDecoration(
            labelText: '这台手机的名称',
            helperText: '方便在电脑上辨认和管理已绑定设备',
          ),
        ),
        const SizedBox(height: 16),
        const Text(
          '绑定后，可以查看任务、发送消息和处理审批。确认这是你信任的宿主机。绑定会替换当前 APP 的主机连接。',
          style: TextStyle(
            color: AppColors.textSecondary,
            fontSize: 12,
            height: 1.8,
          ),
        ),
        const SizedBox(height: 24),
        FilledButton.icon(
          onPressed: _busy ? null : _bind,
          icon: _busy
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.link_rounded),
          label: Text(_busy ? '正在绑定…' : '确认绑定'),
        ),
        const SizedBox(height: 10),
        TextButton(onPressed: _busy ? null : _reset, child: const Text('重新扫码')),
      ],
    ),
  );

  Widget _successCard() => Container(
    padding: const EdgeInsets.all(28),
    decoration: BoxDecoration(
      color: AppColors.night,
      borderRadius: BorderRadius.circular(AppRadii.card),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.check_circle_rounded, color: AppColors.lime, size: 64),
        const SizedBox(height: 20),
        Text(
          '已绑定 ${_link!.hostName}',
          textAlign: TextAlign.center,
          style: AppFont.ui(
            color: AppColors.onNight,
            size: 20,
            weight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 12),
        Text(
          '下次打开 APP，会自动连接这台宿主机。',
          textAlign: TextAlign.center,
          style: AppFont.ui(color: AppColors.nightMuted, size: 13, height: 1.6),
        ),
        const SizedBox(height: 26),
        FilledButton(
          onPressed: () => Navigator.pop(context, true),
          child: const Text('完成，开始使用'),
        ),
      ],
    ),
  );
}

class _PairingLinkDialog extends StatefulWidget {
  const _PairingLinkDialog();
  @override
  State<_PairingLinkDialog> createState() => _PairingLinkDialogState();
}

class _PairingLinkDialogState extends State<_PairingLinkDialog> {
  final _controller = TextEditingController();
  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('粘贴绑定链接'),
    content: TextField(
      controller: _controller,
      autofocus: true,
      minLines: 3,
      maxLines: 5,
      decoration: const InputDecoration(
        hintText: '粘贴电脑连接页面复制的 xiaomeng://pair 链接',
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('取消'),
      ),
      FilledButton(
        onPressed: () => Navigator.pop(context, _controller.text),
        child: const Text('继续'),
      ),
    ],
  );
}
