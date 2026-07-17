"""
ComfyUI-Kao: Kao service nodes for ComfyUI.
"""

from __future__ import annotations

import base64
import io
import json
import os
import socket
import shutil
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

import numpy as np
from PIL import Image


OLLAMA_PORT = 11434
DEFAULT_KAO_PORT = 11435
KAO_SERVICE_FILE_ENV = "KAO_SERVICE_FILE"
KAO_URL_ENV = "KAO_URL"
KAO_TOKEN_ENV = "KAO_TOKEN"
KAO_API_HEALTH_TIMEOUT = 0.1
KAO_CONNECT_TIMEOUT = 0.005
EXECUTION_TARGETS = ["local", "auto", "cloud"]
CLOUD_PROVIDERS = ["auto", "vast.ai", "runpod"]
DEFAULT_WORKSPACE_ROOT = r"B:\lab\Kao"
DEFAULT_IMAGE_TO_3D_MODEL = "hunyuan3d-2.1-turbo"
NO_RUNNABLE_MODELS = "<no runnable Kao models>"


def _url_port(url: str) -> int | None:
    parsed = urllib.parse.urlparse(url)
    if parsed.port is not None:
        return parsed.port
    if parsed.scheme == "http":
        return 80
    if parsed.scheme == "https":
        return 443
    return None


def _normalize_kao_url(url: str, source: str) -> str:
    normalized = url.rstrip("/")
    if _url_port(normalized) == OLLAMA_PORT:
        raise RuntimeError(
            f"{source} resolves to port {OLLAMA_PORT}, which is reserved for Ollama"
        )
    return normalized


def _read_kao_token(path: str | None = None) -> str | None:
    configured = os.environ.get(KAO_TOKEN_ENV)
    if configured:
        return configured.strip()
    if not path:
        return None
    try:
        token = Path(path).expanduser().read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return token or None


def _is_healthy_kao(url: str, token: str | None = None) -> bool:
    request = urllib.request.Request(
        f"{_normalize_kao_url(url, 'Kao service')}/api/health"
    )
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(
            request, timeout=KAO_API_HEALTH_TIMEOUT
        ) as response:
            if response.status != 200:
                return False
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return False
    return payload.get("name") == "Kao" and payload.get("status") == "ok"


def _can_connect_kao_port(port: int) -> bool:
    import socket

    try:
        with socket.create_connection(("127.0.0.1", port), timeout=KAO_CONNECT_TIMEOUT):
            return True
    except OSError:
        return False


def discover_kao_service(require_healthy: bool = False) -> Dict[str, Any]:
    configured = os.environ.get(KAO_URL_ENV)
    if configured:
        url = _normalize_kao_url(configured, KAO_URL_ENV)
        token = _read_kao_token()
        if require_healthy and not _is_healthy_kao(url, token):
            raise RuntimeError(f"Kao service is not healthy at {url}")
        return {"url": url, "token": token}

    service_file = Path(
        os.environ.get(KAO_SERVICE_FILE_ENV, Path.home() / ".kao" / "service.json")
    )
    try:
        service_info = json.loads(service_file.read_text(encoding="utf-8"))
        service_port = service_info.get("port")
        if isinstance(service_port, str) and service_port.isdigit():
            service_port = int(service_port)
        if isinstance(service_port, int) and service_port == OLLAMA_PORT:
            raise RuntimeError(
                f"{service_file} resolves to port {OLLAMA_PORT}, which is reserved for Ollama"
            )
        if isinstance(service_info.get("url"), str):
            url = _normalize_kao_url(service_info["url"], str(service_file))
            token = _read_kao_token(service_info.get("token_path"))
            if not require_healthy or _is_healthy_kao(url, token):
                return {"url": url, "token": token}
    except FileNotFoundError:
        pass
    except json.JSONDecodeError:
        pass

    if require_healthy:
        for port in range(DEFAULT_KAO_PORT, 11551):
            if port == OLLAMA_PORT:
                continue
            url = f"http://127.0.0.1:{port}"
            if _can_connect_kao_port(port) and _is_healthy_kao(url):
                return {"url": url, "token": None}
        raise RuntimeError("No healthy Kao service found")

    return {"url": f"http://127.0.0.1:{DEFAULT_KAO_PORT}", "token": None}


