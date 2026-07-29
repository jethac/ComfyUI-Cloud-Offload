"""V3 dynamic bridge nodes for transparent Cloud Offload graph partitions."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any

from comfy_api.latest import ComfyExtension, io

try:
    from .client import CloudMeshArtifact, CloudOffloadError, _file_3d_glb, client
    from .partition_protocol import (
        ARTIFACT_MARKER,
        dump_bundle,
        load_bundle,
        validate_boundary_type,
    )
except ImportError:
    from client import CloudMeshArtifact, CloudOffloadError, _file_3d_glb, client
    from partition_protocol import ARTIFACT_MARKER, dump_bundle, load_bundle, validate_boundary_type


PartitionResult = io.Custom("CLOUD_PARTITION_RESULT")


def _restore_file_artifact(value: Any, type_name: str) -> Any:
    if not isinstance(value, dict) or ARTIFACT_MARKER not in value:
        return value
    artifact_type = value.get(ARTIFACT_MARKER)
    normalized_type = str(type_name or "").upper()
    if artifact_type == "cloud_mesh" and normalized_type != "CLOUD_MESH":
        raise CloudOffloadError("Cloud partition returned a mesh for an incompatible socket")
    if artifact_type == "file_3d" and not normalized_type.startswith("FILE_3D"):
        raise CloudOffloadError("Cloud partition returned a 3D file for an incompatible socket")
    file_format = str(value.get("format") or "glb").lower()
    output_dir = Path(tempfile.gettempdir()) / "comfyui-cloud-offload" / "partitions"
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{uuid.uuid4().hex}.{file_format}"
    path.write_bytes(bytes(value.get("data") or b""))
    if artifact_type == "cloud_mesh":
        return CloudMeshArtifact(path, value.get("metadata") or {})
    return _file_3d_glb(path)


def _partition_path(value: str, *, must_exist: bool) -> Path:
    root = Path(os.environ.get("COMFY_PARTITION_ROOT", "")).resolve()
    if not str(root) or str(root) == str(Path(".").resolve()):
        raise CloudOffloadError("COMFY_PARTITION_ROOT is not configured for partition bridge nodes")
    path = Path(value).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise CloudOffloadError("Partition artifact path escapes COMFY_PARTITION_ROOT") from exc
    if must_exist and not path.is_file():
        raise CloudOffloadError(f"Partition input artifact does not exist: {path.name}")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


class CloudPartitionGateway(io.ComfyNode):
    """Invisible local proxy that pauses execution while a cloud subgraph runs."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="CloudPartitionGateway",
            display_name="Cloud Offload Partition Gateway",
            category="Cloud Offload/Internal",
            description="Compiler-generated asynchronous Cloud Offload gateway.",
            inputs=[
                io.String.Input("partition_json", multiline=True),
                io.Combo.Input("provider", options=["auto", "runpod", "vast.ai"], default="auto"),
                io.Int.Input("timeout_seconds", default=3600, min=1, max=86400),
            ],
            outputs=[PartitionResult.Output(display_name="partition result")],
            accept_all_inputs=True,
            is_output_node=True,
            is_dev_only=True,
            not_idempotent=True,
        )

    @classmethod
    async def execute(
        cls,
        partition_json: str,
        provider: str = "auto",
        timeout_seconds: int = 3600,
        **boundary_values: Any,
    ) -> io.NodeOutput:
        try:
            partition = json.loads(partition_json)
        except json.JSONDecodeError as exc:
            raise CloudOffloadError(f"Compiled partition JSON is invalid: {exc}") from exc
        if partition.get("schema") != "comfy.partition.job.v1":
            raise CloudOffloadError("Unsupported compiled partition schema")
        inputs = {key: value for key, value in boundary_values.items() if key.startswith("input_")}

        try:
            from comfy.utils import ProgressBar
            from server import PromptServer
        except ImportError:  # pragma: no cover - only possible outside ComfyUI
            ProgressBar = None
            PromptServer = None
        progress_bar = ProgressBar(100) if ProgressBar is not None else None

        def report(event: dict[str, Any]) -> None:
            overall = event.get("overall_progress")
            if progress_bar is not None and overall is not None:
                progress_bar.update_absolute(max(0, min(100, int(overall))), 100)
            if PromptServer is not None:
                server = PromptServer.instance
                server.send_sync(
                    "comfy.partition.progress",
                    {
                        "partition_id": partition.get("partition_id"),
                        "event": event,
                    },
                    server.client_id,
                )

        cancellation_event = threading.Event()
        try:
            result = await asyncio.to_thread(
                client.run_comfyui_partition,
                partition,
                inputs,
                provider=provider,
                timeout_seconds=int(timeout_seconds),
                progress_callback=report,
                cancellation_event=cancellation_event,
            )
        except asyncio.CancelledError:
            cancellation_event.set()
            report(
                {
                    "type": "partition_cancelled",
                    "overall_progress": 100,
                    "error": "Cloud partition was cancelled",
                }
            )
            raise
        except Exception as exc:
            report(
                {
                    "type": "partition_failed",
                    "overall_progress": 100,
                    "error": str(exc),
                }
            )
            raise
        report(
            {
                "type": "partition_completed",
                "overall_progress": 100,
                "job_id": result.get("job_id"),
            }
        )
        return io.NodeOutput(result)


