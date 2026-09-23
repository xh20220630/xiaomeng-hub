import math
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "app" / "assets" / "motion"
OUTPUT.mkdir(parents=True, exist_ok=True)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 48
scene.cycles.use_denoising = True
scene.render.resolution_x = 768
scene.render.resolution_y = 768
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.film_transparent = True
scene.render.fps = 24
scene.frame_start = 1
scene.frame_end = 48
scene.world.color = (0.35, 0.3, 0.32)
scene.view_settings.view_transform = "AgX"


def material(name, color, metallic=0.0, roughness=0.3):
    value = bpy.data.materials.new(name)
    value.use_nodes = True
    value.node_tree.nodes.clear()
    shader = value.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    output = value.node_tree.nodes.new("ShaderNodeOutputMaterial")
    value.node_tree.links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    return value


champagne = material("Champagne enamel", (0.83, 0.59, 0.27), 0.42, 0.25)
blush = material("Rose quartz", (0.94, 0.52, 0.68), 0.12, 0.29)
pearl = material("Warm porcelain", (0.93, 0.82, 0.8), 0.14, 0.22)

orbit = bpy.data.objects.new("Dream orbit", None)
scene.collection.objects.link(orbit)
bpy.ops.mesh.primitive_torus_add(major_radius=2.22, minor_radius=0.018)
ring = bpy.context.object
ring.name = "Fine champagne orbit"
ring.parent = orbit
ring.data.materials.append(champagne)


def star(name, location, radius, rotation):
    points = []
    for index in range(8):
        angle = index * math.pi / 4
        length = radius if index % 2 == 0 else radius * 0.3
        points.append((math.cos(angle) * length, math.sin(angle) * length, 0))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(points, [], [tuple(range(8))])
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = rotation
    obj.parent = orbit
    obj.data.materials.append(champagne)
    solid = obj.modifiers.new("Enamel depth", "SOLIDIFY")
    solid.thickness = radius * 0.2
    bevel = obj.modifiers.new("Soft jewellery edge", "BEVEL")
    bevel.width = radius * 0.06
    bevel.segments = 4
    obj.modifiers.new("Polished normals", "WEIGHTED_NORMAL")


star("Large wish", (-1.85, -1.1, 0.13), 0.34, (0.6, 0.1, 0.1))
star("Small wish", (1.76, 1.3, 0.05), 0.21, (0.45, -0.2, 0.7))
star("Distant wish", (0.95, -2.0, 0.0), 0.13, (0.3, 0.2, 0.3))
for name, position, radius, surface in (
    ("Rose pearl", (1.83, -1.26, 0.05), 0.13, blush),
    ("Quiet pearl", (-1.9, 1.0, 0.08), 0.09, pearl),
):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=40, ring_count=24, radius=radius, location=position)
    obj = bpy.context.object
    obj.name = name
    obj.parent = orbit
    obj.data.materials.append(surface)
    for poly in obj.data.polygons:
        poly.use_smooth = True

for frame, angle, height in ((1, -0.08, -0.04), (24, 0.04, 0.04), (48, -0.08, -0.04)):
    orbit.rotation_euler.z = angle
    orbit.location.z = height
    orbit.keyframe_insert(data_path="rotation_euler", frame=frame)
    orbit.keyframe_insert(data_path="location", frame=frame)

bpy.ops.object.camera_add(location=(5, -7.4, 7.8))
camera = bpy.context.object
camera.name = "UI orthographic camera"
camera.rotation_euler = (Vector((0, 0, 0)) - camera.location).to_track_quat("-Z", "Y").to_euler()
camera.data.type = "ORTHO"
camera.data.ortho_scale = 5.35
scene.camera = camera

for name, position, energy, size, color in (
    ("Silk key", (0, -3, 7), 800, 5, (1.0, 0.89, 0.85)),
    ("Pearl fill", (5, 3, 5), 650, 4, (0.89, 0.93, 1.0)),
    ("Soft rim", (-5, 1, 4), 900, 3, (1.0, 0.77, 0.84)),
):
    bpy.ops.object.light_add(type="AREA", location=position)
    light = bpy.context.object
    light.name = name
    light.data.energy = energy
    light.data.shape = "DISK"
    light.data.size = size
    light.data.color = color
    light.rotation_euler = (-light.location).to_track_quat("-Z", "Y").to_euler()

scene.frame_set(24)
scene.render.filepath = str(OUTPUT / "dream-orbit.png")
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / "scripts" / "design" / "motion-star-orbit.blend"))
bpy.ops.render.render(write_still=True)
