import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/app_updates.dart';
import '../theme/tokens.dart';

class AppVersionScreen extends ConsumerStatefulWidget {
  const AppVersionScreen({super.key});

  @override
  ConsumerState<AppVersionScreen> createState() => _AppVersionScreenState();
}

class _AppVersionScreenState extends ConsumerState<AppVersionScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) ref.read(appUpdatesProvider).initialize();
    });
  }

  @override
  Widget build(BuildContext context) {
    final updates = ref.watch(appUpdatesProvider);
    return ListenableBuilder(
      listenable: updates,
      builder: (context, _) {
        final release = updates.available;
        final checked = updates.lastChecked?.toLocal();
        return Scaffold(
          appBar: AppBar(title: const Text('版本管理')),
          body: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 640),
              child: ListView(
                padding: const EdgeInsets.all(24),
                children: [
                  _Panel(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(
                          Icons.system_update_rounded,
                          size: 36,
                          color: AppColors.primaryDeep,
                        ),
                        const SizedBox(height: 20),
                        Text(
                          '让小梦，持续进步。',
                          style: AppFont.ui(size: 26, weight: FontWeight.w600),
                        ),
                        const SizedBox(height: 10),
                        Text(
                          '当前版本',
                          style: AppFont.ui(color: AppColors.textSecondary),
                        ),
                        const SizedBox(height: 6),
                        SelectableText(
                          updates.installed?.label ??
                              (updates.supported ? '正在读取…' : '当前平台暂不支持应用内更新'),
                          style: AppFont.ui(size: 18, weight: FontWeight.w600),
                        ),
                        if (updates.debugSigned) ...[
                          const SizedBox(height: 8),
                          const Text('测试签名 · 可接收测试版更新'),
                        ],
                        const SizedBox(height: 24),
                        SizedBox(
                          width: double.infinity,
                          child: FilledButton.icon(
                            onPressed: updates.busy || !updates.supported
                                ? null
                                : () => updates.check(),
                            icon: updates.checking
                                ? const SizedBox(
                                    width: 18,
                                    height: 18,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  )
                                : const Icon(Icons.refresh_rounded),
                            label: Text(updates.checking ? '正在检查…' : '检查更新'),
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          checked == null
                              ? '尚未检查版本'
                              : '上次检查：${checked.toString().substring(0, 16)}',
                          style: AppFont.ui(
                            size: 12,
                            color: AppColors.textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (updates.message != null) ...[
                    const SizedBox(height: 16),
                    Semantics(liveRegion: true, child: Text(updates.message!)),
                  ],
                  if (release != null) ...[
                    const SizedBox(height: 20),
                    _Panel(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            updates.ready ? '更新已就绪' : '发现新版本',
                            style: AppFont.ui(
                              size: 20,
                              weight: FontWeight.w600,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            '${release.version.label} · ${release.preview ? '测试版' : '正式版'}',
                          ),
                          const SizedBox(height: 6),
                          Text(
                            'Android 安装包 · ${release.sizeLabel}',
                            style: AppFont.ui(color: AppColors.textSecondary),
                          ),
                          const SizedBox(height: 20),
                          if (updates.downloading) ...[
                            LinearProgressIndicator(value: updates.progress),
                            const SizedBox(height: 8),
                            Text(
                              updates.progress >= 1
                                  ? '正在校验安装包…'
                                  : '正在下载 ${(updates.progress * 100).toStringAsFixed(0)}%',
                            ),
                            TextButton(
                              onPressed: updates.cancel,
                              child: const Text('取消下载'),
                            ),
                          ] else
                            FilledButton.icon(
                              onPressed: updates.busy
                                  ? null
                                  : updates.ready
                                  ? updates.install
                                  : () => updates.download(),
                              icon: Icon(
                                updates.ready
                                    ? Icons.install_mobile_rounded
                                    : Icons.download_rounded,
                              ),
                              label: Text(
                                updates.installing
                                    ? '正在准备安装…'
                                    : updates.ready
                                    ? '安装更新'
                                    : '下载更新（${release.sizeLabel}）',
                              ),
                            ),
                          const SizedBox(height: 20),
                          Text(
                            '更新说明',
                            style: AppFont.ui(weight: FontWeight.w600),
                          ),
                          const SizedBox(height: 8),
                          SelectableText(
                            release.notes.isEmpty
                                ? '此版本未提供更新说明。'
                                : release.notes,
                          ),
                        ],
                      ),
                    ),
                  ],
                  const SizedBox(height: 24),
                  Text(
                    '更新偏好',
                    style: AppFont.ui(size: 19, weight: FontWeight.w600),
                  ),
                  const SizedBox(height: 12),
                  _Panel(
                    child: Column(
                      children: [
                        SwitchListTile.adaptive(
                          contentPadding: EdgeInsets.zero,
                          title: const Text('自动检查更新'),
                          subtitle: const Text('启动或回到前台时检查，每 6 小时最多一次'),
                          value: updates.autoCheck,
                          onChanged: updates.busy || !updates.supported
                              ? null
                              : (v) => updates.setOption('autoCheck', v),
                        ),
                        const Divider(),
                        SwitchListTile.adaptive(
                          contentPadding: EdgeInsets.zero,
                          title: const Text('自动下载更新'),
                          subtitle: const Text('应用运行时在非计费 Wi-Fi 下下载，安装前由你确认'),
                          value: updates.autoDownload,
                          onChanged: updates.busy || !updates.supported
                              ? null
                              : (v) => updates.setOption('autoDownload', v),
                        ),
                        const Divider(),
                        SwitchListTile.adaptive(
                          contentPadding: EdgeInsets.zero,
                          title: const Text('接收测试版'),
                          subtitle: const Text('同时检查 GitHub 上的预发布版本'),
                          value: updates.previews,
                          onChanged: updates.busy || !updates.supported
                              ? null
                              : (v) => updates.setOption('previews', v),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 20),
                  Text(
                    '更新来自小梦官方 GitHub 仓库。下载后会校验文件完整性和应用签名。首次安装需允许此应用安装更新；Android 会显示安装确认界面。应用关闭后，下次打开会继续检查；未完成的下载将重新开始。',
                    style: AppFont.ui(
                      size: 12,
                      color: AppColors.textSecondary,
                      height: 1.7,
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class _Panel extends StatelessWidget {
  final Widget child;
  const _Panel({required this.child});

  @override
  Widget build(BuildContext context) => Material(
    color: AppColors.card,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(AppRadii.card),
      side: const BorderSide(color: AppColors.borderWarm),
    ),
    child: Padding(padding: const EdgeInsets.all(20), child: child),
  );
}
