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
SIZE = 256
FRAMES = 48
NAMES = ("project", "inbox", "archive")
BACKGROUNDS = ((17, 21, 27, 255), (233, 237, 223, 255), (233, 237, 223, 255))


def pack(directory, preview_only):
    from PIL import Image, ImageChops, ImageStat

    rows = []
    metrics = {}
    for scene_index, name in enumerate(NAMES):
        images = [Image.open(directory / f"{name}-{frame:02d}.png").convert("RGBA") for frame in range(1 if preview_only else FRAMES)]
        images[0].save(OUTPUT / f"{name}-intro-still.png", optimize=True)
        rows.append(images)
        if preview_only:
            continue
        atlas = Image.new("RGBA", (SIZE * 8, SIZE * 6))
        bounds = []
        for index, frame in enumerate(images):
            atlas.paste(frame, ((index % 8) * SIZE, (index // 8) * SIZE))
            bounds.append(frame.getchannel("A").getbbox())
        atlas.save(OUTPUT / f"{name}-intro-atlas.png", optimize=True)
        alpha = atlas.getchannel("A")
        histogram = alpha.histogram()
        metrics[name] = {
            "atlas_size": list(atlas.size),
            "frame_size": SIZE,
            "frames": FRAMES,
            "duration_seconds": 4,
            "fps": 12,
            "alpha_range": list(alpha.getextrema()),
            "transparent_percent": round(histogram[0] * 100 / (atlas.width * atlas.height), 2),
            "partial_alpha_percent": round(sum(histogram[1:255]) * 100 / (atlas.width * atlas.height), 2),
            "minimum_safe_inset_px": min(min(b[0], b[1], SIZE - b[2], SIZE - b[3]) for b in bounds),
            "loop_seam_mean_rgba_difference": ImageStat.Stat(ImageChops.difference(images[-1], images[0])).mean,
            "first_adjacent_mean_rgba_difference": ImageStat.Stat(ImageChops.difference(images[0], images[1])).mean,
            "bounds": bounds,
        }
    preview = []
    for frame in range(1 if preview_only else FRAMES):
        strip = Image.new("RGB", (SIZE * 3, SIZE))
        for scene_index, images in enumerate(rows):
            background = Image.new("RGBA", (SIZE, SIZE), BACKGROUNDS[scene_index])
            background.alpha_composite(images[frame])
            strip.paste(background.convert("RGB"), (scene_index * SIZE, 0))
        preview.append(strip)
    preview[0].save(DESIGN / "page-intro-preview.png", optimize=True)
    preview[0].resize((318, 106), Image.Resampling.LANCZOS).save(DESIGN / "page-intro-preview-106px.png", optimize=True)
    if preview_only:
        return
    preview[0].save(DESIGN / "page-intro-preview.gif", save_all=True, append_images=preview[1:], duration=[80, 80, 90] * 16, loop=0, disposal=2)
    contact = Image.new("RGB", (SIZE * 3, SIZE * 4))
    for index in range(4):
        contact.paste(preview[index * 12], (0, SIZE * index))
    contact.save(DESIGN / "page-intro-preview-contact.png", optimize=True)
    (DESIGN / "page-intro-preview-metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    print(json.dumps({name: {k: v for k, v in result.items() if k != "bounds"} for name, result in metrics.items()}, indent=2), flush=True)


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
    scene.render.fps = 12
    scene.frame_start = 1
    scene.frame_end = FRAMES
    scene.world.color = (.18, .21, .22)
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = .5
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 8

    def material(name, color, metallic=0, roughness=.3):
        value = bpy.data.materials.new(name)
        value.diffuse_color = (*color, 1)
        value.use_nodes = True
        value.node_tree.nodes.clear()
        shader = value.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
        shader.name = "Surface"
        output = value.node_tree.nodes.new("ShaderNodeOutputMaterial")
        value.node_tree.links.new(shader.outputs["BSDF"], output.inputs["Surface"])
        shader.inputs["Base Color"].default_value = (*color, 1)
        shader.inputs["Metallic"].default_value = metallic
        shader.inputs["Roughness"].default_value = roughness
        shader.inputs["Coat Weight"].default_value = .23
        return value

    porcelain = material("Warm porcelain", (.94, .96, .90))
    paper = material("Ivory paper", (.97, .98, .93), roughness=.46)
    lime = material("Lime enamel", (.53, .96, .035), roughness=.23)
    ink = material("Graphite titanium", (.035, .055, .05), metallic=.5)
    glass = material("Lime frosted collectible lid", (.64, .93, .19), roughness=.22)
    glass.node_tree.nodes["Surface"].inputs["Transmission Weight"].default_value = .16

    def empty(name, parent=None):
        obj = bpy.data.objects.new(name, None)
        scene.collection.objects.link(obj)
        obj.parent = parent
        return obj

    def box(name, position, dimensions, surface, parent, bevel=.08):
        bpy.ops.mesh.primitive_cube_add(size=1, location=position)
        obj = bpy.context.object
        obj.name = name
        obj.dimensions = dimensions
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        obj.parent = parent
        obj.data.materials.append(surface)
        modifier = obj.modifiers.new("Soft ceramic corners", "BEVEL")
        modifier.width = bevel
        modifier.segments = 5
        obj.modifiers.new("Soft normals", "WEIGHTED_NORMAL")
        return obj

    def sphere(name, position, radius, surface, parent):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=40, ring_count=24, radius=radius, location=position)
        obj = bpy.context.object
        obj.name = name
        obj.parent = parent
        obj.data.materials.append(surface)
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
        return obj

    def extrude(name, outline, depth, surface, parent, bevel=.06):
        count = len(outline)
        vertices = [(x, y, z) for y in (-depth / 2, depth / 2) for x, z in outline]
        faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
        faces += [(i, (i + 1) % count, (i + 1) % count + count, i + count) for i in range(count)]
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(vertices, [], faces)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        scene.collection.objects.link(obj)
        obj.parent = parent
        obj.data.materials.append(surface)
        modifier = obj.modifiers.new("Rounded object silhouette", "BEVEL")
        modifier.width = bevel
        modifier.segments = 5
        obj.modifiers.new("Soft normals", "WEIGHTED_NORMAL")
        return obj

    def star(name, radius, parent):
        points = []
        for index in range(10):
            angle = math.pi / 2 + index * math.tau / 10
            length = radius if index % 2 == 0 else radius * .49
            points.append((math.cos(angle) * length, math.sin(angle) * length))
        return extrude(name, points, radius * .35, lime, parent, radius * .10)

    roots = [empty("01 Project imagination"), empty("02 Inbox arrival"), empty("03 Archive treasures")]
    project, inbox, archive = roots
    back = extrude("Porcelain folder back", [(-.88, -.56), (.88, -.56), (.88, .42), (-.08, .42), (-.28, .66), (-.88, .66)], .15, porcelain, project, .09)
    back.location.y = .27
    front = extrude("Porcelain folder front", [(-.88, -.56), (.88, -.56), (.88, .22), (.16, .22), (-.10, .36), (-.88, .36)], .20, porcelain, project, .10)
    front.location.y = -.31
    front.rotation_euler.x = .10
    box("Folder bottom", (0, -.02, -.49), (1.70, .64, .13), porcelain, project)
    project_card = empty("Gently swaying project card", project)
    project_card.location = (-.36, .07, .16)
    box("Project idea card", (0, 0, 0), (.75, .08, .92), paper, project_card, .04)
    box("Card green marker", (-.05, -.06, .24), (.44, .025, .07), lime, project_card, .02)
    project_star = star("Rising project star", .49, project)
    project_star.location = (.18, -.035, .65)
    sphere("Project pearl", (.66, -.15, .30), .075, porcelain, project)

    shell_points = [(-.77, -.40), (-.77, .23)]
    shell_points += [(math.cos(math.pi - i * math.pi / 24) * .77, .23 + math.sin(math.pi - i * math.pi / 24) * .77) for i in range(25)]
    shell_points += [(.77, -.40), (.64, -.40), (.64, .23)]
    shell_points += [(math.cos(i * math.pi / 24) * .64, .23 + math.sin(i * math.pi / 24) * .64) for i in range(25)]
    shell_points += [(-.64, -.40)]
    shell = extrude("Arched porcelain mailbox shell", shell_points, .85, porcelain, inbox, .035)
    shell.location.y = .18
    rear_points = [(-.70, -.38), (.70, -.38)]
    rear_points += [(math.cos(i * math.pi / 24) * .70, .23 + math.sin(i * math.pi / 24) * .70) for i in range(25)]
    rear = extrude("Mailbox enclosed back", rear_points, .09, porcelain, inbox, .04)
    rear.location.y = .60
    box("Mailbox bottom", (0, .12, -.42), (1.48, .95, .16), porcelain, inbox)
    door = box("Folded mailbox door", (0, -.60, -.43), (1.42, .84, .15), porcelain, inbox, .14)
    box("Door inset", (0, -.60, -.345), (1.12, .56, .04), paper, inbox, .12)
    letter = empty("Floating incoming letter", inbox)
    letter.location = (0, -.52, .17)
    box("Lime letter body", (0, 0, 0), (1.02, .16, .70), lime, letter, .075)
    flap = empty("Opening envelope flap", letter)
    flap.location = (0, -.09, .28)
    extrude("Ivory envelope flap", [(-.46, 0), (.46, 0), (0, -.32)], .04, paper, flap, .025)
    letter_star = star("Letter star seal", .13, letter)
    letter_star.location = (0, -.106, -.02)
    orbit_beads = empty("Orbiting lime arrival signals", inbox)
    sphere("Bright signal pearl", (1.03, 0, .60), .085, lime, orbit_beads)
    sphere("Small signal pearl", (-.87, .1, .32), .055, lime, orbit_beads)

    box("Collection box base", (0, 0, -.49), (1.61, 1.22, .16), porcelain, archive, .11)
    box("Collection front wall", (0, -.54, -.14), (1.61, .18, .66), porcelain, archive, .10)
    box("Collection back wall", (0, .54, -.14), (1.61, .18, .66), porcelain, archive, .10)
    box("Collection left wall", (-.72, 0, -.14), (.18, 1.02, .66), porcelain, archive, .08)
    box("Collection right wall", (.72, 0, -.14), (.18, 1.02, .66), porcelain, archive, .08)
    box("Collection green clasp", (0, -.65, .10), (.35, .08, .14), lime, archive, .055)
    archive_lid = empty("Levitating keepsake lid", archive)
    box("Frosted lime lid", (0, 0, 0), (1.72, 1.33, .16), glass, archive_lid, .13)
    box("Lid inner rim", (0, 0, -.095), (1.42, 1.01, .055), lime, archive_lid, .07)
    archive_star = star("Collected star", .34, archive)
    archive_star.location = (-.30, -.13, .40)
    archive_pearl = sphere("Collected pearl", (.38, -.23, .32), .15, porcelain, archive)
    satellite = sphere("Tiny collected wish", (.65, -.18, .63), .055, lime, archive)

    # The duplicate pose at frame 49 closes the curve without a repeated atlas frame.
    for frame in range(1, FRAMES + 2):
        phase = (frame - 1) / FRAMES * math.tau
        project_star.location.z = .67 + .105 * math.sin(phase)
        project_star.rotation_euler = (.04 * math.sin(phase), .13 * math.sin(phase), .22 * math.sin(phase + .3))
        project_star.keyframe_insert(data_path="location", frame=frame)
        project_star.keyframe_insert(data_path="rotation_euler", frame=frame)
        project_card.rotation_euler.y = -.14 + .07 * math.sin(phase + .4)
        project_card.location.z = .17 + .025 * math.sin(phase)
        project_card.keyframe_insert(data_path="location", frame=frame)
        project_card.keyframe_insert(data_path="rotation_euler", frame=frame)
        letter.location.z = .16 + .085 * math.sin(phase)
        letter.rotation_euler.y = .06 * math.sin(phase)
        letter.keyframe_insert(data_path="location", frame=frame)
        letter.keyframe_insert(data_path="rotation_euler", frame=frame)
        flap.rotation_euler.x = .95 + .48 * (1 - math.cos(phase))
        flap.keyframe_insert(data_path="rotation_euler", frame=frame)
        orbit_beads.rotation_euler.z = phase
        orbit_beads.keyframe_insert(data_path="rotation_euler", frame=frame)
        archive_lid.location = (0, .24, .88 + .075 * math.sin(phase))
        archive_lid.rotation_euler.x = -.25 - .05 * math.sin(phase)
        archive_lid.rotation_euler.y = -.04 * math.cos(phase)
        archive_lid.keyframe_insert(data_path="location", frame=frame)
        archive_lid.keyframe_insert(data_path="rotation_euler", frame=frame)
        archive_star.location.z = .39 + .07 * math.sin(phase + .3)
        archive_star.rotation_euler.y = .13 * math.sin(phase)
        archive_star.rotation_euler.z = -.10 + .17 * math.sin(phase)
        archive_star.keyframe_insert(data_path="location", frame=frame)
        archive_star.keyframe_insert(data_path="rotation_euler", frame=frame)
        archive_pearl.location.z = .33 + .06 * math.sin(phase + 1)
        archive_pearl.keyframe_insert(data_path="location", frame=frame)
        satellite.location.z = .57 + .065 * math.sin(phase + 2)
        satellite.keyframe_insert(data_path="location", frame=frame)

    bpy.ops.object.camera_add(location=(2.5, -6, 3.2))
    camera = bpy.context.object
    camera.name = "Page illustration orthographic camera"
    camera.rotation_euler = (Vector((0, 0, .28)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 2.64
    scene.camera = camera
    for name, position, power, size, color in (
        ("Warm key", (-3, -4, 6), 850, 4.5, (1, .98, .93)),
        ("Cool fill", (4, -2, 3), 350, 3, (.83, .91, 1)),
        ("Mint rim", (0, 3, 4), 750, 3, (.90, 1, .78)),
    ):
        bpy.ops.object.light_add(type="AREA", location=position)
        light = bpy.context.object
        light.name = name
        light.data.energy = power
        light.data.shape = "DISK"
        light.data.size = size
        light.data.color = color
        light.rotation_euler = (Vector((0, 0, .3)) - light.location).to_track_quat("-Z", "Y").to_euler()
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
    with tempfile.TemporaryDirectory(prefix="xiaomeng-page-intro-") as directory:
        for index, root in enumerate(roots):
            for other in roots:
                for obj in [other, *other.children_recursive]:
                    obj.hide_render = other != root
            root.location.x = 0
            for frame in range(1 if args.preview else FRAMES):
                scene.frame_set(frame + 1)
                scene.render.filepath = str(Path(directory) / f"{NAMES[index]}-{frame:02d}.png")
                bpy.ops.render.render(write_still=True)
                print(f"PAGE_INTRO {NAMES[index]} {frame + 1}/{1 if args.preview else FRAMES}", flush=True)
        command = [str(args.pack_python), str(Path(__file__).resolve()), "--pack", directory]
        if args.preview:
            command.append("--preview")
        subprocess.run(command, check=True)


if __name__ == "__main__":
    main()
