import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../theme/motion.dart';
import '../theme/tokens.dart';

class DreamNavigation extends StatefulWidget {
  const DreamNavigation({
    super.key,
    required this.selectedIndex,
    required this.onSelected,
    this.pending = 0,
  }) : assert(selectedIndex >= 0 && selectedIndex < 4);

  final int selectedIndex;
  final int pending;
  final ValueChanged<int> onSelected;

  @override
  State<DreamNavigation> createState() => _DreamNavigationState();
}

class _DreamNavigationState extends State<DreamNavigation>
    with TickerProviderStateMixin, WidgetsBindingObserver {
  static const _labels = ['会话', '项目', '收件箱', '归档'];
  static const _fallbacks = [
    Icons.chat_bubble_outline_rounded,
    Icons.folder_open_rounded,
    Icons.mail_outline_rounded,
    Icons.inventory_2_outlined,
  ];
  late final _poses = List.generate(
    4,
    (index) => AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 600),
      reverseDuration: const Duration(milliseconds: 360),
      value: widget.selectedIndex == index ? 1 : 0,
    ),
  );
  ImageStream? _stream;
  ImageStreamListener? _listener;
  ImageInfo? _sprites;
  bool _enabled = false;
  bool _animatedAsset = false;
  int? _hoveredIndex;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _enabled = AppMotion.enabled(context);
    if (_stream == null || _animatedAsset != _enabled) _loadSprites();
    if (!_enabled) _settlePoses();
  }

  @override
  void didUpdateWidget(DreamNavigation oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.selectedIndex != oldWidget.selectedIndex) {
      if (!_enabled) {
        _settlePoses();
      } else {
        for (var index = 0; index < _poses.length; index++) {
          if (widget.selectedIndex == index) {
            _poses[index].forward();
          } else {
            _poses[index].reverse();
          }
        }
      }
    }
  }

  void _loadSprites() {
    if (_listener != null) _stream?.removeListener(_listener!);
    _sprites?.dispose();
    _sprites = null;
    _animatedAsset = _enabled;
    final asset = _animatedAsset
        ? 'ip-tabbar-atlas.png'
        : 'ip-tabbar-still.png';
    _stream = AssetImage(
      'assets/motion/$asset',
    ).resolve(createLocalImageConfiguration(context));
    _listener = ImageStreamListener(
      (info, synchronousCall) {
        if (!mounted) {
          info.dispose();
          return;
        }
        _sprites?.dispose();
        setState(() => _sprites = info);
      },
      onError: (Object error, StackTrace? stackTrace) {
        // Navigation remains usable with native icons if the sprite cannot load.
      },
    );
    _stream!.addListener(_listener!);
  }

  void _settlePoses() {
    for (var index = 0; index < _poses.length; index++) {
      _poses[index].value = widget.selectedIndex == index ? 1 : 0;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) _settlePoses();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    if (_listener != null) _stream?.removeListener(_listener!);
    _sprites?.dispose();
    for (final pose in _poses) {
      pose.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final height =
        78.0 +
        math.max(0, MediaQuery.textScalerOf(context).scale(11) - 11) * 1.2;
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 4, 18, 6),
        child: Material(
          type: MaterialType.transparency,
          child: SizedBox(
            height: height,
            child: Row(
              children: [for (var i = 0; i < 4; i++) Expanded(child: _tab(i))],
            ),
          ),
        ),
      ),
    );
  }

  Widget _tab(int index) {
    final selected = widget.selectedIndex == index;
    final hasPending = index == 2 && widget.pending > 0;
    return Semantics(
      selected: selected,
      value: hasPending ? '${widget.pending} 项待处理' : null,
      child: Tooltip(
        message: hasPending ? '收件箱，${widget.pending} 项待处理' : _labels[index],
        excludeFromSemantics: true,
        child: TextButton(
          key: ValueKey('dream-tab-$index'),
          onPressed: () => widget.onSelected(index),
          onHover: (hovered) =>
              setState(() => _hoveredIndex = hovered ? index : null),
          style: TextButton.styleFrom(
            padding: const EdgeInsets.symmetric(vertical: 3),
            minimumSize: const Size(48, 64),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(10),
            ),
            overlayColor: Colors.transparent,
            foregroundColor: selected ? AppColors.ink : AppColors.textSecondary,
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              AnimatedScale(
                scale: selected ? 1.06 : (_hoveredIndex == index ? 1.04 : 1),
                duration: AppMotion.duration(
                  context,
                  const Duration(milliseconds: 240),
                ),
                curve: Curves.easeOutCubic,
                child: Badge(
                  isLabelVisible: hasPending,
                  label: ExcludeSemantics(
                    child: Text(
                      widget.pending > 99 ? '99+' : '${widget.pending}',
                    ),
                  ),
                  backgroundColor: const Color(0xFFF28C79),
                  textColor: AppColors.night,
                  alignment: Alignment.topRight,
                  offset: const Offset(3, 1),
                  child: ExcludeSemantics(
                    child: SizedBox.square(
                      dimension: 38,
                      child: RepaintBoundary(
                        child: AnimatedBuilder(
                          animation: _poses[index],
                          builder: (context, child) {
                            final progress = _poses[index].value;
                            return Transform.translate(
                              offset: Offset(0, -progress * 2),
                              child: Opacity(
                                opacity: .85 + progress * .15,
                                child: _sprites == null
                                    ? Icon(_fallbacks[index], size: 25)
                                    : CustomPaint(
                                        painter: NavigationSpritePainter(
                                          image: _sprites!.image,
                                          index: index,
                                          frame: (progress * 15).round(),
                                          animated: _animatedAsset,
                                        ),
                                      ),
                              ),
                            );
                          },
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 3),
              Text(
                _labels[index],
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppFont.ui(
                  size: 11,
                  height: 1.2,
                  color: selected ? AppColors.ink : AppColors.textSecondary,
                  weight: selected ? FontWeight.w600 : FontWeight.w500,
                ),
              ),
              const SizedBox(height: 4),
              AnimatedContainer(
                duration: AppMotion.duration(context, AppMotion.quick),
                width: 4,
                height: 4,
                decoration: BoxDecoration(
                  color: selected ? AppColors.success : Colors.transparent,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class NavigationSpritePainter extends CustomPainter {
  const NavigationSpritePainter({
    required this.image,
    required this.index,
    required this.frame,
    required this.animated,
  });

  final ui.Image image;
  final int index;
  final int frame;
  final bool animated;

  @override
  void paint(Canvas canvas, Size size) {
    final columns = animated ? 8 : 4;
    final cell = image.width / columns;
    final position = animated
        ? index * 16 + frame
        : index + (frame == 15 ? 4 : 0);
    canvas.drawImageRect(
      image,
      Rect.fromLTWH(
        (position % columns) * cell,
        (position ~/ columns) * cell,
        cell,
        cell,
      ),
      Offset.zero & size,
      Paint()..filterQuality = FilterQuality.medium,
    );
  }

  @override
  bool shouldRepaint(NavigationSpritePainter oldDelegate) =>
      oldDelegate.image != image ||
      oldDelegate.index != index ||
      oldDelegate.frame != frame ||
      oldDelegate.animated != animated;
}
