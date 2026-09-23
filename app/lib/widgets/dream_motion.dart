import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme/motion.dart';

class DreamReveal extends StatefulWidget {
  const DreamReveal({
    super.key,
    required this.child,
    this.delay = Duration.zero,
    this.duration = const Duration(milliseconds: 560),
    this.offset = const Offset(0, 18),
    this.trigger,
  });

  final Widget child;
  final Duration delay;
  final Duration duration;
  final Offset offset;
  final Object? trigger;

  @override
  State<DreamReveal> createState() => _DreamRevealState();
}

class _DreamRevealState extends State<DreamReveal>
    with SingleTickerProviderStateMixin {
  late final _controller = AnimationController(
    vsync: this,
    duration: widget.duration,
    value: 1,
  );
  Timer? _delay;
  bool _started = false;
  bool _enabled = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _enabled = AppMotion.enabled(context);
    if (!_enabled) {
      _delay?.cancel();
      _controller.value = 1;
      _started = true;
    } else if (!_started) {
      _started = true;
      _play();
    }
  }

  @override
  void didUpdateWidget(DreamReveal oldWidget) {
    super.didUpdateWidget(oldWidget);
    _controller.duration = widget.duration;
    if (oldWidget.trigger != widget.trigger) _play();
  }

  void _play() {
    _delay?.cancel();
    if (!_enabled || widget.duration == Duration.zero) {
      _controller.value = 1;
      return;
    }
    _controller.value = 0;
    if (widget.delay <= Duration.zero) {
      _controller.forward();
    } else {
      _delay = Timer(widget.delay, () {
        if (mounted && _enabled) _controller.forward();
      });
    }
  }

  @override
  void dispose() {
    _delay?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _controller,
    child: widget.child,
    builder: (context, child) {
      final value = Curves.easeOutCubic.transform(_controller.value);
      return IgnorePointer(
        ignoring: value == 0,
        child: Opacity(
          opacity: value,
          child: Transform.translate(
            offset: widget.offset * (1 - value),
            child: child,
          ),
        ),
      );
    },
  );
}

/// Observes pointer events without competing with child buttons or scroll views.
class DreamPress extends StatefulWidget {
  const DreamPress({
    super.key,
    required this.child,
    this.enabled = true,
    this.scale = .97,
  }) : assert(scale > 0 && scale <= 1);

  final Widget child;
  final bool enabled;
  final double scale;

  @override
  State<DreamPress> createState() => _DreamPressState();
}

class _DreamPressState extends State<DreamPress> {
  final Set<int> _pointers = {};

  void _pointerDown(PointerDownEvent event) {
    if (widget.enabled) setState(() => _pointers.add(event.pointer));
  }

  void _pointerEnd(PointerEvent event) {
    if (_pointers.contains(event.pointer)) {
      setState(() => _pointers.remove(event.pointer));
    }
  }

  @override
  void didUpdateWidget(DreamPress oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.enabled) _pointers.clear();
  }

  @override
  Widget build(BuildContext context) {
    final pressed = _pointers.isNotEmpty && widget.enabled;
    final motion = AppMotion.enabled(context);
    return Listener(
      onPointerDown: _pointerDown,
      onPointerUp: _pointerEnd,
      onPointerCancel: _pointerEnd,
      child: AnimatedScale(
        scale: pressed && motion ? widget.scale : 1,
        duration: motion
            ? Duration(milliseconds: pressed ? 110 : 240)
            : Duration.zero,
        curve: pressed ? Curves.easeOutCubic : Curves.easeOutBack,
        child: widget.child,
      ),
    );
  }
}

class DreamFloat extends StatelessWidget {
  const DreamFloat({
    super.key,
    required this.child,
    this.active = true,
    this.amplitude = 5,
    this.period = const Duration(milliseconds: 4800),
  }) : assert(amplitude >= 0),
       assert(period > Duration.zero);

  final Widget child;
  final bool active;
  final double amplitude;
  final Duration period;

  @override
  Widget build(BuildContext context) => _DreamLoop(
    active: active,
    period: period,
    child: child,
    builder: (context, phase, child) => Transform.translate(
      offset: Offset(0, -math.sin(phase * math.pi * 2) * amplitude),
      child: child,
    ),
  );
}

/// Give each status a distinct key so state changes animate once.
class DreamStatusSwitcher extends StatelessWidget {
  const DreamStatusSwitcher({
    super.key,
    required this.child,
    this.duration = const Duration(milliseconds: 300),
    this.alignment = Alignment.centerLeft,
  });

  final Widget child;
  final Duration duration;
  final AlignmentGeometry alignment;

