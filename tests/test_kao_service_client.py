import base64
import importlib.util
import io
import json
import struct
from pathlib import Path

from PIL import Image


def load_nodes_module():
    path = Path(__file__).resolve().parents[1] / "nodes.py"
    spec = importlib.util.spec_from_file_location("comfyui_kao_nodes", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_generate_job_polls_until_result(monkeypatch):
    nodes = load_nodes_module()
    client = nodes.KaoClient(base_url="http://127.0.0.1:11501")
    statuses = iter(
        [
            {"status": "queued", "progress": 0},
            {"status": "running", "progress": 50},
            {"status": "completed", "progress": 100},
        ]
    )

    monkeypatch.setattr(client, "create_job", lambda payload: {"job_id": "job-1"})
    monkeypatch.setattr(client, "job_status", lambda job_id: next(statuses))
    monkeypatch.setattr(client, "job_result", lambda job_id: {"seed": 42})
    monkeypatch.setattr(nodes.time, "sleep", lambda seconds: None)

    assert client.generate_job({"model": "hunyuan3d-2.1-turbo"}) == {"seed": 42}


def test_comfyui_workflow_job_polls_cloud_result(monkeypatch):
    nodes = load_nodes_module()
    client = nodes.KaoClient(base_url="http://127.0.0.1:11501")
    statuses = iter(
        [
            {"status": "queued", "result": None},
            {"status": "running", "result": None},
            {"status": "completed", "result": {"prompt_id": "prompt-1"}},
        ]
    )
    monkeypatch.setattr(
        client, "create_comfyui_job", lambda payload: {"job_id": "job-1"}
    )
    monkeypatch.setattr(client, "cloud_job_status", lambda job_id: next(statuses))
    monkeypatch.setattr(nodes.time, "sleep", lambda seconds: None)

    result = client.run_comfyui_workflow({"workflow": {"1": {}}})

    assert result == {"prompt_id": "prompt-1"}


def test_comfyui_workflow_node_forwards_api_prompt_and_image(monkeypatch):
    nodes = load_nodes_module()
    submitted = []
    monkeypatch.setattr(nodes, "_image_to_b64", lambda image: "encoded-image")
    monkeypatch.setattr(
        nodes.client,
        "run_comfyui_workflow",
        lambda payload: submitted.append(payload) or {"outputs": {}, "images": []},
    )

    first_image, result_json = nodes.KaoCloudComfyUIWorkflow().execute(
        '{"1":{"class_type":"LoadImage","inputs":{"image":"input.png"}}}',
        provider="runpod",
        input_filename="input.png",
        timeout_seconds=900,
        image=object(),
    )

    assert tuple(first_image.shape) == (1, 1, 1, 3)
    assert json.loads(result_json)["outputs"] == {}
    assert submitted[0]["inputs"] == {"input.png": "encoded-image"}
    assert submitted[0]["provider"] == "runpod"


def test_generate_job_tolerates_transient_status_timeout(monkeypatch):
    nodes = load_nodes_module()
    client = nodes.KaoClient(base_url="http://127.0.0.1:11501", timeout=60)
    statuses = iter(
        [
            nodes.KaoServiceError(
                "Kao service unavailable at http://127.0.0.1:11501: timed out"
            ),
            {"status": "completed", "progress": 100},
        ]
    )

    def job_status(job_id):
        status = next(statuses)
        if isinstance(status, Exception):
            raise status
        return status

    monkeypatch.setattr(client, "create_job", lambda payload: {"job_id": "job-1"})
    monkeypatch.setattr(client, "job_status", job_status)
    monkeypatch.setattr(client, "job_result", lambda job_id: {"seed": 42})
    monkeypatch.setattr(nodes.time, "sleep", lambda seconds: None)

    assert client.generate_job({"model": "hunyuan3d-2.1-turbo"}) == {"seed": 42}


def test_client_refresh_does_not_health_gate_each_request(monkeypatch):
    nodes = load_nodes_module()
    health_requirements = []
    client = nodes.KaoClient(base_url="http://127.0.0.1:11501")
    client._configured_base_url = None
    monkeypatch.setattr(
        nodes,
        "discover_kao_service",
        lambda require_healthy=False: health_requirements.append(require_healthy)
        or {"url": "http://127.0.0.1:11501", "token": None},
    )

    client._refresh_base_url()

    assert health_requirements == [False]


def test_generate_job_raises_on_failed_job(monkeypatch):
    nodes = load_nodes_module()
    client = nodes.KaoClient(base_url="http://127.0.0.1:11501")

    monkeypatch.setattr(client, "create_job", lambda payload: {"job_id": "job-1"})
    monkeypatch.setattr(
        client, "job_status", lambda job_id: {"status": "failed", "error": "boom"}
    )

    try:
        client.generate_job({"model": "hunyuan3d-2.1-turbo"})
    except nodes.KaoServiceError as exc:
        assert "boom" in str(exc)
    else:
        raise AssertionError("Expected KaoServiceError")


def test_model_names_uses_readiness_filter_and_modalities(monkeypatch):
    nodes = load_nodes_module()
    client = nodes.KaoClient(base_url="http://127.0.0.1:11501")
    requests = []
    monkeypatch.setattr(
        client,
        "_json",
        lambda method, path, **kwargs: requests.append((path, kwargs["query"]))
        or [
            {
                "name": "triposr",
                "input_types": ["image"],
                "output_types": ["mesh"],
                "tasks": ["image-to-3d"],
            },
            {
                "name": "point-e-text",
                "input_types": ["text"],
                "output_types": ["pointcloud"],
                "tasks": ["text-to-3d"],
            },
        ],
    )

    models = client.model_names(
        execution="cloud",
        provider="runpod",
        input_type="image",
        output_type="mesh",
        task="image-to-3d",
    )

    assert models == ["triposr"]
    assert requests[0][1] == {
        "execution": "cloud",
        "runnable_only": "true",
        "provider": "runpod",
    }


def test_generate_job_cancels_when_comfyui_interrupts(monkeypatch):
    nodes = load_nodes_module()
    client = nodes.KaoClient(base_url="http://127.0.0.1:11501")
    cancelled = []

    monkeypatch.setattr(client, "create_job", lambda payload: {"job_id": "job-1"})
    monkeypatch.setattr(
        nodes,
        "_throw_if_processing_interrupted",
        lambda: (_ for _ in ()).throw(RuntimeError("interrupted")),
    )
    monkeypatch.setattr(
        client,
        "cancel_job",
        lambda job_id: cancelled.append(job_id) or {"status": "cancelled"},
    )

    try:
        client.generate_job({"model": "hunyuan3d-2.1-turbo"})
    except RuntimeError as exc:
        assert "interrupted" in str(exc)
    else:
        raise AssertionError("Expected workflow interruption")
    assert cancelled == ["job-1"]


def test_image_node_has_no_node_level_cloud_routing(monkeypatch):
    nodes = load_nodes_module()
    inputs = nodes.KaoImageTo3D.INPUT_TYPES()

    assert "execution" not in inputs["optional"]
    assert "provider" not in inputs["optional"]
    assert "model_name" not in inputs["optional"]
    assert "model" not in inputs["optional"]


def test_image_node_outputs_preview_file_and_optional_texture(monkeypatch):
    nodes = load_nodes_module()
    monkeypatch.setattr(nodes, "_image_to_b64", lambda image: "image-data")
    monkeypatch.setattr(
        nodes.client,
        "generate_job",
        lambda payload, **kwargs: {
            "mesh": base64.b64encode(b"mesh").decode("ascii"),
            "seed": 7,
            "stats": {},
        },
    )
    monkeypatch.setattr(nodes, "_file_3d_glb", lambda path: ("glb", path))
    monkeypatch.setattr(nodes, "_texture_from_glb", lambda path: "texture-image")

    mesh, seed, model_3d, texture = nodes.KaoImageTo3D().generate(
        object(), generate_texture=True
    )

    assert nodes.KaoImageTo3D.RETURN_TYPES == (
        "KAO_MESH",
        "INT",
        "FILE_3D_GLB",
        "IMAGE",
    )
    assert seed == 7
    assert model_3d == ("glb", mesh.path)
    assert texture == "texture-image"


def test_image_node_rejects_missing_requested_texture(monkeypatch):
    nodes = load_nodes_module()
    monkeypatch.setattr(nodes, "_image_to_b64", lambda image: "image-data")
    monkeypatch.setattr(
        nodes.client,
        "generate_job",
        lambda payload, **kwargs: {
            "mesh": base64.b64encode(b"mesh").decode("ascii"),
            "seed": 7,
            "stats": {},
        },
    )
    monkeypatch.setattr(nodes, "_texture_from_glb", lambda path: None)

    try:
        nodes.KaoImageTo3D().generate(object(), generate_texture=True)
    except nodes.KaoServiceError as exc:
        assert "without an embedded base-color texture" in str(exc)
    else:
        raise AssertionError("Expected KaoServiceError")


def test_texture_output_reads_embedded_glb_base_color(tmp_path):
    nodes = load_nodes_module()
    image_buffer = io.BytesIO()
    Image.new("RGB", (1, 1), (255, 0, 0)).save(image_buffer, format="PNG")
    image_data = image_buffer.getvalue()
    image_padding = b"\x00" * (-len(image_data) % 4)
    document = {
        "asset": {"version": "2.0"},
        "buffers": [{"byteLength": len(image_data)}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(image_data)}],
        "images": [{"bufferView": 0, "mimeType": "image/png"}],
        "textures": [{"source": 0}],
        "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}],
    }
    json_data = json.dumps(document, separators=(",", ":")).encode("utf-8")
    json_padding = b" " * (-len(json_data) % 4)
    json_chunk = json_data + json_padding
    binary_chunk = image_data + image_padding
    length = 12 + 8 + len(json_chunk) + 8 + len(binary_chunk)
    glb = (
        struct.pack("<4sII", b"glTF", 2, length)
        + struct.pack("<II", len(json_chunk), 0x4E4F534A)
        + json_chunk
        + struct.pack("<II", len(binary_chunk), 0x004E4942)
        + binary_chunk
    )
    path = tmp_path / "textured.glb"
    path.write_bytes(glb)

    texture = nodes._texture_from_glb(path)

    assert tuple(texture.shape) == (1, 1, 1, 3)
    assert texture[0, 0, 0].tolist() == [1.0, 0.0, 0.0]


