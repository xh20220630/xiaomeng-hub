import 'package:flutter/material.dart';

enum StudioSymbol { conversations, projects, inbox, archive, agents, settings }

class StudioIcon extends StatelessWidget {
  const StudioIcon(this.symbol, {super.key, this.size = 32});

  final StudioSymbol symbol;
  final double size;

  @override
  Widget build(BuildContext context) => Image.asset(
    'assets/ui-v3/icon-${symbol.name}.png',
    width: size,
    height: size,
    fit: BoxFit.contain,
    filterQuality: FilterQuality.medium,
    excludeFromSemantics: true,
  );
}
