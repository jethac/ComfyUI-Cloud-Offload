"""
ComfyUI-Kao: Kao nodes for ComfyUI
"""

import numpy as np
from PIL import Image
from typing import Optional

# Try importing kao - guide user if not installed
try:
    from kao import KaoRuntime
    from kao.models import list_models
    KAO_AVAILABLE = True
except ImportError:
    KAO_AVAILABLE = False
    print("[ComfyUI-Kao] Kao not installed. Run: pip install kao")


# Shared runtime
_runtime = None


def get_runtime():
    global _runtime
    if not KAO_AVAILABLE:
        raise RuntimeError("Kao not installed. Run: pip install kao")
    if _runtime is None:
        _runtime = KaoRuntime()
    return _runtime


def get_model_list():
    if KAO_AVAILABLE:
        return list_models()
    return ["kao-not-installed"]


class KaoLoadModel:
    """Load a Kao model into VRAM."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model_name": (get_model_list(),),
            },
        }

    RETURN_TYPES = ("KAO_MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "load"
    CATEGORY = "Kao"

    def load(self, model_name: str):
        runtime = get_runtime()
        runtime.load(model_name)
        return (model_name,)


class KaoImageTo3D:
    """Generate 3D mesh from a single image using Kao."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "model": ("KAO_MODEL",),
            },
            "optional": {
                "steps": ("INT", {"default": 30, "min": 1, "max": 100}),
                "guidance_scale": ("FLOAT", {"default": 5.0, "min": 1.0, "max": 20.0, "step": 0.1}),
                "seed": ("INT", {"default": -1, "min": -1, "max": 2147483647}),
                "octree_resolution": (["256", "384", "512"], {"default": "256"}),
                "remove_background": ("BOOLEAN", {"default": True}),
                "generate_texture": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("KAO_MESH", "INT")
    RETURN_NAMES = ("mesh", "seed")
    FUNCTION = "generate"
    CATEGORY = "Kao"

    def generate(
        self,
        image,
        model: str,
        steps: int = 30,
        guidance_scale: float = 5.0,
        seed: int = -1,
        octree_resolution: str = "256",
        remove_background: bool = True,
        generate_texture: bool = False,
    ):
        runtime = get_runtime()

        if runtime.loaded_model != model:
            runtime.load(model)

        # ComfyUI image: [B, H, W, C] tensor in 0-1
        img_np = (image[0].cpu().numpy() * 255).astype(np.uint8)
        pil_image = Image.fromarray(img_np)

        result = runtime.generate(
            image=pil_image,
            steps=steps,
            guidance_scale=guidance_scale,
            seed=seed,
            octree_resolution=int(octree_resolution),
            remove_background=remove_background,
            generate_texture=generate_texture,
        )

        return (result.mesh, result.seed)


class KaoMultiViewTo3D:
    """Generate 3D mesh from front/left/back views."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "front": ("IMAGE",),
                "left": ("IMAGE",),
                "back": ("IMAGE",),
            },
            "optional": {
                "steps": ("INT", {"default": 30, "min": 1, "max": 100}),
                "seed": ("INT", {"default": -1, "min": -1, "max": 2147483647}),
                "octree_resolution": (["256", "380", "512"], {"default": "380"}),
                "remove_background": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("KAO_MESH", "INT")
    RETURN_NAMES = ("mesh", "seed")
    FUNCTION = "generate"
    CATEGORY = "Kao"

    def generate(
        self,
        front, left, back,
        steps: int = 30,
        seed: int = -1,
        octree_resolution: str = "380",
        remove_background: bool = True,
    ):
        runtime = get_runtime()

        if runtime.loaded_model != "hunyuan3d-2mv":
            runtime.load("hunyuan3d-2mv")

        def to_pil(img):
            return Image.fromarray((img[0].cpu().numpy() * 255).astype(np.uint8))

        result = runtime.generate(
            images={
                "front": to_pil(front),
                "left": to_pil(left),
                "back": to_pil(back),
            },
            steps=steps,
            seed=seed,
            octree_resolution=int(octree_resolution),
            remove_background=remove_background,
        )

        return (result.mesh, result.seed)


class KaoImageToScene:
    """Reconstruct 3D scene from image (WorldMirror)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
            },
            "optional": {
                "output_depth": ("BOOLEAN", {"default": True}),
                "output_normals": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("KAO_POINTCLOUD", "IMAGE", "IMAGE")
    RETURN_NAMES = ("pointcloud", "depth", "normals")
    FUNCTION = "generate"
    CATEGORY = "Kao"

    def generate(
        self,
        image,
        output_depth: bool = True,
        output_normals: bool = False,
    ):
        import torch

        runtime = get_runtime()

        if runtime.loaded_model != "world-mirror":
            runtime.load("world-mirror")

        img_np = (image[0].cpu().numpy() * 255).astype(np.uint8)
        pil_image = Image.fromarray(img_np)

        output_types = ["pointcloud"]
        if output_depth:
            output_types.append("depth")
        if output_normals:
            output_types.append("normals")

        result = runtime.generate(image=pil_image, output_types=output_types)

        # Convert to ComfyUI formats
        pointcloud = result.pointcloud

        depth = None
        if result.depth:
            d = np.array(result.depth.convert("RGB")).astype(np.float32) / 255.0
            depth = torch.from_numpy(d).unsqueeze(0)

        normals = None
        if result.normals:
            n = np.array(result.normals.convert("RGB")).astype(np.float32) / 255.0
            normals = torch.from_numpy(n).unsqueeze(0)

        return (pointcloud, depth, normals)


class KaoSaveMesh:
    """Save Kao mesh to file."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mesh": ("KAO_MESH",),
                "filename": ("STRING", {"default": "kao_output"}),
                "format": (["glb", "obj", "ply", "stl"],),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("filepath",)
    FUNCTION = "save"
    CATEGORY = "Kao"
    OUTPUT_NODE = True

    def save(self, mesh, filename: str, format: str = "glb"):
        import folder_paths
        output_dir = folder_paths.get_output_directory()
        filepath = f"{output_dir}/{filename}.{format}"
        mesh.export(filepath)
        return (filepath,)


class KaoMeshPreview:
    """Preview mesh stats (no 3D viewer yet)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mesh": ("KAO_MESH",),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("info",)
    FUNCTION = "preview"
    CATEGORY = "Kao"

    def preview(self, mesh):
        info = f"Vertices: {len(mesh.vertices)}\nFaces: {len(mesh.faces)}"
        if hasattr(mesh, 'visual') and mesh.visual is not None:
            info += f"\nTextured: {mesh.visual.kind == 'texture'}"
        return (info,)


# Node mappings for ComfyUI
NODE_CLASS_MAPPINGS = {
    "KaoLoadModel": KaoLoadModel,
    "KaoImageTo3D": KaoImageTo3D,
    "KaoMultiViewTo3D": KaoMultiViewTo3D,
    "KaoImageToScene": KaoImageToScene,
    "KaoSaveMesh": KaoSaveMesh,
    "KaoMeshPreview": KaoMeshPreview,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "KaoLoadModel": "Kao Load Model",
    "KaoImageTo3D": "Kao Image → 3D",
    "KaoMultiViewTo3D": "Kao Multi-View → 3D",
    "KaoImageToScene": "Kao Image → Scene",
    "KaoSaveMesh": "Kao Save Mesh",
    "KaoMeshPreview": "Kao Mesh Preview",
}
