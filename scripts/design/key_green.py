from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract a pink, white, gold and blue subject from a green studio plate")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    arguments = parser.parse_args()
    with Image.open(arguments.source) as source:
        rgb = np.asarray(source.convert("RGB"), dtype=np.float32)
    maximum_rb = np.maximum(rgb[:, :, 0], rgb[:, :, 2])
    green_edge = rgb[:, :, 1] > maximum_rb - 8
    alpha = np.ones(rgb.shape[:2], dtype=np.float32)
    alpha[green_edge] = np.clip((maximum_rb[green_edge] - 20) / 225, 0, 1)
    background = np.array([5, 250, 8], dtype=np.float32)
    edge = green_edge & (alpha > 0) & (alpha < 1)
    # Only mixed edge pixels need their green plate contribution removed.
    rgb[edge] = (rgb[edge] - (1 - alpha[edge, None]) * background) / alpha[edge, None]
    rgb[:, :, 1][edge] = np.minimum(rgb[:, :, 1][edge], np.maximum(rgb[:, :, 0][edge], rgb[:, :, 2][edge]))
    rgba = np.dstack((np.clip(rgb, 0, 255), np.round(alpha * 255))).astype(np.uint8)
    rgba[rgba[:, :, 3] == 0, :3] = 0
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba).save(arguments.output, optimize=True)
    print(arguments.output)


if __name__ == "__main__":
    main()
