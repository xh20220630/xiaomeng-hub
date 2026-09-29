# 小梦版本中心

2026-09-28。先搜索产品更新页参考，再使用内置 imagegen 生成设计稿，最后开发 Flutter 页面和历史数据读取。

## 参考与设计

- [Linear Changelog](https://linear.app/changelog)：按日期组织更新内容，以清楚的标题和段落支持阅读。
- [Raycast iOS Changelog](https://www.raycast.com/changelog/ios)：版本、发布日期与新增/改进/修复分组。
- [Apple 软件更新说明](https://support.apple.com/en-us/118575)：当前更新操作与自动更新设置的分工。

[生成的双屏设计图](design-board.png)展示更新概览与历史展开态；[完整生成提示词](prompt.txt)包含布局、中文文案、品牌颜色和角色约束。使用内置 imagegen，没有使用 CLI。唯一角色参考是现有 `app/assets/ui-v3/mascot-avatar.png`，开发时继续使用这份透明 IP 素材，界面文字与交互均由 Flutter 渲染。

## 实现

- 深墨版本卡、青柠下载/安装按钮；当前安装版本与检查更新作为次级操作。
- “更新说明 / 版本历史”分段切换，自动检查、自动下载和测试渠道集中在右上角偏好面板。
- 历史默认折叠，先展示日期、版本、渠道和摘要；点击后展开完整 Markdown。历史阅读不触发下载，也不提供降级安装。
- GitHub 分页读取，每页 20 条；排除草稿、按发布时间倒序、按发布 ID 去重。阅读历史不要求该版本仍有 APK 或校验文件。
- 最近 20 条记录持久缓存。网络失败时保留内容并提供重新加载；当前版本没有可用更新时仍可阅读已发布说明。
- 历史只显示真实发布记录，不把未发布的 2.0.3 / 2.0.4 当作独立 GitHub 发布。

## 实际组件截图

截图由 Flutter 页面测试渲染，使用确定的版本示例数据，不是真机截图或远端数据的实时截图。

- [更新概览，390px](implementation/overview.png)
- [历史列表，390px](implementation/history.png)
- [历史展开，390px](implementation/history-expanded.png)
- [更新偏好，320px / 1.5 倍文字](implementation/preferences-large-text.png)

设计图表示布局方向，实际发布说明保留原始内容并完整渲染，不使用设计图中的示例功能替换真实数据。

## 验证与测试包

- `flutter analyze --no-pub`：通过，无问题。
- `flutter test --no-pub`：94 项通过，1 项跳过；新增 6 项版本历史与页面测试，覆盖分页、缓存、异常数据、渠道筛选、Markdown 展开及大字体布局。
- `flutter build apk --release --no-pub`：成功，版本 2.0.6 / build 21。APK 元数据与签名校验通过，沿用现有测试签名。
- [本地测试 APK](../../output/app/xiaomeng-v2.0.6-build21-android.apk)，SHA-256：`2ba0dc3c4263ea8dc0ca6b7d35435a6d643c99609af76a4d0744ca61733c5c56`。

本次未连接真机验证，未提交代码或发布 GitHub Release。
