import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[3]
OUTPUT = ROOT / 'app' / 'assets' / 'ui-v3'
QA = Path(__file__).resolve().parent


def fit_rgba(image, size, inset=0.06):
    alpha = np.asarray(image.getchannel('A'))
    rows, columns = np.nonzero(alpha > 8)
    if not len(rows):
        raise ValueError('Source has no visible content')
    bounds = (int(columns.min()), int(rows.min()), int(columns.max()) + 1, int(rows.max()) + 1)
    cropped = image.crop(bounds)
    available = round(size * (1 - 2 * inset))
    scale = min(available / cropped.width, available / cropped.height)
    resized_size = (round(cropped.width * scale), round(cropped.height * scale))
    # Premultiplied resizing keeps transparent RGB from forming light fringes.
    resized = cropped.convert('RGBa').resize(resized_size, Image.Resampling.LANCZOS).convert('RGBA')
    canvas = Image.new('RGBA', (size, size))
    canvas.alpha_composite(resized, ((size - resized.width) // 2, (size - resized.height) // 2))
    return canvas, bounds


def describe(path, source, purpose, source_bounds, design_source):
    original = Image.open(path)
    image = original.convert('RGBA')
    alpha = np.asarray(image.getchannel('A'))
    border = np.concatenate((alpha[0], alpha[-1], alpha[:, 0], alpha[:, -1]))
    return {
        'file': path.name,
        'size': list(image.size),
        'format': f'PNG {original.mode}',
        'transparent': bool(np.any(alpha < 255)),
        'purpose': purpose,
        'source': str(source.relative_to(ROOT)).replace('\\', '/'),
        'design_source': design_source,
        'source_content_bounds': source_bounds,
        'alpha_range': [int(alpha.min()), int(alpha.max())],
        'transparent_percent': round(float(np.mean(alpha == 0) * 100), 2),
        'partial_alpha_percent': round(float(np.mean((alpha > 0) & (alpha < 255)) * 100), 2),
        'opaque_percent': round(float(np.mean(alpha == 255) * 100), 2),
        'border_alpha_max': int(border.max()),
        'bytes': path.stat().st_size,
    }


def contact_sheet(paths):
    tile = 280
    sheet = Image.new('RGB', (tile * 3, (tile + 36) * len(paths)), '#F5F6F2')
    draw = ImageDraw.Draw(sheet)
    for row, path in enumerate(paths):
        image = Image.open(path).convert('RGBA')
        image.thumbnail((tile - 24, tile - 24), Image.Resampling.LANCZOS)
        for column, color in enumerate(('#F5F6F2', '#11151B', '#D9F66F')):
            left, top = column * tile, row * (tile + 36)
            draw.rectangle((left, top, left + tile, top + tile), fill=color)
            sheet.paste(image, (left + (tile - image.width) // 2, top + (tile - image.height) // 2), image)
            draw.text((left + 8, top + tile + 8), path.name, fill='#11151B')
    sheet.save(QA / 'asset-edge-review.jpg', quality=94)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('spec', type=Path)
    args = parser.parse_args()
    spec = json.loads(args.spec.read_text(encoding='utf-8'))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    records, paths = [], []
    for entry in spec['assets']:
        source = ROOT / entry['source']
        image = Image.open(source).convert('RGBA')
        if entry.get('crop'):
            image = image.crop(entry['crop'])
        alpha = np.asarray(image.getchannel('A'))
        if entry.get('transparent', True) and not np.any(alpha == 0):
            raise ValueError(f'{source.name} needs actual transparent pixels before packaging')
        if entry.get('transparent', True):
            result, bounds = fit_rgba(image, entry['size'], entry.get('inset', 0.06))
        else:
            bounds = (0, 0, image.width, image.height)
            result = image.convert('RGB').resize((entry['size'], entry['size']), Image.Resampling.LANCZOS)
        path = OUTPUT / entry['file']
        result.save(path, optimize=True)
        record = describe(path, source, entry['purpose'], bounds, entry.get('design_source', spec['design_source']))
        record['source_crop'] = entry.get('crop')
        records.append(record)
        paths.append(path)
    manifest = {'design_source': spec['design_source'], 'assets': records}
    (OUTPUT / 'asset-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    contact_sheet(paths)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