def discover_kao_url() -> str:
    return discover_kao_service()["url"]


KAO_URL = discover_kao_url()


class KaoServiceError(RuntimeError):
    """Raised when the Kao service is unavailable or rejects a request."""


class KaoMeshArtifact:
    """File-backed mesh object compatible with the existing KAO_MESH node type."""

    def __init__(self, path: Path, stats: Optional[Dict[str, Any]] = None):
        self.path = Path(path)
        self.stats = stats or {}
        self.vertices = range(int(self.stats.get("vertices") or 0))
        self.faces = range(int(self.stats.get("faces") or 0))
        visual_kind = self.stats.get("visual_kind")
        self.visual = (
            type("Visual", (), {"kind": visual_kind})() if visual_kind else None
        )

    def export(self, path: str, *args, **kwargs) -> None:
        destination = Path(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(self.path, destination)


class KaoClient:
    """Small HTTP client for the local Kao service."""

    def __init__(self, base_url: Optional[str] = None, timeout: int = 600):
        self._configured_base_url = base_url
        self.token: Optional[str] = _read_kao_token() if base_url else None
        self.base_url = (
            _normalize_kao_url(base_url, "KaoClient")
            if base_url
            else discover_kao_url()
        )
        self.timeout = timeout

    def _refresh_base_url(self) -> None:
        if self._configured_base_url is None:
            # Do not health-gate every request. Native model initialization can
            # briefly hold the interpreter lock even though the Kao process and
            # accepted job are still healthy. The request itself remains the
            # authoritative availability check.
            service = discover_kao_service(require_healthy=False)
            self.base_url = service["url"]
            self.token = service.get("token")

    def _headers(self, headers: Dict[str, str]) -> Dict[str, str]:
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def _url(self, path: str, query: Optional[Dict[str, Any]] = None) -> str:
        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{urllib.parse.urlencode(query)}"
        return url

    def _json(
        self,
        method: str,
        path: str,
        payload: Optional[Dict[str, Any]] = None,
        query: Optional[Dict[str, Any]] = None,
        timeout: Optional[int] = None,
    ) -> Any:
        try:
            self._refresh_base_url()
        except RuntimeError as exc:
            raise KaoServiceError(str(exc)) from exc
        data = None
        headers = self._headers({"Accept": "application/json"})
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            self._url(path, query=query),
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(
                request, timeout=timeout or self.timeout
            ) as response:
                body = response.read().decode("utf-8")
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as exc:
            detail = exc.reason
            try:
                payload = json.loads(exc.read().decode("utf-8"))
                detail = payload.get("error", {}).get("message") or payload.get(
                    "detail", detail
                )
            except Exception:
                pass
            raise KaoServiceError(f"Kao service error: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, socket.timeout) as exc:
            reason = getattr(exc, "reason", exc)
            raise KaoServiceError(
                f"Kao service unavailable at {self.base_url}: {reason}"
            ) from exc

    def _multipart(
        self,
        path: str,
        fields: Optional[Dict[str, Any]] = None,
        files: Optional[Dict[str, Path]] = None,
    ) -> Any:
        try:
            self._refresh_base_url()
        except RuntimeError as exc:
            raise KaoServiceError(str(exc)) from exc
        boundary = f"----comfyui-kao-{uuid.uuid4().hex}"
        chunks: list[bytes] = []
        for name, value in (fields or {}).items():
            if value is None:
                continue
            chunks.extend(
                [
                    f"--{boundary}\r\n".encode(),
                    f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
                    str(value).encode(),
                    b"\r\n",
                ]
            )
        for name, path in (files or {}).items():
            file_path = Path(path)
            chunks.extend(
                [
                    f"--{boundary}\r\n".encode(),
                    (
                        f'Content-Disposition: form-data; name="{name}"; '
                        f'filename="{file_path.name}"\r\n'
                    ).encode(),
                    b"Content-Type: application/octet-stream\r\n\r\n",
                    file_path.read_bytes(),
                    b"\r\n",
                ]
            )
        chunks.append(f"--{boundary}--\r\n".encode())
        request = urllib.request.Request(
            self._url(path),
            data=b"".join(chunks),
            headers={
                **self._headers({"Accept": "application/json"}),
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.reason
            try:
                payload = json.loads(exc.read().decode("utf-8"))
                detail = payload.get("error", {}).get("message") or payload.get(
                    "detail", detail
                )
            except Exception:
                pass
            raise KaoServiceError(f"Kao service error: {detail}") from exc
        except urllib.error.URLError as exc:
            raise KaoServiceError(
                f"Kao service unavailable at {self.base_url}: {exc.reason}"
            ) from exc

    def models(
        self,
        execution: str = "auto",
        provider: str | None = None,
    ) -> list[dict[str, Any]]:
        query: dict[str, Any] = {"execution": execution, "runnable_only": "true"}
        if provider and provider != "auto":
            query["provider"] = provider
        return self._json("GET", "/api/models", query=query, timeout=10)

    def model_names(
        self,
        execution: str = "auto",
        provider: str | None = None,
        input_type: str | None = None,
        output_type: str | None = None,
        task: str | None = None,
    ) -> list[str]:
        models = self.models(execution=execution, provider=provider)
        return [
            model["name"]
            for model in models
            if (not input_type or input_type in model.get("input_types", []))
            and (not output_type or output_type in model.get("output_types", []))
            and (not task or task in model.get("tasks", []))
        ]

    def load(self, model_name: str) -> None:
        self._json("POST", "/api/load", query={"model_name": model_name})

    def cloud_status(self) -> Dict[str, Any]:
        return self._json("GET", "/api/cloud/status", timeout=15)

    def cloud_providers(self) -> Dict[str, Any]:
        return self._json("GET", "/api/cloud/providers", timeout=15)

    def generate(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._json("POST", "/api/generate", payload=payload)

    def create_job(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._json("POST", "/api/jobs", payload=payload, timeout=10)

    def job_status(self, job_id: str) -> Dict[str, Any]:
        return self._json("GET", f"/api/jobs/{urllib.parse.quote(job_id)}", timeout=10)

    def job_result(self, job_id: str) -> Dict[str, Any]:
        return self._json(
            "GET", f"/api/jobs/{urllib.parse.quote(job_id)}/result", timeout=30
        )

    def cancel_job(self, job_id: str) -> Dict[str, Any]:
        return self._json(
            "POST", f"/api/jobs/{urllib.parse.quote(job_id)}/cancel", timeout=10
        )

    def generate_job(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        job = self.create_job(payload)
        job_id = job["job_id"]
        deadline = time.monotonic() + self.timeout
        last_poll_error: Optional[KaoServiceError] = None
        while True:
            try:
                _throw_if_processing_interrupted()
            except Exception:
                try:
                    self.cancel_job(job_id)
                finally:
                    raise
            try:
                status = self.job_status(job_id)
                last_poll_error = None
            except KaoServiceError as exc:
                if not str(exc).startswith("Kao service unavailable"):
                    raise
                last_poll_error = exc
                if time.monotonic() >= deadline:
                    raise KaoServiceError(
                        f"Timed out waiting for Kao job {job_id}: {last_poll_error}"
                    ) from exc
                time.sleep(1)
                continue
            state = status.get("status")
            if state == "completed":
                return self.job_result(job_id)
            if state == "failed":
                raise KaoServiceError(
                    status.get("error") or "Kao generation job failed"
                )
            if state in {"cancelled", "cancel_requested"}:
                raise KaoServiceError("Kao generation job was cancelled")
            time.sleep(1)

    def project_state(self, world: str) -> Dict[str, Any]:
        return self._json("GET", f"/api/workspace/projects/{urllib.parse.quote(world)}")

    def create_object_intent(
        self, world: str, payload: Dict[str, Any]
    ) -> Dict[str, Any]:
        return self._json(
            "POST",
            f"/api/workspace/projects/{urllib.parse.quote(world)}/objects",
            payload=payload,
        )

    def generate_object(
        self, world: str, object_name: str, payload: Dict[str, Any]
    ) -> Dict[str, Any]:
        return self._json(
            "POST",
            (
                f"/api/workspace/projects/{urllib.parse.quote(world)}/objects/"
                f"{urllib.parse.quote(object_name)}/generate"
            ),
            payload=payload,
        )

    def import_mesh(
        self, world: str, object_name: str, mesh_path: Path, metadata: Dict[str, Any]
    ) -> Dict[str, Any]:
        return self._multipart(
            (
                f"/api/workspace/projects/{urllib.parse.quote(world)}/objects/"
                f"{urllib.parse.quote(object_name)}/import"
            ),
            fields={"metadata": json.dumps(metadata), "producer": "ComfyUI-Kao"},
            files={"file": mesh_path},
        )

    def write_material_intent(
        self, world: str, object_name: str, payload: Dict[str, Any]
    ) -> Dict[str, Any]:
        return self._json(
            "POST",
            (
                f"/api/workspace/projects/{urllib.parse.quote(world)}/objects/"
                f"{urllib.parse.quote(object_name)}/materials"
            ),
            payload=payload,
        )


client = KaoClient()


def get_model_list(
    execution: str = "auto",
    provider: str | None = None,
    input_type: str | None = None,
    output_type: str | None = None,
    task: str | None = None,
) -> list[str]:
    try:
        models = client.model_names(
            execution=execution,
            provider=provider,
            input_type=input_type,
            output_type=output_type,
            task=task,
        )
        return models or [NO_RUNNABLE_MODELS]
    except Exception:
        return [NO_RUNNABLE_MODELS]


def _default_model(models: list[str], preferred: str) -> str:
    return preferred if preferred in models else models[0]


def _image_to_b64(image) -> str:
    img_np = (image[0].cpu().numpy() * 255).astype(np.uint8)
    pil_image = Image.fromarray(img_np)
    buffer = io.BytesIO()
    pil_image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _temp_artifact(suffix: str, data_b64: str) -> Path:
    output_dir = Path(tempfile.gettempdir()) / "comfyui-kao"
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{uuid.uuid4().hex}{suffix}"
    path.write_bytes(base64.b64decode(data_b64))
    return path


def _mesh_from_response(response: Dict[str, Any]) -> KaoMeshArtifact:
    if not response.get("mesh"):
        raise RuntimeError("Kao response did not include a mesh")
    return KaoMeshArtifact(
        _temp_artifact(".glb", response["mesh"]), response.get("stats") or {}
    )


def _decode_image_tensor(value: Optional[str]):
    if not value:
        return None
    import torch

    image = Image.open(io.BytesIO(base64.b64decode(value))).convert("RGB")
    data = np.array(image).astype(np.float32) / 255.0
    return torch.from_numpy(data).unsqueeze(0)


def _object_payload(object: str, **kwargs) -> Dict[str, Any]:
    return {"object_name": object, "object": object, **kwargs}


def _execution_payload(execution: str, provider: str) -> Dict[str, str]:
    payload = {"execution": execution}
    if provider != "auto":
        payload["provider"] = provider
    return payload


def _throw_if_processing_interrupted() -> None:
    """Forward ComfyUI cancellation to Kao without requiring ComfyUI in tests."""
    try:
        import comfy.model_management
    except ImportError:
        return
    comfy.model_management.throw_exception_if_processing_interrupted()


class KaoLoadModel:
    """Load a Kao model into the service process."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"model_name": (get_model_list(execution="local"),)},
            "optional": {"load_locally": ("BOOLEAN", {"default": True})},
        }

    RETURN_TYPES = ("KAO_MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "load"
    CATEGORY = "Kao"

    def load(self, model_name: str, load_locally: bool = True):
        if model_name == NO_RUNNABLE_MODELS:
            raise KaoServiceError("Kao reports no locally runnable models")
        if load_locally:
            client.load(model_name)
        return (model_name,)


class KaoSelectModel:
    """Select a Kao model without loading it on the local service GPU."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model_name": (get_model_list(execution="cloud"),)}}

    RETURN_TYPES = ("KAO_MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "select"
    CATEGORY = "Kao"

    def select(self, model_name: str):
        if model_name == NO_RUNNABLE_MODELS:
            raise KaoServiceError("Kao reports no cloud-runnable models")
        return (model_name,)


class KaoCloudStatus:
    """Return Kao cloud routing, worker, and provider balance status."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("status_json",)
    FUNCTION = "status"
    CATEGORY = "Kao/Cloud"

    def status(self):
        return (json.dumps(client.cloud_status(), indent=2, sort_keys=True),)


class KaoImageTo3D:
    """Generate 3D mesh from a single image using the Kao service."""

    @classmethod
    def INPUT_TYPES(cls):
        models = get_model_list(execution="auto", task="image-to-3d")
        return {
            "required": {"image": ("IMAGE",)},
            "optional": {
                "steps": ("INT", {"default": 30, "min": 1, "max": 100}),
                "guidance_scale": (
                    "FLOAT",
                    {"default": 5.0, "min": 1.0, "max": 20.0, "step": 0.1},
                ),
                "seed": ("INT", {"default": -1, "min": -1, "max": 2147483647}),
                "octree_resolution": (["256", "384", "512"], {"default": "256"}),
                "remove_background": ("BOOLEAN", {"default": True}),
                "generate_texture": ("BOOLEAN", {"default": False}),
                "execution": (EXECUTION_TARGETS, {"default": "local"}),
                "provider": (CLOUD_PROVIDERS, {"default": "auto"}),
                "model_name": (
                    models,
                    {"default": _default_model(models, DEFAULT_IMAGE_TO_3D_MODEL)},
                ),
                "model": ("KAO_MODEL",),
            },
        }

    RETURN_TYPES = ("KAO_MESH", "INT")
    RETURN_NAMES = ("mesh", "seed")
    FUNCTION = "generate"
    CATEGORY = "Kao"

    def generate(
        self,
        image,
        model: Optional[str] = None,
        steps: int = 30,
        guidance_scale: float = 5.0,
        seed: int = -1,
        octree_resolution: str = "256",
        remove_background: bool = True,
        generate_texture: bool = False,
        execution: str = "local",
        provider: str = "auto",
        model_name: str = DEFAULT_IMAGE_TO_3D_MODEL,
    ):
        selected_model = model or model_name
        if selected_model == NO_RUNNABLE_MODELS:
            raise KaoServiceError(
                "Kao reports no runnable image-to-mesh models for local or cloud execution"
            )
        response = client.generate_job(
            {
                "model": selected_model,
                "image": _image_to_b64(image),
                "steps": steps,
                "guidance_scale": guidance_scale,
                "seed": seed,
                "octree_resolution": int(octree_resolution),
                "remove_background": remove_background,
                "generate_texture": generate_texture,
                "output_format": "glb",
                **_execution_payload(execution, provider),
            }
        )
        return (_mesh_from_response(response), response.get("seed", seed))


class KaoMultiViewTo3D:
    """Generate 3D mesh from front/left/back views."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"front": ("IMAGE",), "left": ("IMAGE",), "back": ("IMAGE",)},
            "optional": {
                "steps": ("INT", {"default": 30, "min": 1, "max": 100}),
                "seed": ("INT", {"default": -1, "min": -1, "max": 2147483647}),
                "octree_resolution": (["256", "380", "512"], {"default": "380"}),
                "remove_background": ("BOOLEAN", {"default": True}),
                "execution": (EXECUTION_TARGETS, {"default": "local"}),
                "provider": (CLOUD_PROVIDERS, {"default": "auto"}),
            },
        }

    RETURN_TYPES = ("KAO_MESH", "INT")
    RETURN_NAMES = ("mesh", "seed")
    FUNCTION = "generate"
    CATEGORY = "Kao"

    def generate(
        self,
        front,
        left,
        back,
        steps: int = 30,
        seed: int = -1,
        octree_resolution: str = "380",
        remove_background: bool = True,
        execution: str = "local",
        provider: str = "auto",
    ):
        response = client.generate_job(
            {
                "model": "hunyuan3d-2mv",
                "images": {
                    "front": _image_to_b64(front),
                    "left": _image_to_b64(left),
                    "back": _image_to_b64(back),
                },
                "steps": steps,
                "seed": seed,
                "octree_resolution": int(octree_resolution),
                "remove_background": remove_background,
                "output_format": "glb",
                **_execution_payload(execution, provider),
            }
        )
        return (_mesh_from_response(response), response.get("seed", seed))


class KaoImageToScene:
    """Reconstruct 3D scene from image through Kao."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"image": ("IMAGE",)},
            "optional": {
                "output_depth": ("BOOLEAN", {"default": True}),
                "output_normals": ("BOOLEAN", {"default": False}),
                "execution": (EXECUTION_TARGETS, {"default": "local"}),
                "provider": (CLOUD_PROVIDERS, {"default": "auto"}),
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
        execution: str = "local",
        provider: str = "auto",
    ):
        output_types = ["pointcloud"]
        if output_depth:
            output_types.append("depth")
        if output_normals:
            output_types.append("normals")
        response = client.generate_job(
            {
                "model": "world-mirror",
                "image": _image_to_b64(image),
                "output_types": output_types,
                **_execution_payload(execution, provider),
            }
        )
        pointcloud = (
            base64.b64decode(response["pointcloud"])
            if response.get("pointcloud")
            else None
        )
        return (
            pointcloud,
            _decode_image_tensor(response.get("depth")),
            _decode_image_tensor(response.get("normals")),
        )


class KaoSaveMesh:
    """Save Kao mesh to file."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mesh": ("KAO_MESH",),
                "filename": ("STRING", {"default": "kao_output"}),
                "format": (["glb", "obj", "ply", "stl"],),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("filepath",)
    FUNCTION = "save"
    CATEGORY = "Kao"
    OUTPUT_NODE = True

    def save(self, mesh, filename: str, format: str = "glb"):
        import folder_paths

        output_dir = Path(folder_paths.get_output_directory())
        filepath = output_dir / f"{filename}.{format}"
        mesh.export(str(filepath))
        return (str(filepath),)


class KaoMeshPreview:
    """Preview mesh stats."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"mesh": ("KAO_MESH",)}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("info",)
    FUNCTION = "preview"
    CATEGORY = "Kao"

    def preview(self, mesh):
        info = f"Vertices: {len(mesh.vertices)}\nFaces: {len(mesh.faces)}"
        if getattr(mesh, "visual", None) is not None:
            info += f"\nTextured: {mesh.visual.kind == 'texture'}"
        if isinstance(mesh, KaoMeshArtifact):
            info += f"\nArtifact: {mesh.path}"
        return (info,)


class KaoWorkspaceProjectState:
    """Return shared Kao workspace project state as JSON."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "root": ("STRING", {"default": DEFAULT_WORKSPACE_ROOT}),
                "world": ("STRING", {"default": "default-world"}),
                "stage_input": ("STRING", {"default": "input"}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = (
        "state_json",
        "root_path",
        "world_path",
        "stage_input_path",
        "output_path",
    )
    FUNCTION = "state"
    CATEGORY = "Kao/Workspace"

    def state(self, root: str, world: str, stage_input: str = "input"):
        state = client.project_state(world)
        world_dir = state.get("world_dir", "")
        output_dir = str(Path(world_dir) / "output") if world_dir else ""
        return (
            json.dumps(state, indent=2, sort_keys=True),
            state.get("root", root),
            world_dir,
            "",
            output_dir,
        )


class KaoWorkspaceObjectIntent:
    """Create or update an object intent JSON in the shared workspace."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "root": ("STRING", {"default": DEFAULT_WORKSPACE_ROOT}),
                "world": ("STRING", {"default": "default-world"}),
                "object": ("STRING", {"default": "object"}),
                "name": ("STRING", {"default": "Object"}),
            },
            "optional": {
                "description": ("STRING", {"default": "", "multiline": True}),
                "source_image_path": ("STRING", {"default": ""}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("object_json", "object_path", "object_dir")
    FUNCTION = "write"
    CATEGORY = "Kao/Workspace"
    OUTPUT_NODE = True

    def write(
        self,
        root: str,
        world: str,
        object: str,
        name: str,
        description: str = "",
        source_image_path: str = "",
    ):
        response = client.create_object_intent(
            world,
            _object_payload(
                object, name=name, prompt=description, source_image=source_image_path
            ),
        )
        object_dir = response.get("object_dir", "")
        return (
            json.dumps(response, indent=2, sort_keys=True),
            str(Path(object_dir) / "object.json") if object_dir else "",
            object_dir,
        )


class KaoGenerateObjectToWorkspace:
    """Generate a GLB into a shared Kao workspace object directory."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "root": ("STRING", {"default": DEFAULT_WORKSPACE_ROOT}),
                "world": ("STRING", {"default": "default-world"}),
                "object": ("STRING", {"default": "object"}),
                "model": (get_model_list(),),
            },
            "optional": {
                "steps": ("INT", {"default": 30, "min": 1, "max": 100}),
                "guidance_scale": (
                    "FLOAT",
                    {"default": 5.0, "min": 1.0, "max": 20.0, "step": 0.1},
                ),
                "seed": ("INT", {"default": -1, "min": -1, "max": 2147483647}),
                "octree_resolution": (["256", "384", "512"], {"default": "256"}),
                "remove_background": ("BOOLEAN", {"default": True}),
                "generate_texture": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("mesh_path", "metadata_path")
    FUNCTION = "generate"
    CATEGORY = "Kao/Workspace"
    OUTPUT_NODE = True

    def generate(
        self,
        image,
        root: str,
        world: str,
        object: str,
        model: str,
        steps: int = 30,
        guidance_scale: float = 5.0,
        seed: int = -1,
        octree_resolution: str = "256",
        remove_background: bool = True,
        generate_texture: bool = False,
    ):
        source_path = _temp_artifact(".png", _image_to_b64(image))
        staged = client._multipart(
            f"/api/workspace/projects/{urllib.parse.quote(world)}/source-images",
            fields={"name": object},
            files={"image": source_path},
        )
        source_image = (staged.get("image") or {}).get("path")
        response = client.generate_object(
            world,
            object,
            _object_payload(
                object,
                model=model,
                source_image=source_image,
                steps=steps,
                seed=seed,
                guidance_scale=guidance_scale,
                octree_resolution=int(octree_resolution),
                remove_background=remove_background,
                generate_texture=generate_texture,
            ),
        )
        return (response.get("artifact", ""), response.get("metadata", ""))


class KaoWorkspaceSaveMesh:
    """Save a KAO_MESH as an indexed workspace artifact through Kao."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mesh": ("KAO_MESH",),
                "root": ("STRING", {"default": DEFAULT_WORKSPACE_ROOT}),
                "world": ("STRING", {"default": "default-world"}),
                "object": ("STRING", {"default": "object"}),
            },
            "optional": {
                "artifact_prefix": ("STRING", {"default": "mesh"}),
                "format": (["glb", "obj", "ply", "stl"], {"default": "glb"}),
                "metadata_json": ("STRING", {"default": "{}", "multiline": True}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("mesh_path", "metadata_path")
    FUNCTION = "save"
    CATEGORY = "Kao/Workspace"
    OUTPUT_NODE = True

    def save(
        self,
        mesh,
        root: str,
        world: str,
        object: str,
        artifact_prefix: str = "mesh",
        format: str = "glb",
        metadata_json: str = "{}",
    ):
        metadata = json.loads(metadata_json) if metadata_json.strip() else {}
        source_path = Path(getattr(mesh, "path", ""))
        if not source_path.exists():
            output_dir = Path(tempfile.gettempdir()) / "comfyui-kao"
            output_dir.mkdir(parents=True, exist_ok=True)
            source_path = output_dir / f"{uuid.uuid4().hex}.{format}"
            mesh.export(str(source_path))
        response = client.import_mesh(world, object, source_path, metadata)
        return (response.get("artifact", ""), response.get("metadata", ""))


class KaoWorkspaceMaterialIntent:
    """Create/update a provider-neutral material intent for a workspace object."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "root": ("STRING", {"default": DEFAULT_WORKSPACE_ROOT}),
                "world": ("STRING", {"default": "default-world"}),
                "object": ("STRING", {"default": "object"}),
                "material": ("STRING", {"default": "material"}),
            },
            "optional": {
                "prompt": ("STRING", {"default": "", "multiline": True}),
                "material_type": ("STRING", {"default": "pbr"}),
                "metadata_json": ("STRING", {"default": "{}", "multiline": True}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("material_json", "material_path")
    FUNCTION = "write"
    CATEGORY = "Kao/Workspace"
    OUTPUT_NODE = True

    def write(
        self,
        root: str,
        world: str,
        object: str,
        material: str,
        prompt: str = "",
        material_type: str = "pbr",
        metadata_json: str = "{}",
    ):
        metadata = json.loads(metadata_json) if metadata_json.strip() else {}
        response = client.write_material_intent(
            world,
            object,
            _object_payload(
                object,
                material_name=material,
                prompt=prompt,
                material_type=material_type,
                metadata=metadata,
            ),
        )
        material_path = response.get("material_json", "")
        return (json.dumps(response, indent=2, sort_keys=True), material_path)


NODE_CLASS_MAPPINGS = {
    "KaoLoadModel": KaoLoadModel,
    "KaoSelectModel": KaoSelectModel,
    "KaoCloudStatus": KaoCloudStatus,
    "KaoImageTo3D": KaoImageTo3D,
    "KaoMultiViewTo3D": KaoMultiViewTo3D,
    "KaoImageToScene": KaoImageToScene,
    "KaoSaveMesh": KaoSaveMesh,
    "KaoMeshPreview": KaoMeshPreview,
    "KaoWorkspaceProjectState": KaoWorkspaceProjectState,
    "KaoWorkspaceObjectIntent": KaoWorkspaceObjectIntent,
    "KaoGenerateObjectToWorkspace": KaoGenerateObjectToWorkspace,
    "KaoWorkspaceSaveMesh": KaoWorkspaceSaveMesh,
    "KaoWorkspaceMaterialIntent": KaoWorkspaceMaterialIntent,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "KaoLoadModel": "Kao Load Model",
    "KaoSelectModel": "Kao Select Model",
    "KaoCloudStatus": "Kao Cloud Status",
    "KaoImageTo3D": "Kao Image -> 3D",
    "KaoMultiViewTo3D": "Kao Multi-View -> 3D",
    "KaoImageToScene": "Kao Image -> Scene",
    "KaoSaveMesh": "Kao Save Mesh",
    "KaoMeshPreview": "Kao Mesh Preview",
    "KaoWorkspaceProjectState": "Workspace Project State",
    "KaoWorkspaceObjectIntent": "Workspace Object Intent",
    "KaoGenerateObjectToWorkspace": "Kao Generate Object To Workspace",
    "KaoWorkspaceSaveMesh": "Workspace Save Mesh",
    "KaoWorkspaceMaterialIntent": "Workspace Material Intent",
}
