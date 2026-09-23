from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image


REPOSITORY = Path(__file__).resolve().parents[2]
OUTPUT = REPOSITORY / "app" / "assets" / "mascot-v2"
SIZES = {"hero": 768, "state": 384, "avatar": 160}


def alpha_metrics(image: Image.Image) -> dict:
    alpha = image.getchannel("A")
    histogram = alpha.histogram()
    pixels = image.width * image.height
    return {
        "size": list(image.size),
        "alpha_range": list(alpha.getextrema()),
        "content_bounds": list(alpha.getbbox() or (0, 0, 0, 0)),
        "transparent_percent": round(100 * histogram[0] / pixels, 2),
        "partial_alpha_percent": round(100 * sum(histogram[1:255]) / pixels, 2),
    }


def export(source: Path, name: str, role: str, inset: float, crop: list[int] | None) -> dict:
    with Image.open(source) as original:
        image = original.convert("RGBA")
    if image.getchannel("A").getextrema()[0] == 255:
        raise ValueError(f"{source.name} has no transparent background; review the source first")
    if crop:
        image = image.crop(tuple(crop))
    bounds = image.getchannel("A").getbbox()
    if bounds is None:
        raise ValueError(f"{source.name} contains no visible pixels")
    image = image.crop(bounds)
    size = SIZES[role]
    available = round(size * (1 - inset * 2))
    scale = min(available / image.width, available / image.height)
    target = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    # Premultiplied color prevents hidden RGB from tinting the transparent edges.
    resized = image.convert("RGBa").resize(target, Image.Resampling.LANCZOS).convert("RGBA")
    canvas = Image.new("RGBA", (size, size))
    position = ((size - target[0]) // 2, (size - target[1]) // 2)
    canvas.alpha_composite(resized, position)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    path = OUTPUT / f"{name}.png"
    canvas.save(path, optimize=True)
    return {
        "file": path.name,
        "source": source.name,
        "role": role,
        "inset": inset,
        "source_crop": crop,
        "source_content_bounds": list(bounds),
        "bytes": path.stat().st_size,
        **alpha_metrics(canvas),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Export transparent mascot assets with consistent optical padding")
    parser.add_argument("source", type=Path)
    parser.add_argument("name")
    parser.add_argument("--role", choices=SIZES, default="state")
    parser.add_argument("--inset", type=float, default=0.06)
    parser.add_argument("--crop", type=int, nargs=4, metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"))
    arguments = parser.parse_args()
    if not 0 <= arguments.inset < 0.4:
        parser.error("--inset must be between 0 and 0.4")
    if Path(arguments.name).name != arguments.name:
        parser.error("name must be a filename stem without directories")
    entry = export(arguments.source.resolve(), arguments.name, arguments.role, arguments.inset, arguments.crop)
    manifest_path = OUTPUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"assets": []}
    manifest["assets"] = sorted(
        [asset for asset in manifest["assets"] if asset["file"] != entry["file"]] + [entry],
        key=lambda asset: asset["file"],
    )
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(entry, ensure_ascii=False))


if __name__ == "__main__":
    main()
