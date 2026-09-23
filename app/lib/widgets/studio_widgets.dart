import 'blender_mascot.dart';
import 'blender_intro_art.dart';
import 'package:flutter/material.dart';
import '../theme/tokens.dart';
export 'dream_navigation.dart';
export 'blender_intro_art.dart' show BlenderIntroScene;
import 'dream_motion.dart';

class StudioHero extends StatelessWidget {
  final VoidCallback onStart;
  const StudioHero({super.key, required this.onStart});

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final wide = constraints.maxWidth >= 700;
      final accessible = MediaQuery.textScalerOf(context).scale(1) > 1.2;
      final artSize = wide ? 280.0 : 170.0;
      final copy = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            '灵感在此，\n持续发生。',
            style: AppFont.ui(
              size: wide ? 42 : 29,
              weight: FontWeight.w600,
              height: 1.35,
              color: AppColors.onNight,
              letterSpacing: -1.1,
            ),
          ),
          const SizedBox(height: 12),
          Text(
            '让每个想法，都有回响。',
            style: AppFont.ui(size: 12, color: AppColors.nightMuted),
          ),
          const SizedBox(height: 24),
          DreamPress(
            child: FilledButton.icon(
              onPressed: onStart,
              iconAlignment: IconAlignment.end,
              icon: const Icon(Icons.arrow_outward_rounded, size: 17),
              label: const Text('开启新会话'),
              style: FilledButton.styleFrom(
                backgroundColor: AppColors.lime,
                foregroundColor: AppColors.ink,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(AppRadii.button),
                ),
                padding: const EdgeInsets.symmetric(
                  horizontal: 18,
                  vertical: 13,
                ),
              ),
            ),
          ),
        ],
      );
      return Container(
        width: double.infinity,
        clipBehavior: Clip.antiAlias,
        decoration: const BoxDecoration(
          color: AppColors.night,
          borderRadius: BorderRadius.vertical(
            bottom: Radius.circular(AppRadii.hero),
          ),
        ),
        child: accessible
            ? Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    copy,
                    const Center(child: BlenderMascot(size: 160)),
                  ],
                ),
              )
            : SizedBox(
                height: wide ? 280 : 218,
                child: Stack(
                  children: [
                    Positioned(
                      right: wide ? 34 : 2,
                      top: wide ? -3 : 12,
                      child: DreamReveal(
                        delay: const Duration(milliseconds: 180),
                        child: BlenderMascot(size: artSize),
                      ),
                    ),
                    Positioned(
                      left: wide ? 42 : 24,
                      top: 16,
                      right: wide ? 310 : 104,
                      child: DreamReveal(child: copy),
                    ),
                  ],
                ),
              ),
      );
    },
  );
}

class DreamPageIntro extends StatelessWidget {
  final String? eyebrow;
  final String title;
  final String subtitle;
  final IconData icon;
  final bool dark;
  final String? art;
  final BlenderIntroScene? motionScene;
  final bool motionActive;
  const DreamPageIntro({
    super.key,
    this.eyebrow,
    required this.title,
    required this.subtitle,
    required this.icon,
    this.dark = false,
    this.art,
    this.motionScene,
    this.motionActive = true,
  });
  @override
  Widget build(BuildContext context) => DreamReveal(
    child: Container(
      width: double.infinity,
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: dark ? AppColors.night : AppColors.halo,
        borderRadius: BorderRadius.circular(AppRadii.hero),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (eyebrow != null) ...[
            Row(
              children: [
                Expanded(
                  child: Text(
                    eyebrow!,
                    style: AppFont.ui(
                      size: 9,
                      color: dark
                          ? AppColors.nightMuted
                          : AppColors.textSecondary,
                      letterSpacing: 1.8,
                    ),
                  ),
                ),
                Icon(
                  icon,
                  size: 22,
                  color: dark ? AppColors.lime : AppColors.success,
                ),
              ],
            ),
            const SizedBox(height: 24),
          ],
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: AppFont.ui(
                        size: 20,
                        weight: FontWeight.w600,
                        height: 1.4,
                        letterSpacing: -.4,
                        color: dark ? AppColors.onNight : AppColors.ink,
                      ),
                    ),
                    const SizedBox(height: 10),
                    Text(
                      subtitle,
                      style: AppFont.ui(
                        size: 12,
                        height: 1.6,
                        color: dark
                            ? AppColors.nightMuted
                            : AppColors.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
              if ((art != null || motionScene != null) &&
                  MediaQuery.textScalerOf(context).scale(1) <= 1.2)
                Padding(
                  padding: const EdgeInsets.only(left: 8),
                  child: motionScene != null
                      ? BlenderIntroArt(
                          scene: motionScene!,
                          active: motionActive,
                        )
                      : Image.asset(
                          art!,
                          width: 106,
                          height: 112,
                          fit: BoxFit.contain,
                          excludeFromSemantics: true,
                        ),
                ),
            ],
          ),
        ],
      ),
    ),
  );
}

class ConnectionPill extends StatelessWidget {
  final String label;
  final bool online;
  final bool dark;
  final VoidCallback? onTap;
  const ConnectionPill({
    super.key,
    required this.label,
    required this.online,
    this.onTap,
    this.dark = false,
  });
  @override
  Widget build(BuildContext context) => Material(
    color: dark
        ? AppColors.nightRaised
        : online
        ? AppColors.greenLight
        : AppColors.timestampBg,
    borderRadius: BorderRadius.circular(30),
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(30),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            DreamActivityDot(
              active: online,
              color: online
                  ? (dark ? AppColors.lime : AppColors.success)
                  : AppColors.textPlaceholder,
            ),
            const SizedBox(width: 7),
            Text(
              label,
              style: AppFont.ui(
                size: 11,
                weight: FontWeight.w500,
                color: dark ? AppColors.onNight : AppColors.textSecondary,
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