def test_image_node_uses_fixed_default_without_model_socket(monkeypatch):
    nodes = load_nodes_module()
    submitted = []
    monkeypatch.setattr(nodes, "_image_to_b64", lambda image: "image-data")
    monkeypatch.setattr(
        nodes.client,
        "generate_job",
        lambda payload, **kwargs: submitted.append(payload)
        or {
            "mesh": base64.b64encode(b"mesh").decode("ascii"),
            "seed": 7,
            "stats": {},
        },
    )

    nodes.KaoImageTo3D().generate(object())

    assert submitted[0]["model"] == nodes.DEFAULT_IMAGE_TO_3D_MODEL


def test_kao_partition_is_submitted_as_the_real_comfy_subgraph(monkeypatch):
    nodes = load_nodes_module()
    submitted = []
    monkeypatch.setattr(
        nodes.client,
        "generate_job",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("must not lower a Kao node to a model-specific job")
        ),
    )
    monkeypatch.setattr(
        nodes.client,
        "upload_partition_artifact",
        lambda path: {"artifact_id": "a" * 64},
    )
    monkeypatch.setattr(
        nodes.client,
        "create_comfyui_partition_job",
        lambda payload: submitted.append(payload) or {"job_id": "job-1"},
    )
    monkeypatch.setattr(
        nodes.client,
        "cloud_job_status",
        lambda job_id: {"status": "completed", "result": {"output_artifacts": {}}},
    )
    monkeypatch.setattr(
        nodes.client,
        "cloud_job_events",
        lambda job_id, after=0: {"events": []},
    )
    partition = {
        "schema": "kao.partition.job.v1",
        "partition_id": "part-1",
        "runner": {"profile": "comfyui-omni"},
        "workflow": {
            "1": {
                "class_type": "KaoImageTo3D",
                "inputs": {
                    "image": ["input", 0],
                    "steps": 12,
                },
            },
            "input": {
                "class_type": "KaoPartitionInput",
                "inputs": {"boundary_key": "input_0000"},
            },
            "output": {
                "class_type": "KaoPartitionOutput",
                "inputs": {"value": ["1", 0], "boundary_key": "output_0000"},
            },
        },
        "outputs": [
            {
                "key": "output_0000",
                "source_node": "1",
                "source_output": 0,
                "type": "KAO_MESH",
            }
        ],
    }

    result = nodes.client.run_comfyui_partition(
        partition,
        {"input_0000": 7},
        provider="runpod",
    )

    assert result["job_id"] == "job-1"
    assert submitted[0]["provider"] == "runpod"
    assert submitted[0]["partition"]["workflow"]["1"]["class_type"] == "KaoImageTo3D"
    assert submitted[0]["partition"]["runner"]["profile"] == "comfyui-omni"


