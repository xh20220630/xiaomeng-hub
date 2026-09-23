# 小梦 v2 · 图像生成记录

## 模式与参考

- 模式：内建 `image_gen`，未使用 CLI、Lunora 或外部 API 密钥。
- 身份参考：`app/assets/mascot/mascot-main.png`。
- 系列风格参考：`design/mascot-source/xiaomeng-hero-v2.png`。
- 所有运行时资产必须由切图流程写入 `app/assets/mascot-v2/`，不引用生成缓存路径。
- 下列提示词为实际提交版本。透明工作态出现模型输出问题，因此最终使用纯色绿幕原图进行用户已授权的规范切图。

## 01 · 欢迎全身

输出：`design/mascot-source/xiaomeng-hero-v2.png`，原生 RGBA。

```text
Use case: stylized-concept / identity-preserving style transformation. Asset: premium consumer app mascot, isolated transparent PNG, one complete character only. Restyle the exact pink Xiaomeng star-spirit shown in the reference into a beautifully art-directed, soft matte porcelain / marshmallow collectible character, with tasteful subtle subsurface scattering and tiny satin highlights. It must remain immediately recognizable: huge sapphire-blue gradient eyes with gentle highlights, round peach-pink face, two outward curled ear-like tufts, curved antenna topped by a pale pink five-point star, small white-pink feather wings, tiny rounded arms, long elegant curling pink spirit tail that ends in a warm apricot-gold comet with a star inset. Original mascot is a floating spirit, do not give it legs. Preserve the pink identity and signature silhouette. Pose: a welcoming full-body floating 3/4 portrait, happy and calm small smile, one little hand raised in a natural wave, wings open, tail looping gracefully below. Modern expertly crafted Pixar-level 3D product illustration, smooth and dimensional but not plastic, visually sophisticated with delicate details only where they improve silhouette. Pale warm rose #F3CADD, cream pink highlights, gentle azure eyes, restrained apricot gold accent. Soft studio lighting from upper left, subtle ambient occlusion within the character, no cast shadow on background. The character should fill approximately 80% of a square canvas, centered, all star/wing/tail tips fully within frame with generous safe margin. True alpha transparent background, no floor, no backdrop, no checkerboard drawn, no scenery, no halo, no detached decorative particles, no text, no symbols or icons apart from original star features, no border, no watermark. This is the hero welcoming state in a consistent series.
```

## 02 · 工作态设计原图

输出：`design/mascot-source/xiaomeng-working-v2.png`。此原图棋盘底被烘焙进 RGB，**不可作为透明图直接用于 UI**。

```text
Use case: identity-preserve, new pose/state in a premium consumer app mascot series. Use the provided Xiaomeng hero image as the exact identity and rendering-style reference. Create ONE new illustration of this SAME soft pale-pink star-spirit character, same face, large sapphire-blue eyes, curled ear-like tufts, pink five-point star antenna, small feather wings, tiny rounded arms, elegant legless spirit body with long curled tail and warm apricot-gold comet tip with star inset. Keep precise collectible-quality soft matte porcelain/marshmallow 3D texture, subtle lighting and original proportions. This is the WORKING / FOCUSED state. Pose: floating gently in a more compact seated curl, a small clean cream-white slim laptop open in front of its chest, both tiny hands naturally working on keyboard, blue eyes looking attentively downward at screen, a calm concentrated smile. Character still feels alive and companionable; no stress or anger. Laptop has no logo, no letters, no interface visible, minimal softly rounded form. Front three-quarter angle, completely visible head and star above laptop, wings visible at sides, tail and gold tip visible curling beside the laptop. Keep silhouette clean and easily readable at 160px. Delicate soft studio illumination upper left, restrained blush pink, ivory, azure and warm apricot gold. Single complete character and laptop centered on square canvas, maximum extent occupies 76% canvas with at least 10% transparent safe margin on every side. TRUE ALPHA TRANSPARENT background with no background image, no floor, no shadows outside silhouette, no halo, no checkerboard texture, no borders, no text, no watermark, no confetti, no extra characters.
```

### 工作态最终生产原图

输出：`design/mascot-source/xiaomeng-working-chroma-v2.png`。生产时去除纯绿背景、修复边缘绿溢色并导出真正 RGBA；生成过程未改变工具模式。

```text
Edit only the background of this image. Replace the ENTIRE gray checkerboard background with ONE perfect flat solid bright chroma-key green color RGB(0,255,0), hex #00FF00. The green must cover the whole canvas behind the character, including all holes between antenna, wings, arms and the tail. Absolutely uniform solid green: no texture, no checker pattern, no gradients, no shadows, no variation. Preserve the pink mascot and white laptop exactly as shown: same face, pose, star antenna, eyes, wings, tail and gold comet, same lighting, material and dimensions. Do not introduce green reflections or green illumination on the subject. Output the isolated subject against this perfect pure green background for professional chroma key extraction.
```

两次透明修复尝试仍输出棋盘底，已弃用且不进入应用资产包。此处保留首张工作态设计原图用于形象追溯，最终仅使用去底后的生产资产。

## 03 · 完成庆祝

输出：`design/mascot-source/xiaomeng-celebrate-v2.png`，原生 RGBA。

```text
Use case: identity-preserve; third state of a cohesive premium consumer app mascot series. Keep EXACT Xiaomeng identity and 3D rendering style from reference: soft pale pink matte porcelain/marshmallow star-spirit, very large luminous sapphire blue eyes, curled outward ear-like tufts, pink five-point star on curved antenna, little white-pink feather wings, tiny arms, no legs, long elegantly curled pink ghostlike tail tipped by apricot-gold comet with inset pink star. Same face proportions, colors and material. Make the SUCCESS / CELEBRATION form, compact and adorable but sophisticated: floating upright with a joyous open small smile and both blue eyes gently smiling, hugging one plump luminous champagne-gold five-point star to its chest with both small arms, head tilted a little, wings happily spread. The long tail forms a compact soft curl underneath, visibly connected to the gold comet tip. Entire character clearly visible, no clipping, no detached sparkles. Soft tactile matte surfaces and controlled highlights, no harsh black outlines, studio light upper left. Square canvas, centered single complete character, leave at least 12% clear space around all tips, character fits comfortably within central 76% of canvas. Asset intended to composite over light or dark UI. Background must be genuinely empty transparent alpha, zero RGB backdrop or checkerboard pattern. NO painted checkerboard, NO background gray, NO texture behind the subject, NO floor, NO contact shadow, NO aura, NO text, NO lettering, NO borders, NO watermark, NO other characters. Output one clean cutout.
```

## 验收

- 欢迎与庆祝两张确认拥有真实 alpha；切图移除远处不可见噪点并补足留白。
- 工作态由纯色生产原图去底，不能直接使用 RGB 原图。
- 生产输出需在奶白、深可可和棋盘三种底色检查边缘，完整保留星星、翅膀与卷尾。
- 不同尺寸来自同一套原图裁切，不重新生成人脸，避免应用中出现身份漂移。
