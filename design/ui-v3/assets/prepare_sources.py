import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


sys.path.insert(0, str(Path.home() / '.cache' / 'codex-ui-v3-image-tools'))
import cv2


FOLDER = Path(__file__).resolve().parent


def clean_alpha(source, target):
    image = Image.open(FOLDER / source).convert('RGBA')
    alpha = image.getchannel('A').point(lambda value: 255 if value > 128 else 0)
    alpha = alpha.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5))
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.55))
    image.putalpha(alpha)
    image.save(FOLDER / target)


def extract_checker_subject(source, target):
    image = Image.open(FOLDER / source).convert('RGB')
    rgb = np.asarray(image)
    high = rgb.max(axis=2).astype(np.int16)
    low = rgb.min(axis=2).astype(np.int16)
    mask = ((high > 218) | (high - low > 6)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    count, labels, stats, centers = cv2.connectedComponentsWithStats(mask)
    selected = np.where(stats[:, cv2.CC_STAT_AREA] > 1000)[0]
    selected = selected[selected != 0]
    mask = np.uint8(np.isin(labels, selected)) * 255
    exterior = mask.copy()
    cv2.floodFill(exterior, None, (0, 0), 255)
    mask |= 255 - exterior
    mask = cv2.GaussianBlur(mask, (0, 0), 1.3)
    mask = np.uint8(mask > 160) * 255
    mask = cv2.erode(mask, np.ones((3, 3), np.uint8))
    alpha = Image.fromarray(mask).filter(ImageFilter.GaussianBlur(0.55))
    image.putalpha(alpha)
    image.save(FOLDER / target)


if __name__ == '__main__':
    clean_alpha('hero-source.png', 'hero-clean.png')
    clean_alpha('avatar-source.png', 'avatar-clean.png')
    clean_alpha('archive-source.png', 'archive-clean.png')
    clean_alpha('agents-source.png', 'agents-clean.png')
    clean_alpha('settings-source.png', 'settings-clean.png')
    canvas = Image.new('RGB', (1500, 500), '#11151B')
    for index, name in enumerate(('empty', 'project', 'inbox')):
        extract_checker_subject(f'{name}-source.png', f'{name}-clean.png')
        image = Image.open(FOLDER / f'{name}-clean.png')
        background = Image.new('RGBA', image.size, '#11151B')
        background.alpha_composite(image)
        canvas.paste(background.resize((500, 500)).convert('RGB'), (index * 500, 0))
    canvas.save(FOLDER / 'extraction-review.jpg')
