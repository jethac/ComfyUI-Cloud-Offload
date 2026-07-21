"""Cloud Offload nodes: whole-workflow cloud runs and coordinator status."""

from __future__ import annotations

import base64
import io
import json
from typing import Any, Dict, Optional

import numpy as np
from PIL import Image

try:
    from .client import CloudOffloadError, client
except ImportError:
    from client import CloudOffloadError, client


def _image_to_b64(image) -> str:
    img_np = (image[0].cpu().numpy() * 255).astype(np.uint8)
    pil_image = Image.fromarray(img_np)
    buffer = io.BytesIO()
    pil_image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _decode_image_tensor(value: Optional[str]):
    if not value:
        return None
    import torch

    image = Image.open(io.BytesIO(base64.b64decode(value))).convert("RGB")
    data = np.array(image).astype(np.float32) / 255.0
    return torch.from_numpy(data).unsqueeze(0)


class CloudStatus:
    """Return Cloud Offload queue, worker, and provider balance status as JSON."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("status_json",)
    FUNCTION = "status"
    CATEGORY = "Cloud Offload"

    def status(self):
        return (json.dumps(client.status(), indent=2, sort_keys=True),)


class CloudWorkflow:
    """Execute an API-format ComfyUI workflow on a Cloud Offload runner."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "workflow_api_json": (
                    "STRING",
                    {"multiline": True, "default": "{}"},
                ),
                "provider": (client.provider_names(), {"default": "auto"}),
                "input_filename": (
                    "STRING",
                    {"default": "cloud_input.png"},
                ),
                "timeout_seconds": (
                    "INT",
                    {"default": 3600, "min": 1, "max": 86400, "step": 60},
                ),
            },
            "optional": {"image": ("IMAGE",)},
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("first_image", "result_json")
    FUNCTION = "execute"
    CATEGORY = "Cloud Offload"

    def execute(
        self,
        workflow_api_json: str,
        provider: str = "auto",
        input_filename: str = "cloud_input.png",
        timeout_seconds: int = 3600,
        image=None,
    ):
        try:
            workflow = json.loads(workflow_api_json)
        except json.JSONDecodeError as exc:
            raise CloudOffloadError(f"Invalid API workflow JSON: {exc}") from exc
        if not isinstance(workflow, dict) or not workflow:
            raise CloudOffloadError("API workflow JSON must be a non-empty object")
        inputs = {input_filename: _image_to_b64(image)} if image is not None else {}
        result = client.run_comfyui_workflow(
            {
                "workflow": workflow,
                "inputs": inputs,
                "provider": provider,
                "timeout_seconds": int(timeout_seconds),
            }
        )
        images = result.get("images") or []
        first_image = _decode_image_tensor(images[0].get("data")) if images else None
        if first_image is None:
            import torch

            first_image = torch.zeros((1, 1, 1, 3), dtype=torch.float32)
        return (first_image, json.dumps(result, indent=2, sort_keys=True))


NODE_CLASS_MAPPINGS: Dict[str, Any] = {
    "CloudStatus": CloudStatus,
    "CloudWorkflow": CloudWorkflow,
}

NODE_DISPLAY_NAME_MAPPINGS: Dict[str, str] = {
    "CloudStatus": "Cloud Status",
    "CloudWorkflow": "Cloud Workflow",
}
