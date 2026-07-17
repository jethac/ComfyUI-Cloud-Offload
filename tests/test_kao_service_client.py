import base64
import importlib.util
import json
from pathlib import Path


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


def test_image_node_forwards_cloud_provider(monkeypatch):
    nodes = load_nodes_module()
    submitted = []
    monkeypatch.setattr(nodes, "_image_to_b64", lambda image: "image-data")
    monkeypatch.setattr(
        nodes.client,
        "generate_job",
        lambda payload: submitted.append(payload)
        or {
            "mesh": base64.b64encode(b"mesh").decode("ascii"),
            "seed": 7,
            "stats": {},
        },
    )

    _, seed = nodes.KaoImageTo3D().generate(
        object(),
        "hunyuan3d-2.1-turbo",
        execution="cloud",
        provider="runpod",
    )

    assert seed == 7
    assert submitted[0]["execution"] == "cloud"
    assert submitted[0]["provider"] == "runpod"


def test_image_node_has_default_model_dropdown_and_optional_override(monkeypatch):
    nodes = load_nodes_module()
    monkeypatch.setattr(
        nodes,
        "get_model_list",
        lambda **kwargs: ["hunyuan3d-2.1-turbo", "triposr"],
    )

    inputs = nodes.KaoImageTo3D.INPUT_TYPES()

    assert set(inputs["required"]) == {"image"}
    assert inputs["optional"]["model_name"][1]["default"] == ("hunyuan3d-2.1-turbo")
    assert inputs["optional"]["model"] == ("KAO_MODEL",)


def test_image_node_falls_back_to_first_runnable_model(monkeypatch):
    nodes = load_nodes_module()
    monkeypatch.setattr(nodes, "get_model_list", lambda **kwargs: ["triposr"])

    inputs = nodes.KaoImageTo3D.INPUT_TYPES()

    assert inputs["optional"]["model_name"][1]["default"] == "triposr"


def test_image_node_uses_dropdown_model_without_model_socket(monkeypatch):
    nodes = load_nodes_module()
    submitted = []
    monkeypatch.setattr(nodes, "_image_to_b64", lambda image: "image-data")
    monkeypatch.setattr(
        nodes.client,
        "generate_job",
        lambda payload: submitted.append(payload)
        or {
            "mesh": base64.b64encode(b"mesh").decode("ascii"),
            "seed": 7,
            "stats": {},
        },
    )

    nodes.KaoImageTo3D().generate(object(), model_name="triposr")

    assert submitted[0]["model"] == "triposr"


def test_image_node_model_socket_overrides_dropdown(monkeypatch):
    nodes = load_nodes_module()
    submitted = []
    monkeypatch.setattr(nodes, "_image_to_b64", lambda image: "image-data")
    monkeypatch.setattr(
        nodes.client,
        "generate_job",
        lambda payload: submitted.append(payload)
        or {
            "mesh": base64.b64encode(b"mesh").decode("ascii"),
            "seed": 7,
            "stats": {},
        },
    )

    nodes.KaoImageTo3D().generate(
        object(), model="triposr", model_name="hunyuan3d-2.1-turbo"
    )

    assert submitted[0]["model"] == "triposr"


def test_select_model_does_not_load_local_runtime(monkeypatch):
    nodes = load_nodes_module()
    monkeypatch.setattr(
        nodes.client,
        "load",
        lambda model: (_ for _ in ()).throw(AssertionError("should not load")),
    )

    assert nodes.KaoSelectModel().select("world-mirror") == ("world-mirror",)
    assert nodes.KaoLoadModel().load("world-mirror", load_locally=False) == (
        "world-mirror",
    )


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
