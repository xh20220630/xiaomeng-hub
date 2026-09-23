# GitHub CI/CD 与版本发布

本方案交付 Android APK 和可自托管的服务端运行包。CI 验证 PR；CD 在版本标签通过检查及环境审批后交付到 GitHub Releases。各自托管主机按需升级，流水线没有远程机器地址或 SSH 部署步骤。

## 分支与合并

`feat/*`、`fix/*`、`chore/*` → PR → `main` → 发布 PR → `vX.Y.Z` 标签 → CI → `release` 环境 → 签名构建与 GitHub Release。

- `main` 保持可发布；功能分支短期存在，使用 Squash merge。
- PR 标题遵循 Conventional Commits，例如 `feat(app): 支持主机切换`、`fix(server): 修复断线恢复`、`ci: 更新构建工具`；破坏性变更使用 `!` 并写明迁移方法。
- `feat` 通常升级 minor，`fix` 通常升级 patch，破坏性协议/数据变更升级 major。版本由发布者在发布 PR 中明确选择，不根据所有提交机械自动发布。
- 普通 PR 可以保持版本不变；改变版本时必须同时提高 Android 构建号。
- 当前只维护 `main` 发布线。历史版本问题回退后在 main 上修复并发更高版本；若需要多条长期维护线，应另行设计标签命名与兼容矩阵。

## 唯一版本来源

根目录 `version.json` 是发布清单，初始内容为 `2.0.2 / 17`，对应原客户端版本。

| 文件或产物 | 规则 |
| --- | --- |
| `version.json` | `version` 为 SemVer，`buildNumber` 为全局递增整数 |
| `app/pubspec.yaml` | `version: 2.0.3+18` |
| `server/package.json`、`server/package-lock.json` | `version: 2.0.3`，锁文件根 package 同步 |
| Git 标签 | `v2.0.3`，一经发布不移动、不重用 |
| Android | versionName = `2.0.3`，versionCode = `18` |
| 发布元数据 | 版本、构建号、完整 Git SHA、运行编号、文件哈希 |

支持 `2.1.0-alpha.1`、`2.1.0-beta.1`、`2.1.0-rc.1`。候选版到正式版也必须增加 buildNumber，例如 `2.1.0-rc.1+19` → `2.1.0+20`。候选版与正式版使用同一 Android applicationId，安装时相互更新，不能并存。

buildNumber 不使用 Actions run number；重试不会变成另一个版本。当前范围限定 Android，因此不把带连字符的候选版本直接用于 iOS 发布。

从仓库根目录执行：

```powershell
node scripts/release/version.mjs check
node scripts/release/version.mjs set patch
# 也可使用 minor、major，或明确版本：
# node scripts/release/version.mjs set 2.1.0-rc.1
# node scripts/release/version.mjs set 2.1.0
```

`set` 自动递增 buildNumber 并同步三个消费文件。`sync` 用于根据已审阅的 version.json 修复不一致；不要手工分别维护版本。同步操作会保留 package.json 的其他设置和锁文件依赖版本。

## 自动化职责

| 工作流 | 触发 | 执行内容 |
| --- | --- | --- |
| `CI` | PR、main push、手动或发布调用 | 版本和发布脚本检查；Windows/Linux 服务端 typecheck、test、build、生产包启动检查；Flutter analyze/test 和 Android debug 编译 |
| `Release` | `v*` 标签 push，或 main 上手动指定已有标签 | 校验标签和 main 血缘、更新日志及递增规则；对标签实际提交执行 CI；环境审批；签名 APK、服务端 zip/tar.gz、元数据与校验文件；完整上传后发布 |
| Dependabot | 每周 | GitHub Actions、npm、pub 的依赖更新 PR |

`CI gate` 汇总所有检查；任何失败、取消或跳过均不能通过。没有路径过滤，避免必须检查长期处于 Pending。发布调用 CI 时明确传入标签提交，手动重试也不会误测 main 的其他提交。

Node 与 Flutter 分别固定于 `.node-version`、`.flutter-version`，Java 固定为 17。依赖使用 `npm ci` 和 `flutter pub get --enforce-lockfile`。GitHub Actions 固定完整提交 SHA，由 Dependabot 提议更新。Flutter/Node 的版本文件仍需开发者定期维护并验证。

服务端包按白名单复制 `dist/src`、`dist/scripts`、配对页面和必要文档；不包含源码测试、node_modules、数据库、令牌或日志。运行包会将 npm 命令指向编译后的 JS，移除自动编译的 prestart/prehost 钩子，再使用仅生产依赖验证启动。

## GitHub 一次性配置

这些设置必须在 GitHub 仓库中配置，提交 YAML 不会自动创建保护规则。

1. **Actions**：启用 Actions，允许本仓库引用的 Actions。默认 workflow token 使用只读；发布 job 在 YAML 中申请 `contents: write`，无需个人 PAT。
2. **main Ruleset**：要求 PR；开启至少一名评审者（单人仓库按实际协作调整）；要求 `CI gate`；要求分支与 main 保持最新；禁止强推与删除。首次 CI 运行后从 GitHub 界面选择实际出现的检查名。建议只允许 Squash merge。
3. **tag Ruleset**：保护 `v*`，仅发布维护者可创建，禁止更新和删除已发布标签；收紧 bypass 名单。
4. **Environment `release`**：提前手工创建，按团队条件设置审批者；Selected branches and tags 仅允许 `v*` tags 和 `main` branch。main 是手动重试的执行入口，脚本仍只接受已合并的版本标签。
5. 在 `release` Environment 配置下表的 Secrets 与 Variable。环境审批功能取决于仓库可见性及 GitHub 套餐；不支持时，至少限制 main/tag 写权限和 Secrets 使用范围。

