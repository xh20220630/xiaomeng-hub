from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw


REPOSITORY = Path(__file__).resolve().parents[2]


def main() -> None:
    parser = argparse.ArgumentParser(description="Check mascot alpha and produce a review sheet")
    parser.add_argument("--sheet", type=Path)
    arguments = parser.parse_args()
    files = sorted((REPOSITORY / "app" / "assets" / "mascot-v2").glob("*.png"))
    orbit = REPOSITORY / "app" / "assets" / "motion" / "dream-orbit.png"
    if orbit.exists():
        files.append(orbit)
    tile, label_height = 192, 28
    sheet = Image.new("RGB", (tile * 3, (tile + label_height) * len(files)), "white")
    draw = ImageDraw.Draw(sheet)
    report = []
    for index, path in enumerate(files):
        with Image.open(path) as source:
            image = source.convert("RGBA")
        alpha = image.getchannel("A")
        edges = [
            alpha.crop((0, 0, image.width, 1)),
            alpha.crop((0, image.height - 1, image.width, image.height)),
            alpha.crop((0, 0, 1, image.height)),
            alpha.crop((image.width - 1, 0, image.width, image.height)),
        ]
        border_max = max(edge.getextrema()[1] for edge in edges)
        if alpha.getextrema() != (0, 255) or border_max != 0:
            raise ValueError(f"{path.name}: expected transparent padding and visible opaque content")
        report.append({"file": path.name, "size": image.size, "content_bounds": alpha.getbbox(), "border_alpha_max": border_max})
        image.thumbnail((tile - 16, tile - 16), Image.Resampling.LANCZOS)
        y = index * (tile + label_height)
        for column, color in enumerate(("#fbf7f1", "#302823", "#e7dedf")):
            x = column * tile
            draw.rectangle((x, y, x + tile - 1, y + tile - 1), fill=color)
            if column == 2:
                for row in range(12):
                    for square in range(12):
                        if (row + square) % 2 == 0:
                            draw.rectangle((x + square * 16, y + row * 16, x + square * 16 + 15, y + row * 16 + 15), fill="#f6f1f0")
            sheet.paste(image, (x + (tile - image.width) // 2, y + (tile - image.height) // 2), image)
        draw.text((8, y + tile + 5), path.name, fill="#302823")
    if arguments.sheet:
        arguments.sheet.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(arguments.sheet)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
