import 'dart:async';
import 'dart:convert';

import 'package:claude_monitor/services/app_updates.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const base = 'https://github.com/$updateRepository/releases';
const tag = 'preview-2.0.5-build20';
final hash = 'a' * 64;

String feed({String releaseTag = tag, String? link}) =>
    '''
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>小梦 2.0.5</title>
    <updated>2026-09-28T09:00:00Z</updated>
    <link rel="alternate" href="${link ?? '$base/tag/$releaseTag'}"/>
    <content type="html">&lt;h2&gt;更新&lt;/h2&gt;&lt;ul&gt;&lt;li&gt;&lt;strong&gt;修复&lt;/strong&gt;检查更新&lt;/li&gt;&lt;/ul&gt;</content>
  </entry>
</feed>''';

http.Response manifest({
  String? digest,
  String version = '2.0.5',
  int build = 20,
  String name = 'xiaomeng-v2.0.5-android.apk',
}) => http.Response(
  jsonEncode({
    'version': version,
    'buildNumber': build,
    'artifacts': [
      {'name': name, 'bytes': 1234, 'sha256': digest ?? hash},
    ],
  }),
  200,
);

void main() {
  test(
    'history and update checks share the feed when the API is exhausted',
    () async {
      var feedRequests = 0;
      var manifestRequests = 0;
      final api = ReleaseClient(
        MockClient((request) async {
          if (request.url.host == 'api.github.com') {
            return http.Response(
              '',
              403,
              headers: {'x-ratelimit-remaining': '0'},
            );
          }
          if (request.url.path.endsWith('.atom')) {
            feedRequests++;
            await Future<void>.delayed(Duration.zero);
            return http.Response(
              feed(),
              200,
              headers: {'content-type': 'application/atom+xml; charset=utf-8'},
            );
          }
          manifestRequests++;
          return manifest();
        }),
      );
      final results = await Future.wait<Object?>([
        api.history(),
        api.latest(const AppVersion('2.0.2', 17), true),
      ]);
      final history = results[0] as ReleaseHistoryPage;
      expect(history.entries.single.version, '2.0.5');
      expect(history.entries.single.build, 20);
      expect(history.entries.single.publishedAt, DateTime.utc(2026, 9, 28, 9));
      expect(history.entries.single.notes, contains('**修复**'));
      expect(history.entries.single.preview, isNull);
      expect(history.entries.single.channelLabel, '渠道待确认');
      expect(history.partial, isTrue);
      expect(history.hasMore, isFalse);
      expect(history.notice, contains('官方发布订阅'));
      expect((results[1] as AppRelease).version.build, 20);
      expect(feedRequests, 1);
      expect(manifestRequests, 1);
      expect(api.notice, isNot(contains('额度')));
    },
  );

  test(
    'history needs no manifest and does not guess channels from tags',
    () async {
      for (final releaseTag in ['v2.0.5', 'preview-2.0.5-build20']) {
        final api = ReleaseClient(
          MockClient((request) async {
            if (request.url.host == 'api.github.com') {
              throw http.ClientException('offline');
            }
            expect(request.url.path, endsWith('.atom'));
            return http.Response(
              feed(releaseTag: releaseTag),
              200,
              headers: {'content-type': 'application/atom+xml; charset=utf-8'},
            );
          }),
        );
        final history = await api.history();
        expect(history.entries.single.preview, isNull);
        expect(
          ReleaseHistoryEntry.fromJson(history.entries.single.toJson()).preview,
          isNull,
        );
      }
    },
  );

  test('both source failures keep the fallback cause visible', () async {
    final api = ReleaseClient(
      MockClient(
        (request) async => request.url.host == 'api.github.com'
            ? http.Response('', 429)
            : http.Response('', 503),
      ),
    );
    for (final operation in [
      () => api.history(),
      () => api.latest(const AppVersion('2.0.2', 17), true),
    ]) {
      await expectLater(
        operation(),
        throwsA(
          isA<UpdateException>().having(
            (error) => error.message,
            'both causes',
            allOf(contains('额度'), contains('备用发布源'), contains('503')),
          ),
        ),
      );
    }
  });

  test(
    'history fallback rejects a foreign feed and keeps pagination failures explicit',
    () async {
      var feeds = 0;
      final api = ReleaseClient(
        MockClient((request) async {
          if (request.url.host == 'api.github.com') {
            return http.Response('', 429);
          }
          feeds++;
          return http.Response(
            feed(link: 'https://example.com/releases/tag/v2.0.5'),
            200,
          );
        }),
      );
      await expectLater(api.history(), throwsA(isA<UpdateException>()));
      await expectLater(
        api.history(page: 2),
        throwsA(
          isA<UpdateException>().having(
            (error) => error.message,
            'pagination',
            contains('更早版本'),
          ),
        ),
      );
      expect(feeds, 1);
    },
  );

  test(
    'API limit falls back to official feed and verified manifest with Markdown notes',
    () async {
      final urls = <String>[];
      final api = ReleaseClient(
        MockClient((request) async {
          urls.add(request.url.toString());
          if (request.url.host == 'api.github.com') {
            return http.Response(
              '{"message":"API rate limit exceeded"}',
              403,
              headers: {'x-ratelimit-remaining': '0'},
            );
          }
          if (request.url.path.endsWith('.atom')) {
            return http.Response(
              feed(),
              200,
              headers: {'content-type': 'application/atom+xml; charset=utf-8'},
            );
          }
          return manifest();
        }),
      );
      final release = await api.latest(const AppVersion('2.0.2', 17), true);
      expect(release?.version.label, '2.0.5（build 20）');
      expect(release?.sha256, hash);
      expect(release?.url, '$base/download/$tag/xiaomeng-v2.0.5-android.apk');
      expect(release?.notes, contains('## 更新'));
      expect(release?.notes, contains('**修复**'));
      expect(api.notice, contains('官方发布订阅'));
      await api.latest(const AppVersion('2.0.2', 17), true);
      expect(urls.length, 3);
      expect(urls.every((url) => url.startsWith('https://')), isTrue);
    },
  );

  test(
    'concurrent reads share a request and successful reads expire after one minute',
    () async {
      var clock = DateTime.utc(2026, 9, 28, 10);
      var requests = 0;
      final pending = Completer<http.Response>();
      final api = ReleaseClient(
        MockClient((_) {
          requests++;
          return requests == 1
              ? pending.future
              : Future.value(http.Response('[]', 200));
        }),
        now: () => clock,
      );
      final first = api.history();
      final second = api.history();
      pending.complete(http.Response('[]', 200));
      await Future.wait([first, second]);
      await api.history();
      expect(requests, 1);
      clock = clock.add(const Duration(seconds: 61));
      await api.history();
      expect(requests, 2);
    },
  );

  test(
    'rate-limit reset blocks API retries across history and checks until recovery',
    () async {
      var clock = DateTime.utc(2026, 9, 28, 10);
      final reset = clock.add(const Duration(minutes: 30));
      var requests = 0;
      final api = ReleaseClient(
        MockClient((request) async {
          if (request.url.host != 'api.github.com') {
            return http.Response('', 503);
          }
          requests++;
          return requests == 1
              ? http.Response(
                  '{"message":"API rate limit exceeded"}',
                  403,
                  headers: {
                    'x-ratelimit-remaining': '0',
                    'x-ratelimit-reset':
                        '${reset.millisecondsSinceEpoch ~/ 1000}',
                  },
                )
              : http.Response('[]', 200);
        }),
        now: () => clock,
      );
      final limited = throwsA(
        isA<UpdateException>().having(
          (e) => e.message,
          'message',
          contains('预计'),
        ),
      );
      await expectLater(api.history(), limited);
      await expectLater(
        api.latest(const AppVersion('2.0.2', 17), true),
        limited,
      );
      expect(requests, 1);
      clock = reset.add(const Duration(seconds: 1));
      expect((await api.history()).entries, isEmpty);
      expect(requests, 2);
    },
  );

  test(
    '429 retry-after is respected and ordinary 403 is not mislabeled as quota exhaustion',
    () async {
      var clock = DateTime.utc(2026, 9, 28);
      var requests = 0;
      final api = ReleaseClient(
        MockClient((request) async {
          if (request.url.host != 'api.github.com') {
            return http.Response('', 503);
          }
          requests++;
          return http.Response('', 429, headers: {'retry-after': '120'});
        }),
        now: () => clock,
      );
      await expectLater(api.history(), throwsA(isA<UpdateException>()));
      clock = clock.add(const Duration(seconds: 90));
      await expectLater(api.history(), throwsA(isA<UpdateException>()));
      expect(requests, 1);
      clock = clock.add(const Duration(seconds: 31));
      await expectLater(api.history(), throwsA(isA<UpdateException>()));
      expect(requests, 2);
      await expectLater(
        ReleaseClient(
          MockClient((_) async => http.Response('', 403)),
        ).history(),
        throwsA(
          isA<UpdateException>().having(
            (e) => e.message,
            'message',
            contains('拒绝访问'),
          ),
        ),
      );
    },
  );

  test(
    'stable fallback follows GitHub latest rather than trusting a stable-looking tag',
    () async {
      var stableExists = false;
      var manifests = 0;
      final api = ReleaseClient(
        MockClient((request) async {
          if (request.url.host == 'api.github.com') {
            return http.Response('', 429);
          }
          if (request.url.path.endsWith('.atom')) {
            return http.Response(
              feed(releaseTag: 'v2.0.5'),
              200,
              headers: {'content-type': 'application/atom+xml; charset=utf-8'},
            );
          }
          if (request.url.path.endsWith('/latest')) {
            expect(request.followRedirects, isFalse);
            expect(request.method, 'HEAD');
            return http.Response(
              '',
              302,
              headers: {'location': stableExists ? '$base/tag/v2.0.5' : base},
            );
          }
          manifests++;
          return manifest();
        }),
        cacheDuration: Duration.zero,
      );
      expect(await api.latest(const AppVersion('2.0.2', 17), false), isNull);
      expect(manifests, 0);
      stableExists = true;
      final release = await api.latest(const AppVersion('2.0.2', 17), false);
      expect(release?.preview, isFalse);
      expect(release?.version.name, '2.0.5');
    },
  );

  test(
    'fallback rejects mismatched versions, hashes, paths, and incomplete feeds',
    () async {
      for (final badManifest in [
        manifest(digest: ''),
        manifest(version: '9.0.0'),
        manifest(build: 21),
      ]) {
        final api = ReleaseClient(
          MockClient((request) async {
            if (request.url.host == 'api.github.com') {
              return http.Response('', 429);
            }
            if (request.url.path.endsWith('.atom')) {
              return http.Response(
                feed(),
                200,
                headers: {
                  'content-type': 'application/atom+xml; charset=utf-8',
                },
              );
            }
            return badManifest;
          }),
        );
        await expectLater(
          api.latest(const AppVersion('2.0.2', 17), true),
          throwsA(isA<UpdateException>()),
        );
      }
      for (final value in [
        'https://example.com/releases/tag/$tag',
        '$base/tag/../../evil',
      ]) {
        final urls = <String>[];
        final api = ReleaseClient(
          MockClient((request) async {
            urls.add(request.url.toString());
            if (request.url.host == 'api.github.com') {
              return http.Response('', 429);
            }
            return http.Response(
              feed(link: value),
              200,
              headers: {'content-type': 'application/atom+xml; charset=utf-8'},
            );
          }),
        );
        await expectLater(
          api.latest(const AppVersion('2.0.2', 17), true),
          throwsA(isA<UpdateException>()),
        );
        expect(urls.length, 2);
      }
      final broken = ReleaseClient(
        MockClient(
          (request) async => request.url.host == 'api.github.com'
              ? http.Response('', 429)
              : http.Response('<html>blocked</html>', 200),
        ),
      );
      await expectLater(
        broken.latest(const AppVersion('2.0.2', 17), true),
        throwsA(isA<UpdateException>()),
      );
    },
  );

  test(
    'fallback skips obsolete manifests and never downgrades an installed version',
    () async {
      final urls = <String>[];
      final api = ReleaseClient(
        MockClient((request) async {
          urls.add(request.url.toString());
          if (request.url.host == 'api.github.com') {
            throw http.ClientException('offline');
          }
          if (request.url.path.endsWith('.atom')) {
            return http.Response(
              feed(),
              200,
              headers: {'content-type': 'application/atom+xml; charset=utf-8'},
            );
          }
          return manifest();
        }),
      );
      expect(await api.latest(const AppVersion('2.0.6', 21), true), isNull);
      expect(urls.length, 2);
    },
  );

  if (const bool.fromEnvironment('VERIFY_GITHUB_UPDATE_SOURCE')) {
    test(
      'live official fallback resolves the published Android package',
      () async {
        final network = http.Client();
        addTearDown(network.close);
        final api = ReleaseClient(
          MockClient((request) async {
            if (request.url.host == 'api.github.com') {
              return http.Response('', 429);
            }
            final liveRequest = http.Request(request.method, request.url)
              ..followRedirects = request.followRedirects
              ..headers.addAll(request.headers);
            return http.Response.fromStream(await network.send(liveRequest));
          }),
        );
        final release = await api.latest(const AppVersion('2.0.2', 17), true);
        expect(release, isNotNull);
        expect(release!.version.build, greaterThanOrEqualTo(20));
        expect(isReleaseAssetUrl(release.url), isTrue);
        expect(release.sha256.length, 64);
        expect(api.notice, contains('官方发布订阅'));
        final history = await api.history();
        expect(
          history.entries.any((entry) => entry.version == release.version.name),
          isTrue,
        );
        expect(history.partial, isTrue);
        expect(history.entries.first.notes, isNotEmpty);
        // ignore: avoid_print
        print(
          'Live fallback: ${release.version.label}; ${release.url}; ${release.sha256}',
        );
      },
    );
  }
}
