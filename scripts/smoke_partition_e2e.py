"""Paid end-to-end smoke test for a transparent Kao cloud partition."""

from __future__ import annotations

import asyncio
import json
import time
import uuid

import aiohttp


COMFY = "http://127.0.0.1:8188"
KAO = "http://127.0.0.1:11435"


def partition() -> dict:
    return {
        "schema": "kao.partition.job.v1",
        "partition_id": f"smoke-{uuid.uuid4().hex[:10]}",
        "runner": {
            "gpu_type": "RTX_4090",
            "min_gpu_ram_gb": 16,
            "keep_warm": True,
        },
        "workflow": {
            "10": {
                "class_type": "EmptyImage",
                "inputs": {"width": 64, "height": 64, "batch_size": 1, "color": 0x123456},
            },
            "11": {"class_type": "ImageInvert", "inputs": {"image": ["10", 0]}},
            "12": {"class_type": "PreviewImage", "inputs": {"images": ["11", 0]}},
            "13": {
                "class_type": "KaoPartitionOutput",
                "inputs": {
                    "value": ["11", 0],
                    "boundary_key": "output_0000",
                    "output_path": "",
                    "type_name": "IMAGE",
                },
            },
        },
        "inputs": [],
        "outputs": [{"key": "output_0000", "type": "IMAGE", "node_id": "11", "slot": 0}],
    }


async def main() -> None:
    client_id = f"kao-smoke-{uuid.uuid4().hex}"
    part = partition()
    gateway_prompt = {
        "1": {
            "class_type": "KaoCloudPartitionGateway",
            "inputs": {
                "partition_json": json.dumps(part, separators=(",", ":")),
                "provider": "runpod",
                "timeout_seconds": 1200,
            },
        },
        "2": {
            "class_type": "KaoCloudPartitionExtract",
            "inputs": {
                "result": ["1", 0],
                "boundary_key": "output_0000",
                "type_name": "IMAGE",
            },
        },
        "3": {"class_type": "PreviewImage", "inputs": {"images": ["2", 0]}},
    }
    deadline = time.monotonic() + 1200
    local_events: list[dict] = []
    job_id = None

    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(
            f"ws://127.0.0.1:8188/ws?clientId={client_id}", heartbeat=30
        ) as ws:
            response = await session.post(
                f"{COMFY}/prompt",
                json={"prompt": gateway_prompt, "client_id": client_id},
            )
            response.raise_for_status()
            prompt_id = (await response.json())["prompt_id"]
            print(json.dumps({"phase": "submitted", "prompt_id": prompt_id, "partition_id": part["partition_id"]}), flush=True)

            while time.monotonic() < deadline:
                try:
                    message = await ws.receive(timeout=2)
                    if message.type == aiohttp.WSMsgType.TEXT:
                        payload = json.loads(message.data)
                        if payload.get("type") == "kao.partition.progress":
                            event = payload.get("data", {}).get("event", {})
                            local_events.append(event)
                            print(json.dumps({"phase": "local_event", "event": event}), flush=True)
                except asyncio.TimeoutError:
                    pass

                if job_id is None:
                    async with session.get(f"{KAO}/api/cloud/jobs?limit=50") as jobs_response:
                        jobs_response.raise_for_status()
                        jobs = await jobs_response.json()
                    matching = [
                        item
                        for item in jobs
                        if item.get("model") == "comfyui-partition-v1"
                        and (item.get("request") or {}).get("partition", {}).get("partition_id")
                        == part["partition_id"]
                    ]
                    if matching:
                        job_id = matching[-1]["id"]
                        print(json.dumps({"phase": "cloud_job", "job_id": job_id}), flush=True)

                async with session.get(f"{COMFY}/history/{prompt_id}") as history_response:
                    history_response.raise_for_status()
                    history = await history_response.json()
                if prompt_id in history:
                    record = history[prompt_id]
                    status = record.get("status") or {}
                    if status.get("status_str") == "error":
                        raise RuntimeError(json.dumps(status, sort_keys=True))
                    if status.get("completed"):
                        break
            else:
                raise TimeoutError("Partition smoke test exceeded 1200 seconds")

        if not job_id:
            raise RuntimeError("No matching Kao cloud job was observed")
        async with session.get(f"{KAO}/api/cloud/jobs/{job_id}/events?limit=1000") as event_response:
            event_response.raise_for_status()
            cloud_events = (await event_response.json())["events"]
        remote = [item["event"] for item in cloud_events]
        remote_node_ids = {str(item["node_id"]) for item in remote if item.get("node_id") is not None}
        local_node_ids = {str(item["node_id"]) for item in local_events if item.get("node_id") is not None}
        remote_types = {str(item.get("type")) for item in remote}
        local_types = {str(item.get("type")) for item in local_events}
        assert len(remote_node_ids) >= 2, remote_node_ids
        assert len(local_node_ids) >= 2, local_node_ids
        assert "preview" in remote_types, remote_types
        assert "preview" in local_types, local_types
        print(
            json.dumps(
                {
                    "phase": "passed",
                    "job_id": job_id,
                    "remote_event_count": len(remote),
                    "local_event_count": len(local_events),
                    "remote_node_ids": sorted(remote_node_ids),
                    "local_node_ids": sorted(local_node_ids),
                    "remote_types": sorted(remote_types),
                    "local_types": sorted(local_types),
                },
                sort_keys=True,
            ),
            flush=True,
        )


if __name__ == "__main__":
    asyncio.run(main())
