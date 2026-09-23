from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "app" / "assets" / "motion"
DESIGN = ROOT / "design" / "ui-v3"
BLEND = Path(__file__).with_suffix(".blend")
FRAME_COUNT = 48
FRAME_SIZE = 384


def pack_frames(frame_dir: Path) -> None:
    from PIL import Image, ImageChops, ImageStat

    frames = [Image.open(frame_dir / f"frame-{i:02d}.png").convert("RGBA") for i in range(FRAME_COUNT)]
    atlas = Image.new("RGBA", (FRAME_SIZE * 8, FRAME_SIZE * 6))
    preview = []
    bounds = []
    for index, frame in enumerate(frames):
        atlas.paste(frame, ((index % 8) * FRAME_SIZE, (index // 8) * FRAME_SIZE))
        background = Image.new("RGBA", frame.size, (17, 21, 27, 255))
        background.alpha_composite(frame)
        preview.append(background.convert("RGB"))
        bounds.append(frame.getchannel("A").getbbox())
    OUTPUT.mkdir(parents=True, exist_ok=True)
    DESIGN.mkdir(parents=True, exist_ok=True)
    atlas.save(OUTPUT / "night-orbit-atlas.png", optimize=True)
    frames[0].save(OUTPUT / "night-orbit-still.png", optimize=True)
    preview[0].save(
        DESIGN / "motion-preview.gif",
        save_all=True,
        append_images=preview[1:],
        duration=[80, 80, 90] * 16,
        loop=0,
        disposal=2,
    )
    preview[0].save(DESIGN / "motion-preview.png", optimize=True)
    contact = Image.new("RGB", (FRAME_SIZE * 4, FRAME_SIZE * 3), (17, 21, 27))
    for index in range(12):
        contact.paste(preview[index * 4], ((index % 4) * FRAME_SIZE, (index // 4) * FRAME_SIZE))
    contact.save(DESIGN / "motion-preview-contact.png", optimize=True)
    alpha = atlas.getchannel("A")
    histogram = alpha.histogram()
    seam = ImageStat.Stat(ImageChops.difference(frames[-1], frames[0])).mean
    adjacent = ImageStat.Stat(ImageChops.difference(frames[0], frames[1])).mean
    metrics = {
        "frame_count": FRAME_COUNT,
        "frame_size": FRAME_SIZE,
        "atlas_size": list(atlas.size),
        "layout": "8 columns × 6 rows, left to right, top to bottom",
        "duration_seconds": 4,
        "fps": 12,
        "alpha_range": list(alpha.getextrema()),
        "transparent_percent": round(histogram[0] / (atlas.width * atlas.height) * 100, 2),
        "partial_alpha_percent": round(sum(histogram[1:255]) / (atlas.width * atlas.height) * 100, 2),
        "minimum_safe_inset_px": min(min(box[0], box[1], FRAME_SIZE - box[2], FRAME_SIZE - box[3]) for box in bounds),
        "frame_bounds": bounds,
        "loop_seam_mean_rgba_difference": seam,
        "first_adjacent_mean_rgba_difference": adjacent,
    }
    (DESIGN / "motion-preview-metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    print(json.dumps(metrics, indent=2))


def build_scene():
    import bpy
    from mathutils import Vector

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.context.preferences.filepaths.save_version = 0
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.resolution_x = FRAME_SIZE
    scene.render.resolution_y = FRAME_SIZE
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = True
    scene.render.fps = 12
    scene.frame_start = 1
    scene.frame_end = FRAME_COUNT
    scene.world.color = (.18, .2, .22)
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = .7
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 8

    def material(name, color, metallic=0, roughness=.3, coat=.15):
        mat = bpy.data.materials.new(name)
        mat.diffuse_color = (*color, 1)
        mat.use_nodes = True
        mat.node_tree.nodes.clear()
        shader = mat.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
        shader.name = "Surface"
        output = mat.node_tree.nodes.new("ShaderNodeOutputMaterial")
        mat.node_tree.links.new(shader.outputs["BSDF"], output.inputs["Surface"])
        shader.inputs["Base Color"].default_value = (*color, 1)
        shader.inputs["Metallic"].default_value = metallic
        shader.inputs["Roughness"].default_value = roughness
        shader.inputs["Coat Weight"].default_value = coat
        return mat

    porcelain = material("Warm moon porcelain", (.92, .94, .88), roughness=.31)
    porcelain.node_tree.nodes.get("Surface").inputs["Subsurface Weight"].default_value = .065
    lime = material("Lime enamel", (.52, 1, .025), metallic=.05, roughness=.24, coat=.25)
    shader = lime.node_tree.nodes.get("Surface")
    shader.inputs["Emission Color"].default_value = (.44, 1, .01, 1)
    shader.inputs["Emission Strength"].default_value = .25
    graphite = material("Graphite titanium", (.05, .065, .07), metallic=.72, roughness=.23)
    eyes = material("Ink glass eyes", (.009, .016, .015), roughness=.22, coat=.35)
    inner = material("Inner ear pale mint", (.73, .83, .66), roughness=.5)

    def empty(name, parent=None):
        obj = bpy.data.objects.new(name, None)
        scene.collection.objects.link(obj)
        obj.parent = parent
        return obj

    bunny = empty("Xiaomeng floating root")

    def sphere(name, location, scale, surface, parent=bunny):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=32, location=location)
        obj = bpy.context.object
        obj.name = name
        obj.scale = scale
        obj.parent = parent
        obj.data.materials.append(surface)
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
        return obj

    sphere("Soft rounded body", (0, .06, -.28), (.60, .49, .66), porcelain)
    sphere("Big moon face", (0, 0, .55), (.85, .62, .73), porcelain)
    ear_left = empty("Left ear pivot", bunny)
    ear_left.location = (-.40, .04, 1.07)
    ear_right = empty("Right ear pivot", bunny)
    ear_right.location = (.39, .04, 1.07)
    for label, pivot in (("Left", ear_left), ("Right", ear_right)):
        sphere(f"{label} porcelain ear", (0, 0, .44), (.20, .17, .59), porcelain, pivot)
        sphere(f"{label} mint ear inset", (0, -.145, .46), (.085, .03, .33), inner, pivot)
    sphere("Left foot", (-.33, -.38, -.72), (.30, .34, .25), porcelain)
    sphere("Right foot", (.34, -.37, -.72), (.30, .34, .25), porcelain)
    left_eye = sphere("Left oval eye", (-.27, -.581, .62), (.075, .037, .105), eyes)
    right_eye = sphere("Right oval eye", (.27, -.581, .62), (.075, .037, .105), eyes)

    def tube(name, points, radius, surface, parent):
        curve = bpy.data.curves.new(name, "CURVE")
        curve.dimensions = "3D"
        curve.resolution_u = 20
        curve.bevel_depth = radius
        curve.bevel_resolution = 4
        spline = curve.splines.new("BEZIER")
        spline.bezier_points.add(len(points) - 1)
        for point, coordinate in zip(spline.bezier_points, points):
            point.co = coordinate
            point.handle_left_type = "AUTO"
            point.handle_right_type = "AUTO"
        obj = bpy.data.objects.new(name, curve)
        scene.collection.objects.link(obj)
        obj.parent = parent
        obj.data.materials.append(surface)
        return obj

    tube("Small happy smile", [(-.073, -.611, .405), (0, -.63, .375), (.073, -.611, .405)], .019, eyes, bunny)

    def star(name, radius, parent, location):
        vertices = []
        segments = 64
        profiles = ((.08, -.30), (.50, -.27), (.90, -.14), (1, 0), (.90, .14), (.50, .27), (.08, .30))
        for scale, depth in profiles:
            for index in range(segments):
                angle = index / segments * math.tau
                vertices.append((radius * math.cos(angle) ** 3 * scale, depth * radius, radius * math.sin(angle) ** 3 * scale))
        faces = [tuple(reversed(range(segments)))]
        for ring_index in range(len(profiles) - 1):
            offset = ring_index * segments
            faces += [(offset + i, offset + (i + 1) % segments, offset + (i + 1) % segments + segments, offset + i + segments) for i in range(segments)]
        faces.append(tuple(range((len(profiles) - 1) * segments, len(profiles) * segments)))
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(vertices, [], faces)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        scene.collection.objects.link(obj)
        obj.parent = parent
        obj.location = location
        obj.data.materials.append(lime)
        for polygon in mesh.polygons:
            polygon.use_smooth = True
        smooth = obj.modifiers.new("Soft inflated enamel", "SUBSURF")
        smooth.levels = 1
        return obj

    wish = star("Hugged four point wish", .59, bunny, (0, -.67, -.15))
    sphere("Left hug paw", (-.44, -.66, -.16), (.23, .23, .24), porcelain)
    sphere("Right hug paw", (.45, -.65, -.14), (.23, .23, .24), porcelain)
    orbit = empty("Tilted orbit plane")
    orbit.location.z = -.34
    orbit.rotation_euler = (.12, -.20, 0)
    bpy.ops.mesh.primitive_torus_add(major_radius=1.22, minor_radius=.022, major_segments=128, minor_segments=12)
    ring = bpy.context.object
    ring.name = "Fine graphite titanium orbit"
    ring.parent = orbit
    ring.data.materials.append(graphite)
    for polygon in ring.data.polygons:
        polygon.use_smooth = True
    satellite_root = empty("Orbiting satellites", orbit)
    sphere("Leading pearl satellite", (1.22, 0, 0), (.115, .115, .115), porcelain, satellite_root)
    sphere("Tiny lime satellite", (-1.22, 0, 0), (.055, .055, .055), lime, satellite_root)
    tiny_wish = star("Trailing little wish", .13, satellite_root, (.23, 1.20, .04))

    # Frame 49 duplicates frame 1 only as a seam anchor; the atlas contains 1–48.
    for frame in range(1, FRAME_COUNT + 2):
        phase = (frame - 1) / FRAME_COUNT * math.tau
        bunny.location.z = .04 * math.sin(phase)
        bunny.rotation_euler.z = .018 * math.sin(phase)
        bunny.keyframe_insert(data_path="location", frame=frame)
        bunny.keyframe_insert(data_path="rotation_euler", frame=frame)
        ear_left.rotation_euler.y = -.18 + .055 * math.sin(phase + .3)
        ear_right.rotation_euler.y = .18 + .045 * math.sin(phase - .3)
        ear_left.keyframe_insert(data_path="rotation_euler", frame=frame)
        ear_right.keyframe_insert(data_path="rotation_euler", frame=frame)
        blink = 1 - .88 * max(0, 1 - abs((frame - 1) - 29) / 1.6)
        for eye in (left_eye, right_eye):
            eye.scale.z = .105 * blink
            eye.keyframe_insert(data_path="scale", frame=frame)
        wish.rotation_euler.y = .06 * math.sin(phase)
        wish.rotation_euler.z = .035 * math.sin(phase)
        wish.keyframe_insert(data_path="rotation_euler", frame=frame)
        satellite_root.rotation_euler.z = phase
        satellite_root.keyframe_insert(data_path="rotation_euler", frame=frame)
        orbit.rotation_euler.x = .12 + .07 * math.sin(phase)
        orbit.rotation_euler.y = -.20 + .035 * math.cos(phase)
        orbit.keyframe_insert(data_path="rotation_euler", frame=frame)
        tiny_wish.rotation_euler.z = phase * 2
        tiny_wish.keyframe_insert(data_path="rotation_euler", frame=frame)

    bpy.ops.object.camera_add(location=(1.35, -7.5, 2.65))
    camera = bpy.context.object
    camera.name = "Portrait orthographic camera"
    camera.rotation_euler = (Vector((0, 0, .48)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 3.85
    scene.camera = camera

    for name, position, power, size, color in (
        ("Large silk key", (-3, -4, 6), 470, 4.5, (1, .97, .91)),
        ("Cool porcelain fill", (4, -1, 2.5), 180, 3.5, (.83, .91, 1)),
        ("Mint rim", (0, 3, 4), 450, 3, (.87, 1, .75)),
    ):
        bpy.ops.object.light_add(type="AREA", location=position)
        light = bpy.context.object
        light.name = name
        light.data.energy = power * 2.0
        light.data.shape = "DISK"
        light.data.size = size
        light.data.color = color
        light.rotation_euler = (Vector((0, 0, .4)) - light.location).to_track_quat("-Z", "Y").to_euler()

    scene.frame_set(1)
    scene.render.filepath = str(OUTPUT / "night-orbit-still.png")
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND))
    return scene


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--pack", type=Path)
    parser.add_argument("--pack-python", type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:])
    if args.pack:
        pack_frames(args.pack)
        return
    import bpy

    OUTPUT.mkdir(parents=True, exist_ok=True)
    DESIGN.mkdir(parents=True, exist_ok=True)
    scene = build_scene()
    if args.preview:
        bpy.ops.render.render(write_still=True)
        return
    if not args.pack_python:
        raise ValueError("Pass --pack-python with a Python executable that provides Pillow")
    with tempfile.TemporaryDirectory(prefix="xiaomeng-night-orbit-") as temp:
        frame_dir = Path(temp)
        for index in range(FRAME_COUNT):
            scene.frame_set(index + 1)
            scene.render.filepath = str(frame_dir / f"frame-{index:02d}.png")
            bpy.ops.render.render(write_still=True)
            print(f"NIGHT_ORBIT_FRAME {index + 1}/{FRAME_COUNT}", flush=True)
        subprocess.run([str(args.pack_python), str(Path(__file__).resolve()), "--pack", str(frame_dir)], check=True)


if __name__ == "__main__":
    main()

