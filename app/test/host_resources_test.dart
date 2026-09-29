import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:claude_monitor/services/host_resources.dart';
import 'package:claude_monitor/screens/resource_preview_screen.dart';
import 'package:claude_monitor/widgets/host_resource_scope.dart';
import 'package:claude_monitor/widgets/markdown_text.dart';
import 'package:claude_monitor/widgets/host_resource_image.dart';
import 'package:claude_monitor/models.dart';
import 'package:claude_monitor/chat_builder.dart';
import 'package:claude_monitor/conversation_presentation.dart';
import 'package:claude_monitor/theme/app_theme.dart';

const _reviewDirectory = String.fromEnvironment('RESOURCE_REVIEW_DIR');
final _reviewKey = GlobalKey();

Future<void> _capture(WidgetTester tester, String name) async {
  if (_reviewDirectory.isEmpty) return;
  await tester.runAsync(() async {
    final boundary =
        _reviewKey.currentContext!.findRenderObject() as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 2);
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(_reviewDirectory).create(recursive: true);
    await File(
      '$_reviewDirectory/$name.png',
    ).writeAsBytes(data!.buffer.asUint8List());
    image.dispose();
  });
}

const _metadata = HostResource(
  id: 'resource',
  name: 'README.md',
  kind: 'markdown',
  version: 'version',
  size: 30,
);

class _Resources extends HostResourceService {
  _Resources() : super('http://test', 'token');
  final references = <String>[];
  final bases = <String?>[];
  bool fail = false;
  @override
  Future<HostResource> resolve(
    String sessionId,
    String reference, {
    String? baseResourceId,
    required http.Client client,
  }) async {
    references.add(reference);
    bases.add(baseResourceId);
    if (fail) throw const HostResourceException('HOST_OFFLINE', '文件所属主机已离线');
    return _metadata;
  }

  @override
  Future<Map<String, dynamic>> text(
    HostResource resource, {
    int startLine = 1,
    required http.Client client,
  }) async => {
    'text': '# 项目说明\n\n[下一页](docs/next.md)\n\n手机预览内容',
    'startLine': startLine,
    'nextLine': null,
    'truncated': false,
    'encoding': 'utf-8',
    'version': resource.version,
  };
  @override
  Future<Uint8List> image(
    HostResource resource, {
    bool thumbnail = true,
    required http.Client client,
  }) async => base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',
  );
}

