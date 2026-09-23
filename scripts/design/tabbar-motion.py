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
SIZE = 128
FRAMES = 16
NAMES = ("conversation", "projects", "inbox", "archive")


def pack(directory, preview_only):
    from PIL import Image, ImageChops, ImageStat

    still = Image.new("RGBA", (SIZE * 4, SIZE * 2))
    atlas = Image.new("RGBA", (SIZE * 8, SIZE * 8))
    bounds = []
    seam = []
    small_difference = []
    rows = []
    for icon in range(4):
        images = [Image.open(directory / f"icon-{icon}-{frame:02d}.png").convert("RGBA") for frame in ([0, FRAMES - 1] if preview_only else range(FRAMES))]
        still.paste(images[0], (icon * SIZE, 0))
        still.paste(images[-1], (icon * SIZE, SIZE))
        rows.append(images)
        for frame, image in enumerate(images):
            index = icon * FRAMES + frame
            atlas.paste(image, ((index % 8) * SIZE, (index // 8) * SIZE))
            bounds.append(image.getchannel("A").getbbox())
        seam.append(ImageStat.Stat(ImageChops.difference(images[0], images[-1])).mean)
        small_difference.append(ImageStat.Stat(ImageChops.difference(images[0].resize((48, 48), Image.Resampling.LANCZOS), images[-1].resize((48, 48), Image.Resampling.LANCZOS))).mean)
    still.save(OUTPUT / "tabbar-still.png", optimize=True)
    light = Image.new("RGBA", still.size, (245, 246, 242, 255))
    light.alpha_composite(still)
    light.convert("RGB").resize((1024, 512), Image.Resampling.LANCZOS).save(DESIGN / "tabbar-preview.png")
    light.convert("RGB").resize((192, 96), Image.Resampling.LANCZOS).save(DESIGN / "tabbar-preview-48px.png")
    if preview_only:
        return
    atlas.save(OUTPUT / "tabbar-atlas.png", optimize=True)
    gifs = []
    for frame in range(FRAMES):
        image = Image.new("RGBA", (SIZE * 4, SIZE), (245, 246, 242, 255))
        for icon in range(4):
            image.alpha_composite(rows[icon][frame], (icon * SIZE, 0))
        gifs.append(image.convert("RGB").resize((1024, 256), Image.Resampling.LANCZOS))
    sequence = gifs + list(reversed(gifs[1:-1]))
    durations = [900] + [50] * 14 + [1100] + [50] * 14
    sequence[0].save(DESIGN / "tabbar-preview.gif", save_all=True, append_images=sequence[1:], duration=durations, loop=0, disposal=2)
    histogram = atlas.getchannel("A").histogram()
    metrics = {
        "icon_order": NAMES,
        "frames_per_icon": FRAMES,
        "frame_size": [SIZE, SIZE],
        "atlas_size": list(atlas.size),
        "layout": "8 columns, 8 rows; each icon occupies 16 consecutive frames",
        "recommended_click_duration_ms": 700,
        "still_size": list(still.size),
        "still_rows": ["idle frame 0", "selected frame 15"],
        "playback": "Play forward to select, hold frame 15; reverse to deselect",
        "alpha_range": list(atlas.getchannel("A").getextrema()),
        "transparent_percent": round(histogram[0] * 100 / (1024 * 1024), 2),
        "partial_alpha_percent": round(sum(histogram[1:255]) * 100 / (1024 * 1024), 2),
        "minimum_safe_inset_px": min(min(b[0], b[1], SIZE - b[2], SIZE - b[3]) for b in bounds),
        "first_last_difference_by_icon_rgba": seam,
        "first_last_difference_at_48px_rgba": small_difference,
        "bounds": bounds,
    }
    (DESIGN / "tabbar-preview-metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in metrics.items() if k != "bounds"}, indent=2), flush=True)


def build():
    import bpy
    from mathutils import Vector

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.context.preferences.filepaths.save_version = 0
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.render.resolution_x = SIZE
    scene.render.resolution_y = SIZE
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = True
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = FRAMES
    scene.world.color = (.2, .22, .24)
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = .5
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 8

    def material(name, color, metal=0, roughness=.3):
        value = bpy.data.materials.new(name)
        value.diffuse_color = (*color, 1)
        value.use_nodes = True
        value.node_tree.nodes.clear()
        shader = value.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
        output = value.node_tree.nodes.new("ShaderNodeOutputMaterial")
        value.node_tree.links.new(shader.outputs["BSDF"], output.inputs["Surface"])
        shader.inputs["Base Color"].default_value = (*color, 1)
        shader.inputs["Metallic"].default_value = metal
        shader.inputs["Roughness"].default_value = roughness
        shader.inputs["Coat Weight"].default_value = .22
        return value

    white = material("Moon porcelain", (.94, .96, .90))
    lime = material("Lime enamel", (.55, .95, .06), roughness=.24)
    ink = material("Deep graphite", (.025, .042, .039), metal=.25)
    paper = material("Paper ivory", (.97, .98, .94), roughness=.48)
    speech_surface = material("Selected conversation enamel", (.94, .96, .90))
    speech_dots = material("Conversation dot accents", (.55, .95, .06))
    folder_surface = material("Selected folder enamel", (.94, .96, .90))
    roots = []

    def empty(name, parent=None):
        obj = bpy.data.objects.new(name, None)
        scene.collection.objects.link(obj)
        obj.parent = parent
        return obj

    def box(name, position, dimensions, surface, parent, bevel=.09):
        bpy.ops.mesh.primitive_cube_add(size=1, location=position)
        obj = bpy.context.object
        obj.name = name
        obj.dimensions = dimensions
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        obj.parent = parent
        obj.data.materials.append(surface)
        modifier = obj.modifiers.new("Rounded edges", "BEVEL")
        modifier.width = bevel
        modifier.segments = 5
        obj.modifiers.new("Porcelain normals", "WEIGHTED_NORMAL")
        return obj

    def sphere(name, position, scale, surface, parent):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=20, location=position)
        obj = bpy.context.object
        obj.name = name
        obj.scale = scale
        obj.parent = parent
        obj.data.materials.append(surface)
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
        return obj

    def tube(name, points, radius, surface, parent):
        curve = bpy.data.curves.new(name, "CURVE")
        curve.dimensions = "3D"
        curve.bevel_depth = radius
        curve.bevel_resolution = 3
        spline = curve.splines.new("POLY")
        spline.points.add(len(points) - 1)
        for point, coordinate in zip(spline.points, points):
            point.co = (*coordinate, 1)
        obj = bpy.data.objects.new(name, curve)
        scene.collection.objects.link(obj)
        obj.parent = parent
        obj.data.materials.append(surface)
        return obj

    conversation = empty("01 Conversation")
    roots.append(conversation)
    box("Soft speech bubble", (0, 0, .08), (1.60, .43, 1.08), speech_surface, conversation, .24)
    tail = box("Conversation tail", (-.43, .01, -.47), (.32, .30, .38), speech_surface, conversation, .09)
    tail.rotation_euler.y = -.40
    dots = [sphere(f"Message dot {i + 1}", (-.38 + i * .38, -.246, .10), (.115, .075, .115), speech_dots, conversation) for i in range(3)]

    folder = empty("02 Projects")
    roots.append(folder)
    box("Folder back", (0, .23, .02), (1.62, .16, 1.16), lime, folder, .11)
    box("Folder tab", (-.42, .23, .62), (.70, .16, .24), lime, folder, .08)
    card = empty("Floating project card", folder)
    box("Project paper", (0, .05, .12), (1.22, .08, .93), paper, card, .055)
    box("Project stripe", (-.18, -.008, .39), (.57, .025, .085), lime, card, .025)
    box("Project subtitle", (-.26, -.008, .22), (.42, .025, .05), ink, card, .015)
    cover = empty("Folder opening hinge", folder)
    cover.location = (0, -.19, -.55)
    box("Folder front cover", (0, 0, .44), (1.65, .17, .92), folder_surface, cover, .11)
    box("Folder marker", (.47, -.099, .55), (.22, .026, .11), lime, cover, .03)

    inbox = empty("03 Inbox")
    roots.append(inbox)
    box("Inbox tray base", (0, 0, -.47), (1.64, 1.03, .24), lime, inbox, .11)
    box("Inbox left wall", (-.73, 0, -.20), (.18, 1.02, .50), white, inbox, .07)
    box("Inbox right wall", (.73, 0, -.20), (.18, 1.02, .50), white, inbox, .07)
    box("Inbox rear wall", (0, .43, -.20), (1.48, .18, .50), white, inbox, .07)
    box("Inbox front lip", (0, -.45, -.35), (1.51, .17, .20), white, inbox, .06)
    envelope = empty("Incoming letter", inbox)
    envelope.location = (0, -.04, .15)
    box("Lime envelope", (0, 0, 0), (1.16, .17, .78), lime, envelope, .075)
    tube("Envelope folded flap", [(-.49, -.096, .26), (0, -.112, -.035), (.49, -.096, .26)], .025, white, envelope)

    archive = empty("04 Archive")
    roots.append(archive)
    box("Archive box", (0, 0, -.13), (1.47, 1.03, .96), white, archive, .13)
    box("Archive label recess", (0, -.530, -.12), (.48, .03, .18), ink, archive, .06)
    box("Archive label insert", (0, -.550, -.12), (.28, .025, .035), lime, archive, .014)
    lid = empty("Opening archive lid", archive)
    lid.location = (0, 0, .44)
    box("Lime archive lid", (0, 0, 0), (1.65, 1.16, .22), lime, lid, .095)
    box("Lid inset seam", (0, 0, -.11), (1.35, .87, .075), ink, lid, .055)

    for frame in range(1, FRAMES + 1):
        progress = (frame - 1) / (FRAMES - 1)
        selected = progress * progress * (3 - 2 * progress)
        settle = math.sin(math.pi * progress) ** 2
        conversation.rotation_euler.z = .38 * selected
        conversation.location.z = .10 * selected + .035 * settle
        conversation.scale = (1 + .045 * selected,) * 3
        conversation.keyframe_insert(data_path="rotation_euler", frame=frame)
        conversation.keyframe_insert(data_path="location", frame=frame)
        conversation.keyframe_insert(data_path="scale", frame=frame)
        for index, dot in enumerate(dots):
            delayed = min(1, max(0, (progress - index * .07) / .8))
            lift = delayed * delayed * (3 - 2 * delayed)
            dot.location.z = .10 + .15 * lift
            dot.location.x = (-.38 + index * .38) * (1 + .12 * selected)
            dot.scale = (.115 * (1 + .2 * lift), .075, .115 * (1 + .2 * lift))
            dot.keyframe_insert(data_path="location", frame=frame)
            dot.keyframe_insert(data_path="scale", frame=frame)
        for surface, idle, active in (
            (speech_surface, (.94, .96, .90), (.55, .95, .06)),
            (speech_dots, (.55, .95, .06), (.025, .042, .039)),
            (folder_surface, (.94, .96, .90), (.55, .95, .06)),
        ):
            shader = next(node for node in surface.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
            color = shader.inputs["Base Color"]
            color.default_value = (*(idle[channel] * (1 - selected) + active[channel] * selected for channel in range(3)), 1)
            color.keyframe_insert(data_path="default_value", frame=frame)
        cover.rotation_euler.x = .03 + .57 * selected
        cover.keyframe_insert(data_path="rotation_euler", frame=frame)
        card.location.z = -.17 + .48 * selected
        card.rotation_euler.y = -.10 * selected
        card.keyframe_insert(data_path="location", frame=frame)
        card.keyframe_insert(data_path="rotation_euler", frame=frame)
        envelope.location.z = -.04 + .60 * selected
        envelope.rotation_euler.y = -.16 * selected
        envelope.keyframe_insert(data_path="location", frame=frame)
        envelope.keyframe_insert(data_path="rotation_euler", frame=frame)
        lid.location.z = .44 + .48 * selected
        lid.rotation_euler.x = -.24 * selected
        lid.keyframe_insert(data_path="location", frame=frame)
        lid.keyframe_insert(data_path="rotation_euler", frame=frame)

    bpy.ops.object.camera_add(location=(2.7, -6, 3.8))
    camera = bpy.context.object
    camera.name = "Navigation orthographic camera"
    camera.rotation_euler = (Vector((0, 0, .04)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 2.65
    scene.camera = camera
    for name, position, power, size, color in (
        ("Silkbox key", (-3, -4, 6), 780, 4.5, (1, .98, .93)),
        ("Blue soft fill", (4, -2, 2.5), 360, 3, (.83, .91, 1)),
        ("Lime rim", (0, 3, 4), 700, 3, (.9, 1, .78)),
    ):
        bpy.ops.object.light_add(type="AREA", location=position)
        light = bpy.context.object
        light.name = name
        light.data.energy = power
        light.data.shape = "DISK"
        light.data.size = size
        light.data.color = color
        light.rotation_euler = (-light.location).to_track_quat("-Z", "Y").to_euler()

    scene.frame_set(1)
    for index, root in enumerate(roots):
        root.location.x = index * 4
    bpy.ops.wm.save_as_mainfile(filepath=str(Path(__file__).with_suffix(".blend")))
    return scene, roots


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--pack", type=Path)
    parser.add_argument("--pack-python", type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:])
    OUTPUT.mkdir(parents=True, exist_ok=True)
    DESIGN.mkdir(parents=True, exist_ok=True)
    if args.pack:
        pack(args.pack, args.preview)
        return
    import bpy

    scene, roots = build()
    with tempfile.TemporaryDirectory(prefix="xiaomeng-tabbar-") as directory:
        for icon, root in enumerate(roots):
            for other in roots:
                for obj in [other, *other.children_recursive]:
                    obj.hide_render = other != root
            for frame in ([0, FRAMES - 1] if args.preview else range(FRAMES)):
                scene.frame_set(frame + 1)
                root.location.x = 0
                scene.render.filepath = str(Path(directory) / f"icon-{icon}-{frame:02d}.png")
                bpy.ops.render.render(write_still=True)
                print(f"TABBAR {icon + 1}/4 FRAME {frame + 1}/{FRAMES}", flush=True)
        command = [str(args.pack_python), str(Path(__file__).resolve()), "--pack", directory]
        if args.preview:
            command.append("--preview")
        subprocess.run(command, check=True)


if __name__ == "__main__":
    main()