| 名称 | 类型 | 内容 |
| --- | --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Secret | 专用发布 keystore 的 Base64 |
| `ANDROID_KEYSTORE_PASSWORD` | Secret | keystore 密码 |
| `ANDROID_KEY_ALIAS` | Secret | 签名 key 别名 |
| `ANDROID_KEY_PASSWORD` | Secret | key 密码 |
| `ANDROID_CERT_SHA256` | Variable | 预期签名证书 SHA-256，可含冒号 |

签名文件在 runner 临时目录中解码，构建步骤结束后清理。发布前使用 apksigner 核对证书指纹；缺少设置或签名不符时失败。发布 job 串行执行；同一个标签的工作流不互相取消。

### 初次准备 Android 签名

在受信任的开发电脑上用 JDK keytool 生成并妥善备份发布密钥，密码使用交互输入，不写入 Git：

```powershell
keytool -genkeypair -v -keystore "$env:USERPROFILE\xiaomeng-release.jks" -alias xiaomeng -keyalg RSA -keysize 3072 -validity 10000
keytool -list -v -keystore "$env:USERPROFILE\xiaomeng-release.jks" -alias xiaomeng
```

将证书 SHA-256 填入 Variable。将 keystore 的 Base64 值通过 GitHub Secrets 界面保存，勿提交到仓库或粘贴进 PR。密钥和密码需离线备份；后续 APK 更新必须使用相同签名。

本地可使用忽略跟踪的 `app/android/key.properties`，键为 `storeFile`、`storePassword`、`keyAlias`、`keyPassword`；storeFile 相对 `app/android` 解析，Windows 推荐正斜杠绝对路径。也支持流水线使用的四个 `ANDROID_*` 环境变量，其中文件路径名为 `ANDROID_KEYSTORE_PATH`。

本地没有配置签名时保留调试签名，方便开发；发布设置 `REQUIRE_RELEASE_SIGNING=true` 后强制要求完整配置。**之前安装的调试签名 APK 不能被新的正式签名 APK 直接覆盖**：首次切换需安排卸载重装和重新配对，之后保持正式签名稳定。不要更改现有 applicationId 来掩盖这个差异。

## 一次完整发布

以下以首次正式发布 `2.0.3+18` 为例：

```powershell
git switch main
git pull --ff-only
git switch -c chore/release-2.0.3
node scripts/release/version.mjs set patch
node scripts/release/version.mjs check
```

将 `CHANGELOG.md` 的相关 Unreleased 内容整理到 `## [2.0.3] - YYYY-MM-DD` 下，说明功能、修复、兼容性、数据迁移及回退影响。提交版本相关文件和更新日志，创建 PR：`chore(release): 2.0.3`。CI 通过并合并后：

```powershell
git switch main
git pull --ff-only
node scripts/release/version.mjs check --tag v2.0.3 --released
git tag -a v2.0.3 -m "Release v2.0.3"
git push origin v2.0.3
```

必须针对版本文件对应的合并提交打标签；若 main 已继续前进，先定位正确的 release commit，不要对未核对的 HEAD 打标签。审批 release 环境后自动构建并发布五个文件：

```text
xiaomeng-v2.0.3-android.apk
xiaomeng-server-v2.0.3.zip
xiaomeng-server-v2.0.3.tar.gz
release-manifest.json
SHA256SUMS.txt
```

APK 为通用包，包含 Flutter 默认支持的 Android ABI。server 包不捆绑 Node.js，首次启动需 `npm ci --omit=dev`，之后直接运行编译后的 JS。

Release Notes 自动汇总 PR，详细人工发布说明以标签下 CHANGELOG.md 为准。候选版标记为 prerelease，不替换 latest；正式版设为 latest。哈希校验用于验证下载完整性，APK 证书用于签名身份校验。

## 失败重试与回退

- **CI/构建失败**：修复代码后创建更高版本；如果只是基础设施瞬时失败，在原运行中 Re-run jobs，或在 main 手动运行 Release 并填入原标签。
- **上传中断**：产物先上传至 draft release，全部成功才公开。可重试相同标签；只允许替换同一提交的草稿附件。
- **已公开发布**：流水线拒绝覆盖。修复内容需发更高版本，保留旧包及校验记录。
- **并发发布**：一个时间点准备一个版本；新版标签存在后旧版本发布/重试会被递增检查阻止。不要提前批量推送未来版本标签。
- **服务端回退**：按[发布包说明](SERVER_DISTRIBUTION.md)保留旧目录和数据备份，先检查数据库兼容性。
- **Android 回退**：低 versionCode 通常不能原地覆盖安装。生产修复优先回滚代码并发布更高 patch/buildNumber；手工卸载安装旧包会丢失本地配置，需要重新配对。

版本号统一表示一次协调交付，不承诺所有历史客户端与服务端永久互通。协议或数据库破坏性变更必须在 major 发布说明中提供兼容范围与升级步骤。

## 本地验证

```powershell
node --test scripts/release/*.test.mjs
node scripts/release/version.mjs check
cd server
npm ci
npm run typecheck
npm test
npm run build
cd ../app
flutter pub get --enforce-lockfile
flutter analyze --no-pub
flutter test --no-pub
flutter build apk --debug --no-pub
```

CI 对发布工具和打包启动的验证属于构建关键路径；普通文案/UI 工作可遵循项目约定仅运行必要检查。不要把人工修改的真实配置、数据库或密钥放入测试目录。

参考：[GitHub Actions 安全设置](https://docs.github.com/en/actions/reference/security/secure-use)、[GitHub Environment 配置](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)、[Flutter Android 发布](https://docs.flutter.dev/deployment/android)。