  @override
  Widget build(BuildContext context) {
    if (!AppMotion.enabled(context)) return child;
    return AnimatedSwitcher(
      duration: duration,
      reverseDuration: const Duration(milliseconds: 150),
      switchInCurve: Curves.easeOutCubic,
      switchOutCurve: Curves.easeInCubic,
      layoutBuilder: (currentChild, previousChildren) => Stack(
        alignment: alignment,
        children: [
          for (final previous in previousChildren)
            IgnorePointer(child: ExcludeSemantics(child: previous)),
          ?currentChild,
        ],
      ),
      transitionBuilder: (child, animation) => FadeTransition(
        opacity: animation,
        child: ScaleTransition(
          scale: Tween<double>(begin: .94, end: 1).animate(animation),
          child: child,
        ),
      ),
      child: child,
    );
  }
}

class DreamActivityDot extends StatelessWidget {
  const DreamActivityDot({
    super.key,
    this.color = const Color(0xFFD9F66F),
    this.active = true,
    this.size = 8,
  }) : assert(size > 0);

  final Color color;
  final bool active;
  final double size;

  @override
  Widget build(BuildContext context) => _DreamLoop(
    active: active,
    period: const Duration(milliseconds: 2400),
    builder: (context, phase, child) {
      final breath = (1 - math.cos(phase * math.pi * 2)) / 2;
      return SizedBox.square(
        dimension: size * 2.5,
        child: Center(
          child: Container(
            width: size,
            height: size,
            decoration: BoxDecoration(
              color: color,
              shape: BoxShape.circle,
              boxShadow: [
                BoxShadow(
                  color: color.withValues(alpha: .08 + breath * .12),
                  spreadRadius: size * (.2 + breath * .4),
                  blurRadius: size * .2,
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}

/// Supply finite bounds; only the decorative orbit ignores pointer events.
class DreamOrbitHero extends StatelessWidget {
  const DreamOrbitHero({
    super.key,
    required this.child,
    this.color = const Color(0xFFD9F66F),
    this.active = true,
    this.amplitude = 5,
  }) : assert(amplitude >= 0);

  final Widget child;
  final Color color;
  final bool active;
  final double amplitude;

  @override
  Widget build(BuildContext context) => RepaintBoundary(
    child: _DreamLoop(
      active: active,
      period: const Duration(milliseconds: 9600),
      child: child,
      builder: (context, phase, child) => Stack(
        alignment: Alignment.center,
        children: [
          Positioned.fill(
            child: IgnorePointer(
              child: CustomPaint(
                painter: _OrbitPainter(phase: phase, color: color),
              ),
            ),
          ),
          Transform.translate(
            offset: Offset(0, -math.sin(phase * math.pi * 4) * amplitude),
            child: child,
          ),
        ],
      ),
    ),
  );
}

typedef _LoopBuilder =
    Widget Function(BuildContext context, double phase, Widget? child);

class _DreamLoop extends StatefulWidget {
  const _DreamLoop({
    required this.active,
    required this.period,
    required this.builder,
    this.child,
  });

  final bool active;
  final Duration period;
  final _LoopBuilder builder;
  final Widget? child;

  @override
  State<_DreamLoop> createState() => _DreamLoopState();
}

class _DreamLoopState extends State<_DreamLoop>
    with SingleTickerProviderStateMixin {
  late final _controller = AnimationController(
    vsync: this,
    duration: widget.period,
  );
  bool _motionEnabled = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _motionEnabled = AppMotion.enabled(context);
    _sync();
  }

  @override
  void didUpdateWidget(_DreamLoop oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.period != widget.period) {
      _controller.stop();
      _controller.duration = widget.period;
    }
    _sync();
  }

  void _sync() {
    if (_motionEnabled && widget.active) {
      if (!_controller.isAnimating) _controller.repeat();
    } else {
      _controller.stop();
      _controller.value = 0;
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _controller,
    child: widget.child,
    builder: (context, child) =>
        widget.builder(context, _controller.value, child),
  );
}

class _OrbitPainter extends CustomPainter {
  const _OrbitPainter({required this.phase, required this.color});

  final double phase;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width * .5, size.height * .67);
    final radiusX = size.width * .43;
    final radiusY = size.height * .16;
    canvas.save();
    canvas.translate(center.dx, center.dy);
    canvas.rotate(-.18);
    final orbit = Rect.fromCenter(
      center: Offset.zero,
      width: radiusX * 2,
      height: radiusY * 2,
    );
    canvas.drawOval(
      orbit,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1
        ..color = color.withValues(alpha: .16),
    );
    final angle = phase * math.pi * 2 - math.pi * .2;
    canvas.drawArc(
      orbit,
      angle - .45,
      .45,
      false,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.4
        ..strokeCap = StrokeCap.round
        ..color = color.withValues(alpha: .55),
    );
    final point = Offset(math.cos(angle) * radiusX, math.sin(angle) * radiusY);
    canvas.drawCircle(point, 7, Paint()..color = color.withValues(alpha: .09));
    canvas.drawCircle(point, 2.5, Paint()..color = color);
    canvas.restore();
  }

  @override
  bool shouldRepaint(_OrbitPainter oldDelegate) =>
      oldDelegate.phase != phase || oldDelegate.color != color;
}