class CloudPartitionExtract(io.ComfyNode):
    """Restore one ordinary Comfy value from an opaque partition result."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="CloudPartitionExtract",
            display_name="Cloud Offload Partition Output",
            category="Cloud Offload/Internal",
            inputs=[
                PartitionResult.Input("result"),
                io.String.Input("boundary_key"),
                io.String.Input("type_name"),
            ],
            outputs=[io.AnyType.Output(display_name="value")],
            is_dev_only=True,
        )

    @classmethod
    def execute(cls, result: dict[str, Any], boundary_key: str, type_name: str) -> io.NodeOutput:
        validate_boundary_type(type_name)
        values = result.get("values") or {}
        if boundary_key not in values:
            raise CloudOffloadError(f"Cloud partition returned no output for {boundary_key}")
        return io.NodeOutput(_restore_file_artifact(values[boundary_key], type_name))


class CloudPartitionInput(io.ComfyNode):
    """Runner-only bridge that restores an uploaded boundary value."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="CloudPartitionInput",
            display_name="Cloud Partition Input",
            category="Cloud Offload/Internal",
            inputs=[
                io.String.Input("boundary_key"),
                io.String.Input("artifact_path"),
                io.String.Input("type_name"),
            ],
            outputs=[io.AnyType.Output(display_name="value")],
            is_dev_only=True,
        )

    @classmethod
    def execute(cls, boundary_key: str, artifact_path: str, type_name: str) -> io.NodeOutput:
        validate_boundary_type(type_name)
        return io.NodeOutput(load_bundle(_partition_path(artifact_path, must_exist=True)))


class CloudPartitionOutput(io.ComfyNode):
    """Runner-only output node that writes a safe typed boundary bundle."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="CloudPartitionOutput",
            display_name="Cloud Partition Output",
            category="Cloud Offload/Internal",
            inputs=[
                io.AnyType.Input("value"),
                io.String.Input("boundary_key"),
                io.String.Input("output_path"),
                io.String.Input("type_name"),
            ],
            outputs=[],
            is_output_node=True,
            is_dev_only=True,
        )

    @classmethod
    def execute(
        cls, value: Any, boundary_key: str, output_path: str, type_name: str
    ) -> io.NodeOutput:
        validate_boundary_type(type_name)
        path = _partition_path(output_path, must_exist=False)
        metadata = dump_bundle(value, path)
        return io.NodeOutput(
            ui={
                "comfy_partition_artifacts": [
                    {"boundary_key": boundary_key, "path": str(path), **metadata}
                ]
            }
        )


class CloudPartitionExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            CloudPartitionGateway,
            CloudPartitionExtract,
            CloudPartitionInput,
            CloudPartitionOutput,
        ]
