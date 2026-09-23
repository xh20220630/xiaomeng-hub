import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../theme/motion.dart';

enum BlenderIntroScene { project, inbox, archive }

class BlenderIntroArt extends StatefulWidget {
  const BlenderIntroArt({super.key, required this.scene, this.active = true});

  final BlenderIntroScene scene;
  final bool active;

  @override
  State<BlenderIntroArt> createState() => _BlenderIntroArtState();
}

class _BlenderIntroArtState extends State<BlenderIntroArt>
    with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  late final AnimationController _loop = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 4),
  )..addListener(() => _frame.value = (_loop.value * 48).floor() % 48);
  final _frame = ValueNotifier<int>(0);
  ImageStream? _stream;
  ImageStreamListener? _listener;
  ImageInfo? _atlas;
  bool _enabled = false;
  bool _foreground = true;
  int _generation = 0;

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
    _syncPlayback();
  }

  @override
  void didUpdateWidget(BlenderIntroArt oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.scene != widget.scene) {
      _releaseAtlas();
      _loop.value = 0;
    }
    _syncPlayback();
  }

  void _loadAtlas() {
    final generation = ++_generation;
    _stream = AssetImage(
      'assets/motion/${widget.scene.name}-intro-atlas.png',
    ).resolve(createLocalImageConfiguration(context));
    _listener = ImageStreamListener(
      (info, synchronousCall) {
        // A page switch can complete before the previous texture finishes loading.
        if (!mounted || generation != _generation) {
          info.dispose();
          return;
        }
        _atlas?.dispose();
        setState(() => _atlas = info);
        _syncPlayback();
      },
      onError: (Object error, StackTrace? stackTrace) {
        if (generation == _generation) _loop.stop();
      },
    );
    _stream!.addListener(_listener!);
  }

  void _syncPlayback() {
    final playing = _enabled && widget.active && _foreground;
    if (playing && _stream == null) _loadAtlas();
    if (playing && _atlas != null) {
      if (!_loop.isAnimating) _loop.repeat();
    } else {
      _loop.stop();
    }
  }

  void _releaseAtlas() {
    _generation++;
    _loop.stop();
    if (_listener != null) _stream?.removeListener(_listener!);
    _stream = null;
    _listener = null;
    _atlas?.dispose();
    _atlas = null;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _syncPlayback();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _releaseAtlas();
    _loop.dispose();
    _frame.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: RepaintBoundary(
      child: SizedBox(
        width: 106,
        height: 112,
        child: _atlas != null && _enabled
            ? ValueListenableBuilder<int>(
                valueListenable: _frame,
                builder: (context, frame, child) => CustomPaint(
                  painter: IntroFramePainter(
                    image: _atlas!.image,
                    frame: frame,
                  ),
                ),
              )
            : Image.asset(
                'assets/motion/${widget.scene.name}-intro-still.png',
                fit: BoxFit.contain,
                gaplessPlayback: false,
                errorBuilder: (context, error, stackTrace) => Image.asset(
                  'assets/ui-v3/${widget.scene.name}-art.png',
                  fit: BoxFit.contain,
                ),
              ),
      ),
    ),
  );
}

class IntroFramePainter extends CustomPainter {
  const IntroFramePainter({required this.image, required this.frame});

  final ui.Image image;
  final int frame;

  @override
  void paint(Canvas canvas, Size size) {
    final cell = image.width / 8;
    final side = size.shortestSide;
    canvas.drawImageRect(
      image,
      Rect.fromLTWH((frame % 8) * cell, (frame ~/ 8) * cell, cell, cell),
      Rect.fromCenter(
        center: size.center(Offset.zero),
        width: side,
        height: side,
      ),
      Paint()..filterQuality = FilterQuality.medium,
    );
  }

  @override
  bool shouldRepaint(IntroFramePainter oldDelegate) =>
      oldDelegate.image != image || oldDelegate.frame != frame;
}
