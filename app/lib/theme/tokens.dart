import 'package:flutter/material.dart';

const bool kStaticCapture = bool.fromEnvironment('STATIC_CAPTURE');

class AppColors {
  static const night = Color(0xFF11151B);
  static const nightRaised = Color(0xFF1B2129);
  static const lime = Color(0xFFD9F66F);
  static const onNight = Color(0xFFF4F6EE);
  static const nightMuted = Color(0xFFADB5AA);
  static const primary = Color(0xFF202620);
  static const primaryDeep = Color(0xFF4C6731);
  static const primaryRejected = Color(0xFFAA645A);
  static const halo = Color(0xFFE9EDDF);
  static const rejectLine = Color(0xFFEBDCD6);
  static const ink = Color(0xFF202620);
  static const bodySecondary = Color(0xFF414A42);
  static const userBubbleText = Color(0xFF293522);
  static const textSecondary = Color(0xFF687264);
  static const textSecondaryLight = Color(0xFF898B92);
  static const textPlaceholder = Color(0xFF788173);
  static const textPlaceholder2 = Color(0xFF888A91);
  static const doneNameGray = Color(0xFF696B72);
  static const bg = Color(0xFFF5F6F2);
  static const drawer = Color(0xFFFFFFFF);
  static const card = Color(0xFFFFFFFF);
  static const warmWhite = Color(0xFFF0F3E9);
  static const timestampBg = Color(0xFFECEFE6);
  static const success = Color(0xFF496B35);
  static const greenLight = Color(0xFFEDF4DF);
  static const doneRowBg = Color(0xFFF6FAF8);
  static const codeGreen = Color(0xFFABDCC5);
  static const danger = Color(0xFFB55345);
  static const rejectCapsuleText = Color(0xFFAD5968);
  static const rejectCapsuleBg = Color(0xFFFCF0F2);
  static const warnBarBg = Color(0xFFFFF8EE);
  static const borderWarm = Color(0xFFE2E6DA);
  static const borderDivider = Color(0xFFE9ECE2);
  static const borderLight = Color(0xFFF3F3F5);
  static const inputBorder = Color(0xFFDCE3D0);
  static const stepPendingLine = Color(0xFFE2E3E7);
  static const stepDashedBorder = Color(0xFFC7C9D0);
  static const checkboxBorder = Color(0xFFB8BBC2);
  static const codeBg = Color(0xFF202227);
  static const codeBgDeep = Color(0xFF17191D);
  static const codeTitle = Color(0xFFBCC1CE);
  static const codeHighlight = Color(0xFFE9EAF0);
  static const mascotPink = Color(0xFFE9EDDF);
  static const peach = Color(0xFFDBE8AB);
  static const lavender = Color(0xFFE8EDE7);
  static const sidebar = Color(0xFFECEFE6);
  static const deviceShell = Color(0xFF161719);
  static const scrim = Color(0x66171920);
  static Color get diffAddBg => success.withValues(alpha: 0.12);
  static Color get diffDelBg => danger.withValues(alpha: 0.12);
}

class AppFont {
  static TextStyle ui({
    double size = 14,
    FontWeight weight = FontWeight.w400,
    Color color = AppColors.ink,
    double? height,
    double? letterSpacing,
  }) => TextStyle(
    fontSize: size,
    fontWeight: weight,
    color: color,
    height: height,
    letterSpacing: letterSpacing,
    fontFamily: 'Noto Sans SC',
    fontFamilyFallback: const ['Microsoft YaHei', 'Noto Sans SC'],
  );
  static TextStyle mono({
    double size = 13,
    FontWeight weight = FontWeight.w400,
    Color color = AppColors.ink,
    double? height,
  }) => ui(
    size: size,
    weight: weight,
    color: color,
    height: height,
  ).copyWith(fontFamily: 'monospace');
  static TextTheme textTheme(TextTheme base) => base.apply(
    fontFamily: 'Noto Sans SC',
    bodyColor: AppColors.ink,
    displayColor: AppColors.ink,
  );
}

class AppRadii {
  static const card = 12.0;
  static const hero = 16.0;
  static const tool = 10.0;
  static const drawerTop = 18.0;
  static const button = 10.0;
  static const input = 12.0;
  static const badge = 6.0;
  static const codeBlock = 8.0;
  static const timestamp = 8.0;
}
