import 'package:flutter/material.dart';
import '../theme/tokens.dart';
import 'mascot_motion.dart';

enum MascotMood {
  running,
  approval,
  completed,
  error,
  idle,
  avatar,
  main,
  icon,
}

MascotMood moodForStatus(String status) => switch (status) {
  'running' => MascotMood.running,
  'waiting_input' || 'needs_approval' => MascotMood.approval,
  'done' || 'ended' => MascotMood.completed,
  'error' || 'offline' => MascotMood.error,
  _ => MascotMood.idle,
};

String _asset(MascotMood mood) => switch (mood) {
  MascotMood.running ||
  MascotMood.approval ||
  MascotMood.completed ||
  MascotMood.main => 'assets/ui-v3/hero-orbit.png',
  MascotMood.error || MascotMood.idle => 'assets/ui-v3/empty-state.png',
  MascotMood.avatar || MascotMood.icon => 'assets/ui-v3/mascot-avatar.png',
};

MascotMotionCue motionForMood(MascotMood mood) => switch (mood) {
  MascotMood.running => MascotMotionCue.thinking,
  MascotMood.approval => MascotMotionCue.approval,
  MascotMood.completed => MascotMotionCue.success,
  MascotMood.error => MascotMotionCue.error,
  MascotMood.idle => MascotMotionCue.idle,
  _ => MascotMotionCue.welcome,
};

class MascotImage extends StatelessWidget {
  final MascotMood mood;
  final double size;
  final bool circleBg;
  final bool floaty;
  final Duration floatPeriod;

  const MascotImage(
    this.mood, {
    super.key,
    this.size = 40,
    this.circleBg = false,
    this.floaty = false,
    this.floatPeriod = const Duration(milliseconds: 780),
  });

  factory MascotImage.forStatus(
    String status, {
    Key? key,
    double size = 40,
    bool circleBg = false,
    bool floaty = false,
  }) => MascotImage(
    moodForStatus(status),
    key: key,
    size: size,
    circleBg: circleBg,
    floaty: floaty,
  );

  @override
  Widget build(BuildContext context) {
    final inset = circleBg ? size * .08 : 0.0;
    Widget image = Image.asset(
      _asset(mood),
      width: size - inset * 2,
      height: size - inset * 2,
      fit: BoxFit.contain,
      cacheWidth: (size * 2).ceil(),
      filterQuality: FilterQuality.medium,
    );
    if (circleBg) {
      image = Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: const BoxDecoration(
          color: AppColors.mascotPink,
          shape: BoxShape.circle,
        ),
        child: image,
      );
    }
    return floaty
        ? MascotMotion(
            cue: motionForMood(mood),
            trigger: mood,
            duration: floatPeriod,
            child: image,
          )
        : image;
  }
}
