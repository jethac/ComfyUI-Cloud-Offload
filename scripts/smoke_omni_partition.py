"""Submit a minimal boxed Kao node through the omni Cloud Offload runner."""

from __future__ import annotations

import json
import sqlite3
import time
import urllib.request
import uuid
from pathlib import Path


COMFY_URL = "http://127.0.0.1:8188"
KAO_URL = "http://127.0.0.1:11435"
QUEUE_DB = Path.home() / ".kao" / "jobs.db"


def request_json(url: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def cloud_jobs() -> dict[str, tuple[str, int]]:
    with sqlite3.connect(QUEUE_DB) as database:
        rows = database.execute(
            "SELECT id, status, progress FROM jobs ORDER BY created_at DESC LIMIT 20"
        ).fetchall()
    return {str(job_id): (str(status), int(progress or 0)) for job_id, status, progress in rows}


def build_prompt() -> dict:
    partition_id = f"smoke-{uuid.uuid4()}"
    remote_workflow = {
        "remote_input": {
            "class_type": "KaoPartitionInput",
            "inputs": {
                "boundary_key": "input_0000",
                "artifact_path": "",
                "type_name": "IMAGE",
            },
        },
        "kao_generate": {
            "class_type": "KaoImageTo3D",
            "inputs": {
                "image": ["remote_input", 0],
                "steps": 30,
                "guidance_scale": 5.0,
                "seed": 57133835,
                "octree_resolution": "256",
                "remove_background": True,
                "generate_texture": False,
            },
        },
        "remote_output": {
            "class_type": "KaoPartitionOutput",
            "inputs": {
                "value": ["kao_generate", 0],
                "boundary_key": "output_0000",
                "output_path": "",
                "type_name": "KAO_MESH",
            },
        },
    }
    partition = {
        "schema": "kao.partition.job.v1",
        "partition_id": partition_id,
        "workflow": remote_workflow,
        "inputs": [{"key": "input_0000", "type": "IMAGE"}],
        "outputs": [
            {
                "key": "output_0000",
                "type": "KAO_MESH",
                "source_node": "kao_generate",
                "source_output": 0,
            }
        ],
        "runner": {
            "profile": "comfyui-omni",
            "gpu_type": "any",
            "min_gpu_ram_gb": 40,
            "keep_warm": True,
        },
    }
    return {
        "load": {"class_type": "LoadImage", "inputs": {"image": "IMG_9136.png"}},
        "gateway": {
            "class_type": "KaoCloudPartitionGateway",
            "inputs": {
                "partition_json": json.dumps(partition, separators=(",", ":")),
                "provider": "runpod",
                "timeout_seconds": 3600,
                "input_0000": ["load", 0],
            },
        },
        "extract": {
            "class_type": "KaoCloudPartitionExtract",
            "inputs": {
                "result": ["gateway", 0],
                "boundary_key": "output_0000",
                "type_name": "KAO_MESH",
            },
        },
        "save": {
            "class_type": "KaoSaveMesh",
            "inputs": {
                "mesh": ["extract", 0],
                "filename": f"omni_smoke_{int(time.time())}",
                "format": "glb",
            },
        },
    }


def main() -> None:
    previous_jobs = set(cloud_jobs())
    client_id = str(uuid.uuid4())
    queued = request_json(
        f"{COMFY_URL}/prompt",
        {"prompt": build_prompt(), "client_id": client_id},
    )
    prompt_id = queued["prompt_id"]
    print(f"Comfy prompt: {prompt_id}", flush=True)
    cloud_job_id = None
    deadline = time.monotonic() + 3600
    last_state = None
    while time.monotonic() < deadline:
        jobs = cloud_jobs()
        if cloud_job_id is None:
            created = [job_id for job_id in jobs if job_id not in previous_jobs]
            if created:
                cloud_job_id = created[0]
                print(f"Kao cloud job: {cloud_job_id}", flush=True)
        if cloud_job_id and cloud_job_id in jobs:
            state = jobs[cloud_job_id]
            if state != last_state:
                print(f"Cloud state: {state[0]} {state[1]}%", flush=True)
                last_state = state
        history = request_json(f"{COMFY_URL}/history/{prompt_id}")
        record = history.get(prompt_id)
        if record:
            status = record.get("status") or {}
            if status.get("status_str") == "error" or not status.get("completed", False):
                messages = status.get("messages") or []
                if any(item and item[0] == "execution_error" for item in messages):
                    raise RuntimeError(json.dumps(status, indent=2))
            if status.get("completed"):
                outputs = record.get("outputs") or {}
                print(json.dumps({"prompt_id": prompt_id, "outputs": outputs}, indent=2))
                return
        time.sleep(2)
    raise TimeoutError(f"Prompt {prompt_id} did not finish within one hour")


if __name__ == "__main__":
    main()
