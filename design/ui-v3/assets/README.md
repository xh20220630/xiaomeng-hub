# UI v3 切图规范

设计方向：夜航工作室。背景瓷白 `#F5F6F2`、深墨 `#11151B`、青柠 `#D9F66F`、柔灰绿 `#E9EDDF`。角色和装饰必须以本轮页面设计图为来源，保持一致的轮廓、材质和光照。

## 素材边界

- 导出：角色、插画主体、复杂材质、场景中的装饰性物件。
- 原生绘制：文字、按钮、表单、状态标签、导航、分隔线、简单图标、卡片底色及圆角、进度信息。
- 有背景的场景保留背景；悬浮角色与装饰使用真实 RGBA 透明度。
- 文件名表达用途，使用小写短横线；不覆盖上一版资源。
- UI 图片仅承载视觉内容，不包含可交互区域或需要本地化的文字。

## 验收

1. 记录设计来源、裁切框、输出像素尺寸、用途和透明度统计。
2. 检查四边透明，主体不触边；保留抗锯齿，避免白色描边。
3. 同时在瓷白、深墨、棋盘格背景检查可见边缘。
4. 主图保留高分辨率，头像与状态图使用独立适配尺寸。

## 现有素材审计

`app/assets/mascot-v2` 有 9 张 RGBA PNG：头像 160 × 160、三张 hero 768 × 768、五张状态图 384 × 384。旧素材保留，但不能作为新角色形象的直接替代。新资源位于 `app/assets/ui-v3`。

## 本轮交付

共 10 张正式 PNG：`hero-orbit`、`mascot-avatar`、`empty-state`、`project-art`、`inbox-art`、`archive-art`、`agents-art`、`settings-art`、`project-cover-mint`、`project-cover-orbit`。前八张使用真实 RGBA；最后两张项目场景封面有意保留背景与投影，不做透明化。

全部主体由本轮对应页面设计图通过内置 imagegen 定向提取或重绘，未将整张 UI 截图裁成素材。生成记录和最终规格位于 `generation-record.json`。三个最初带棋盘格的源图已经做颜色分离、连通区域过滤与内部孔洞填充，清除棋盘背景后才进入正式资源目录。其他 alpha 源图清除了轮廓碎屑并统一主体不透明度。缩放使用预乘 alpha，避免透明 RGB 污染边缘。

`asset-spec.json` 是打包规格；`prepare_sources.py` 和 `package_assets.py` 可复现处理。脚本依赖 Pillow、NumPy、OpenCV；本次 OpenCV 安装在用户缓存 `~/.cache/codex-ui-v3-image-tools`，未修改项目依赖。`asset-edge-review.jpg` 展示全部素材在瓷白、深墨和青柠三种背景上的验收结果；正式清单位于 `app/assets/ui-v3/asset-manifest.json`。

已验收八张透明图片的四边像素 alpha 均为 0，主体存在 alpha 255，尺寸与规格一致。项目封面所有像素均不透明。未执行 lint、typecheck 或 build；未使用 pnpm。
