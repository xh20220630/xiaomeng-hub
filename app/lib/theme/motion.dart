import 'package:flutter/widgets.dart';
import 'tokens.dart';

abstract final class AppMotion {
  static const quick = Duration(milliseconds: 160);
  static const transition = Duration(milliseconds: 240);
  static const reveal = Duration(milliseconds: 520);
  static const character = Duration(milliseconds: 780);
  static const Curve enter = Curves.easeOutCubic;
  static const Curve exit = Curves.easeInCubic;

  static bool enabled(BuildContext context) =>
      !kStaticCapture &&
      !MediaQuery.disableAnimationsOf(context) &&
      TickerMode.valuesOf(context).enabled;

  static Duration duration(BuildContext context, Duration value) =>
      enabled(context) ? value : Duration.zero;
}