def test_only_cloud_offload_exposes_cloud_execution_nodes():
    nodes = load_nodes_module()

    assert "KaoSelectModel" not in nodes.NODE_CLASS_MAPPINGS
    assert "KaoLoadModel" not in nodes.NODE_CLASS_MAPPINGS
    assert "KaoCloudComfyUIWorkflow" not in nodes.NODE_CLASS_MAPPINGS
    for node_type in (nodes.KaoMultiViewTo3D, nodes.KaoImageToScene):
        optional = node_type.INPUT_TYPES()["optional"]
        assert "execution" not in optional
        assert "provider" not in optional


def test_cloud_status_node_returns_provider_balances(monkeypatch):
    nodes = load_nodes_module()
    monkeypatch.setattr(
        nodes.client,
        "cloud_status",
        lambda: {
            "providers": [
                {
                    "provider": "vast.ai",
                    "balance": {"balance": 0.0, "credit": 10.0},
                }
            ]
        },
    )

    payload = json.loads(nodes.KaoCloudStatus().status()[0])

    assert payload["providers"][0]["balance"]["credit"] == 10.0


def test_workspace_defaults_follow_lab_move():
    nodes = load_nodes_module()

    inputs = nodes.KaoWorkspaceProjectState.INPUT_TYPES()

    assert inputs["required"]["root"][1]["default"] == r"B:\lab\Kao"
