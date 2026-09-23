import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/material.dart';
import 'tokens.dart';

ThemeData buildAppTheme() {
  final scheme =
      ColorScheme.fromSeed(
        seedColor: AppColors.primary,
        brightness: Brightness.light,
      ).copyWith(
        surface: AppColors.card,
        primary: AppColors.primary,
        onPrimary: Colors.white,
        primaryContainer: AppColors.lime,
        onPrimaryContainer: AppColors.ink,
        secondary: AppColors.success,
        outline: AppColors.borderWarm,
        error: AppColors.danger,
      );

  final base = ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
    colorScheme: scheme,
  );

  return base.copyWith(
    scaffoldBackgroundColor: AppColors.bg,
    textTheme: AppFont.textTheme(base.textTheme),
    appBarTheme: AppBarTheme(
      backgroundColor: AppColors.bg,
      foregroundColor: AppColors.ink,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      centerTitle: false,
      titleTextStyle: AppFont.ui(size: 18, weight: FontWeight.w600),
    ),
    cardTheme: CardThemeData(
      color: AppColors.card,
      elevation: 0,
      margin: const EdgeInsets.symmetric(vertical: 6),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadii.card),
        side: const BorderSide(color: AppColors.borderWarm),
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      height: 70,
      elevation: 0,
      backgroundColor: AppColors.bg,
      surfaceTintColor: Colors.transparent,
      indicatorColor: AppColors.mascotPink,
      labelTextStyle: WidgetStatePropertyAll(
        AppFont.ui(size: 11, weight: FontWeight.w500),
      ),
      iconTheme: const WidgetStatePropertyAll(
        IconThemeData(size: 22, color: AppColors.ink),
      ),
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: AppColors.card,
      surfaceTintColor: Colors.transparent,
      showDragHandle: true,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(AppRadii.drawerTop),
        ),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: AppColors.card,
      contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 18),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadii.input),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadii.input),
        borderSide: const BorderSide(color: AppColors.borderWarm),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadii.input),
        borderSide: const BorderSide(color: AppColors.primaryDeep),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: AppColors.lime,
        foregroundColor: AppColors.ink,
        padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 16),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadii.input),
        ),
      ),
    ),
    chipTheme: ChipThemeData(
      backgroundColor: AppColors.warmWhite,
      side: BorderSide.none,
      labelStyle: AppFont.ui(size: 11, color: AppColors.textSecondary),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
    ),
    dividerTheme: const DividerThemeData(color: AppColors.borderDivider),
    progressIndicatorTheme: const ProgressIndicatorThemeData(
      color: AppColors.success,
      linearTrackColor: AppColors.greenLight,
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: AppColors.night,
      contentTextStyle: AppFont.ui(color: AppColors.onNight),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadii.card),
      ),
    ),
    splashColor: AppColors.halo.withValues(alpha: 0.4),
    highlightColor: AppColors.halo.withValues(alpha: 0.25),
    // Horizontal slide-in on every platform (CC-mobile feel).
    pageTransitionsTheme: const PageTransitionsTheme(
      builders: {
        TargetPlatform.android: CupertinoPageTransitionsBuilder(),
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.windows: CupertinoPageTransitionsBuilder(),
        TargetPlatform.linux: CupertinoPageTransitionsBuilder(),
        TargetPlatform.fuchsia: CupertinoPageTransitionsBuilder(),
      },
    ),
  );
}
