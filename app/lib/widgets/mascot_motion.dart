import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/widgets.dart';
import '../theme/motion.dart';

enum MascotMotionCue { welcome, thinking, approval, success, error, idle }

/// Plays once when the cue or trigger changes; frequent stream rebuilds stay still.
class MascotMotion extends StatefulWidget {
  const MascotMotion({
    super.key,
    required this.child,
    this.cue = MascotMotionCue.welcome,
    this.trigger,
    this.duration = AppMotion.character,
  });

  final Widget child;
  final MascotMotionCue cue;
  final Object? trigger;
  final Duration duration;

  @override
  State<MascotMotion> createState() => _MascotMotionState();
}

class _MascotMotionState extends State<MascotMotion>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: widget.duration,
    value: 1,
  );
  bool _started = false;
  bool _motionEnabled = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _motionEnabled = AppMotion.enabled(context);
    if (!_started) {
      _started = true;
      _play();
    } else if (!_motionEnabled) {
      _controller.value = 1;
    }
  }

  @override
  void didUpdateWidget(MascotMotion oldWidget) {
    super.didUpdateWidget(oldWidget);
    _controller.duration = widget.duration;
    if (widget.cue != oldWidget.cue || widget.trigger != oldWidget.trigger) {
      _play();
    }
  }

  void _play() {
    if (_motionEnabled) {
      _controller.forward(from: 0);
    } else {
      _controller.value = 1;
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
    builder: (context, child) {
      final t = _controller.value;
      final wave = math.sin(math.pi * t);
      final settle = 1 - AppMotion.enter.transform(t);
      final (dx, dy, scale, angle) = switch (widget.cue) {
        MascotMotionCue.welcome => (
          0.0,
          16 * settle - 4 * wave,
          1 - .08 * settle,
          -.04 * settle,
        ),
        MascotMotionCue.thinking => (
          0.0,
          -4 * wave,
          1.0,
          .018 * math.sin(2 * math.pi * t),
        ),
        MascotMotionCue.approval => (0.0, -2 * wave, 1.0, -.055 * wave),
        MascotMotionCue.success => (
          0.0,
          -13 * wave,
          1 + .055 * wave,
          .03 * wave,
        ),
        MascotMotionCue.error => (
          3 * math.sin(4 * math.pi * t) * (1 - t),
          0.0,
          1.0,
          0.0,
        ),
        MascotMotionCue.idle => (0.0, 3 * wave, 1 - .015 * wave, 0.0),
      };
      return Transform.translate(
        offset: Offset(dx, dy),
        child: Transform.rotate(
          angle: angle,
          child: Transform.scale(scale: scale, child: child),
        ),
      );
    },
  );
}

class MotionReveal extends StatefulWidget {
  const MotionReveal({
    super.key,
    required this.child,
    this.delay = Duration.zero,
    this.duration = AppMotion.reveal,
    this.offset = const Offset(0, 12),
  });

  final Widget child;
  final Duration delay;
  final Duration duration;
  final Offset offset;

  @override
  State<MotionReveal> createState() => _MotionRevealState();
}

class _MotionRevealState extends State<MotionReveal>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: widget.duration,
    value: 1,
  );
  Timer? _delay;
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!AppMotion.enabled(context)) {
      _delay?.cancel();
      _controller.value = 1;
      _started = true;
    } else if (!_started) {
      _started = true;
      _controller.value = 0;
      if (widget.delay == Duration.zero) {
        _controller.forward();
      } else {
        _delay = Timer(widget.delay, () {
          if (mounted) _controller.forward();
        });
      }
    }
  }

  @override
  void didUpdateWidget(MotionReveal oldWidget) {
    super.didUpdateWidget(oldWidget);
    _controller.duration = widget.duration;
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
      final t = AppMotion.enter.transform(_controller.value);
      return Opacity(
        opacity: t,
        child: Transform.translate(
          offset: widget.offset * (1 - t),
          child: child,
        ),
      );
    },
  );
}

/// Keeps native button semantics and gestures while adding tactile feedback.
class MotionPress extends StatefulWidget {
  const MotionPress({super.key, required this.child, this.scale = .97});

  final Widget child;
  final double scale;

  @override
  State<MotionPress> createState() => _MotionPressState();
}

class _MotionPressState extends State<MotionPress> {
  bool _pressed = false;

  void _setPressed(bool value) {
    if (value != _pressed) setState(() => _pressed = value);
  }

  @override
  Widget build(BuildContext context) => Listener(
    onPointerDown: (_) => _setPressed(true),
    onPointerUp: (_) => _setPressed(false),
    onPointerCancel: (_) => _setPressed(false),
    child: AnimatedScale(
      scale: _pressed && AppMotion.enabled(context) ? widget.scale : 1,
      duration: AppMotion.duration(context, AppMotion.quick),
      curve: Curves.easeOut,
      child: widget.child,
    ),
  );
}
