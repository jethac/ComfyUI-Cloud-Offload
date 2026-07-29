"""Cloud Offload nodes: whole-workflow cloud runs and coordinator status."""

from __future__ import annotations

import base64
import io
import json
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, Optional

import numpy as np
from PIL import Image

try:
    from .client import CloudOffloadError, client
    from .confirmation import ConfirmationError, confirmation_broker
except ImportError:
    from client import CloudOffloadError, client
    from confirmation import ConfirmationError, confirmation_broker


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


def _decode_image_bytes(value: bytes):
    import torch

    image = Image.open(io.BytesIO(value)).convert("RGB")
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
        try:
            from comfy.utils import ProgressBar
            from server import PromptServer
        except ImportError:  # pragma: no cover - only possible outside ComfyUI
            ProgressBar = None
            PromptServer = None
        progress_bar = ProgressBar(100) if ProgressBar is not None else None
        cancellation_event = threading.Event()

        def report(event: dict[str, Any]) -> None:
            overall = event.get("overall_progress")
            if progress_bar is not None and overall is not None:
                progress_bar.update_absolute(max(0, min(100, int(overall))), 100)
            if PromptServer is not None:
                server = PromptServer.instance
                server.send_sync(
                    "comfy.workflow.progress",
                    {"event": event},
                    server.client_id,
                )

        def confirm_rental(report: dict[str, Any]) -> dict[str, Any]:
            if PromptServer is None:
                raise CloudOffloadError(
                    "Rental confirmation requires an active ComfyUI browser"
                )
            workload_id = str(report.get("capsule_digest") or "workflow")
            confirmation_id = confirmation_broker.open(report, workload_id)
            server = PromptServer.instance
            try:
                server.send_sync(
                    "cloud_offload.confirmation",
                    {
                        "confirmation_id": confirmation_id,
                        "partition_id": workload_id,
                        "report": report,
                    },
                    server.client_id,
                )
                return confirmation_broker.wait(
                    confirmation_id,
                    cancellation_event=cancellation_event,
                    timeout_seconds=300,
                )
            except ConfirmationError as exc:
                raise CloudOffloadError(str(exc)) from exc
            finally:
                confirmation_broker.discard(confirmation_id)

        result = client.run_comfyui_workflow(
            {
                "workflow": workflow,
                "inputs": inputs,
                "provider": provider,
                "timeout_seconds": int(timeout_seconds),
            },
            progress_callback=report,
            cancellation_event=cancellation_event,
            confirmation_callback=confirm_rental,
        )
        first_image = None
        image_artifact = next(
            (
                item
                for item in result.get("artifacts") or []
                if item.get("output_kind") == "image"
                or str(item.get("mime_type") or "").startswith("image/")
            ),
            None,
        )
        if image_artifact:
            with tempfile.TemporaryDirectory(
                prefix="cloud-offload-workflow-result-"
            ) as temporary:
                path = client.download_partition_artifact(
                    str(image_artifact["artifact_id"]),
                    Path(temporary) / "image.artifact",
                )
                first_image = _decode_image_bytes(path.read_bytes())
        images = result.get("images") or []
        if first_image is None and images:
            first_image = _decode_image_tensor(images[0].get("data"))
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