void main() {
  setUpAll(() async {
    if (_reviewDirectory.isEmpty) return;
    final font = ByteData.sublistView(
      await File('C:/Windows/Fonts/msyh.ttc').readAsBytes(),
    );
    for (final family in [
      'Ahem',
      'Roboto',
      'Noto Sans SC',
      'NotoSansSC',
      'JetBrains Mono',
    ]) {
      await (FontLoader(family)..addFont(Future.value(font))).load();
    }
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });
  test(
    'requests use bearer headers, scoped IDs and never follow redirects',
    () async {
      final service = HostResourceService('http://host:4897', 'private-token');
      addTearDown(service.dispose);
      final client = MockClient((request) async {
        expect(request.headers['Authorization'], 'Bearer private-token');
        expect(request.url.query, isNot(contains('private-token')));
        expect(request.followRedirects, false);
        expect(jsonDecode(request.body)['reference'], '中文 空格.md');
        expect(request.url.pathSegments, contains('session/one'));
        return http.Response(
          jsonEncode({
            'resourceId': 'r',
            'name': '中文 空格.md',
            'kind': 'markdown',
            'version': 'v',
            'size': 10,
          }),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      });
      addTearDown(client.close);
      expect(
        (await service.resolve('session/one', '中文 空格.md', client: client)).name,
        '中文 空格.md',
      );
      final redirect = MockClient(
        (_) async =>
            http.Response('', 302, headers: {'location': 'https://other.test'}),
      );
      addTearDown(redirect.close);
      await expectLater(
        service.resolve('s', 'a', client: redirect),
        throwsA(isA<HostResourceException>()),
      );
      final anonymous = HostResourceService('http://host', '');
      addTearDown(anonymous.dispose);
      await expectLater(
        anonymous.resolve('s', 'a', client: client),
        throwsA(isA<HostResourceException>()),
      );
    },
  );

  test(
    'image cache clears on auth failure and disposed connections cannot serve bytes',
    () async {
      final service = HostResourceService('http://host', 'token');
      var reads = 0;
      final client = MockClient((request) async {
        if (request.method == 'POST') {
          return http.Response(
            '{"error":"配对已失效"}',
            401,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        }
        reads++;
        return http.Response.bytes([1, 2, 3], 200);
      });
      addTearDown(client.close);
      await service.image(_metadata, client: client);
      await service.image(_metadata, client: client);
      expect(reads, 1);
      await expectLater(
        service.resolve('s', 'a', client: client),
        throwsA(isA<HostResourceException>()),
      );
      await service.image(_metadata, client: client);
      expect(reads, 2);
      service.dispose();
      await expectLater(
        service.image(_metadata, client: client),
        throwsA(isA<HostResourceException>()),
      );
    },
  );

  test(
    'attachment-only answers, tool output and enriched history retain references',
    () {
      final event = TaskEvent.fromJson({
        'session_id': 's',
        'hook_event_name': 'AssistantText',
        'event_key': 'a',
        'attachments': [
          {
            'reference': 'attachment:hash.png',
            'name': '图片',
            'kind': 'image',
            'snapshot': true,
          },
        ],
      });
      expect(
        buildChat([event]).single.attachments.single.reference,
        'attachment:hash.png',
      );
      final legacy = TaskEvent(
        sessionId: 's',
        hookEventName: 'AssistantText',
        status: 'done',
        eventKey: 'a',
      );
      expect(
        mergeConversationEvents([event], [legacy]).single.attachments,
        isNotEmpty,
      );
      final tool = TaskEvent(
        sessionId: 's',
        hookEventName: 'PostToolUse',
        status: 'done',
        toolName: 'Image',
        attachments: event.attachments,
      );
      expect(buildChat([tool]).single.attachments, isNotEmpty);
    },
  );

  testWidgets(
    'mobile file links open rendered markdown; relative links inherit the file',
    (tester) async {
      tester.view.physicalSize = const Size(360, 780);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final service = _Resources();
      addTearDown(service.dispose);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [hostResourcesProvider.overrideWithValue(service)],
          child: MaterialApp(
            theme: buildAppTheme(),
            builder: (context, child) =>
                RepaintBoundary(key: _reviewKey, child: child!),
            home: Scaffold(
              body: HostResourceScope(
                sessionId: 's',
                child: MarkdownText('[文件](README.md:120)'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('文件', findRichText: true));
      await tester.pumpAndSettle();
      expect(find.byType(ResourcePreviewScreen), findsOneWidget);
      expect(find.textContaining('项目说明', findRichText: true), findsOneWidget);
      expect(find.text('# 项目说明'), findsNothing);
      expect(service.references, ['README.md:120']);
      await _capture(tester, 'markdown-preview');
      await tester.tap(find.text('下一页', findRichText: true));
      await tester.pumpAndSettle();
      expect(service.references.last, 'docs/next.md');
      expect(service.bases.last, 'resource');
      await tester.tap(find.text('源码'));
      await tester.pumpAndSettle();
      expect(find.text('# 项目说明'), findsOneWidget);
      await _capture(tester, 'source-preview');
      await tester.enterText(find.byType(TextField), '手机');
      await tester.pump();
      expect(find.text('手机预览内容'), findsOneWidget);
      expect(find.text('# 项目说明'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'host image uses the session base and offline errors have retry',
    (tester) async {
      final service = _Resources();
      addTearDown(service.dispose);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [hostResourcesProvider.overrideWithValue(service)],
          child: MaterialApp(
            home: Scaffold(
              body: HostResourceScope(
                sessionId: 's',
                baseResourceId: 'base',
                child: MarkdownText('![图片](images/design.png)'),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(HostResourceImage), findsOneWidget);
      expect(service.references, ['images/design.png']);
      expect(service.bases, ['base']);
      service.fail = true;
      await tester.tap(find.byType(HostResourceImage));
      await tester.pumpAndSettle();
      expect(find.text('文件所属主机已离线'), findsOneWidget);
      expect(find.text('重新加载'), findsOneWidget);
      service.fail = false;
      await tester.tap(find.text('重新加载'));
      await tester.pumpAndSettle();
      expect(find.text('文件所属主机已离线'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
}
