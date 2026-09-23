import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../theme/motion.dart';
import '../theme/tokens.dart';

class BlenderMascot extends StatefulWidget {
  const BlenderMascot({super.key, required this.size});

  final double size;

  @override
  State<BlenderMascot> createState() => _BlenderMascotState();
}

class _BlenderMascotState extends State<BlenderMascot>
    with TickerProviderStateMixin, WidgetsBindingObserver {
  late final _orbit = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 4),
  )..addListener(_advanceFrame);
  late final _greeting = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  );
  final _frame = ValueNotifier<int>(0);
  ImageStream? _stream;
  ImageStreamListener? _listener;
  ImageInfo? _atlas;
  bool _enabled = false;
  bool _foreground = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _enabled = AppMotion.enabled(context);
    if (_enabled && _stream == null) _loadAtlas();
    _syncPlayback();
  }

  void _loadAtlas() {
    _stream = const AssetImage(
      'assets/motion/night-orbit-atlas.png',
    ).resolve(createLocalImageConfiguration(context));
    _listener = ImageStreamListener(
      (info, synchronousCall) {
        if (!mounted) {
          info.dispose();
          return;
        }
        _atlas?.dispose();
        setState(() => _atlas = info);
        _syncPlayback();
      },
      onError: (Object error, StackTrace? stackTrace) {
        // Keep the still image usable when the larger animation cannot load.
        _orbit.stop();
      },
    );
    _stream!.addListener(_listener!);
  }

  void _advanceFrame() => _frame.value = (_orbit.value * 48).floor() % 48;

  void _syncPlayback() {
    if (_enabled && _foreground && _atlas != null) {
      if (!_orbit.isAnimating) _orbit.repeat();
    } else {
      _orbit.stop();
      _greeting.stop();
      _greeting.value = 0;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _syncPlayback();
  }

  void _greet() {
    if (_enabled && _foreground) _greeting.forward(from: 0);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    if (_listener != null) _stream?.removeListener(_listener!);
    _atlas?.dispose();
    _orbit.dispose();
    _greeting.dispose();
    _frame.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Tooltip(
    message: '和小梦打个招呼',
    child: Semantics(
      label: '和小梦打个招呼',
      button: true,
      child: TextButton(
        onPressed: _greet,
        style: TextButton.styleFrom(
          padding: EdgeInsets.zero,
          minimumSize: Size.zero,
          overlayColor: Colors.transparent,
          shape: const CircleBorder(),
        ),
        child: RepaintBoundary(
          child: AnimatedBuilder(
            animation: _greeting,
            child: SizedBox.square(
              dimension: widget.size,
              child: _atlas != null && _enabled
                  ? ValueListenableBuilder<int>(
                      valueListenable: _frame,
                      builder: (context, frame, child) => CustomPaint(
                        painter: BlenderFramePainter(
                          image: _atlas!.image,
                          frame: frame,
                        ),
                      ),
                    )
                  : Image.asset(
                      'assets/motion/night-orbit-still.png',
                      excludeFromSemantics: true,
                      errorBuilder: (context, error, stackTrace) => Image.asset(
                        'assets/ui-v3/hero-orbit.png',
                        excludeFromSemantics: true,
                      ),
                    ),
            ),
            builder: (context, child) {
              final t = _greeting.value;
              final bounce = math.sin(t * math.pi * 3) * math.pow(1 - t, 2);
              return CustomPaint(
                foregroundPainter: _GreetingSparkles(t),
                child: Transform.translate(
                  offset: Offset(0, -bounce * widget.size * .045),
                  child: Transform.rotate(angle: bounce * .075, child: child),
                ),
              );
            },
          ),
        ),
      ),
    ),
  );
}

class BlenderFramePainter extends CustomPainter {
  const BlenderFramePainter({required this.image, required this.frame});

  final ui.Image image;
  final int frame;

  @override
  void paint(Canvas canvas, Size size) {
    final cell = Size(image.width / 8, image.height / 6);
    canvas.drawImageRect(
      image,
      Rect.fromLTWH(
        (frame % 8) * cell.width,
        (frame ~/ 8) * cell.height,
        cell.width,
        cell.height,
      ),
      Offset.zero & size,
      Paint()..filterQuality = FilterQuality.medium,
    );
  }

  @override
  bool shouldRepaint(BlenderFramePainter oldDelegate) =>
      oldDelegate.frame != frame || oldDelegate.image != image;
}

class _GreetingSparkles extends CustomPainter {
  const _GreetingSparkles(this.progress);
  final double progress;

  @override
  void paint(Canvas canvas, Size size) {
    if (progress <= 0 || progress >= 1) return;
    final fade = math.sin(progress * math.pi);
    final paint = Paint()..color = AppColors.lime.withValues(alpha: fade * .85);
    for (var i = 0; i < 5; i++) {
      final angle = -math.pi + i * math.pi / 4;
      final radius = size.width * (.28 + progress * .16);
      final point = Offset(
        size.width / 2 + math.cos(angle) * radius,
        size.height * .55 + math.sin(angle) * radius,
      );
      final r = size.width * .022 * fade;
      final star = Path()
        ..moveTo(point.dx, point.dy - r)
        ..quadraticBezierTo(
          point.dx + r * .2,
          point.dy - r * .2,
          point.dx + r,
          point.dy,
        )
        ..quadraticBezierTo(
          point.dx + r * .2,
          point.dy + r * .2,
          point.dx,
          point.dy + r,
        )
        ..quadraticBezierTo(
          point.dx - r * .2,
          point.dy + r * .2,
          point.dx - r,
          point.dy,
        )
        ..quadraticBezierTo(
          point.dx - r * .2,
          point.dy - r * .2,
          point.dx,
          point.dy - r,
        );
      canvas.drawPath(star, paint);
    }
  }

  @override
  bool shouldRepaint(_GreetingSparkles oldDelegate) =>
      oldDelegate.progress != progress;
}
