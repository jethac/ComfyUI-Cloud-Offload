import importlib.util
import io
import json
from pathlib import Path

import pytest

import client as client_module
from client import CloudOffloadClient, CloudOffloadError


def load_nodes_module():
    path = Path(__file__).resolve().parents[1] / "nodes.py"
    spec = importlib.util.spec_from_file_location("cloud_offload_nodes", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class _FakeResponse:
    def __init__(self, status: int, body: bytes):
        self.status = status
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


# -- Discovery ----------------------------------------------------------------


def test_discovery_prefers_cloud_offload_url_env(monkeypatch):
    monkeypatch.setenv("CLOUD_OFFLOAD_URL", "http://127.0.0.1:11599/")
    monkeypatch.delenv("CLOUD_OFFLOAD_TOKEN", raising=False)
    service = client_module.discover_service()
    assert service["url"] == "http://127.0.0.1:11599"


def test_discovery_reads_cloud_offload_token_env(monkeypatch):
    monkeypatch.setenv("CLOUD_OFFLOAD_URL", "http://127.0.0.1:11599")
    monkeypatch.setenv("CLOUD_OFFLOAD_TOKEN", "secret-token")
    service = client_module.discover_service()
    assert service["token"] == "secret-token"


def test_discovery_rejects_ollama_port(monkeypatch):
    monkeypatch.setenv("CLOUD_OFFLOAD_URL", "http://127.0.0.1:11434")
    with pytest.raises(RuntimeError, match="Ollama"):
        client_module.discover_service()


def test_discovery_falls_back_to_service_file(monkeypatch, tmp_path):
    monkeypatch.delenv("CLOUD_OFFLOAD_URL", raising=False)
    monkeypatch.delenv("CLOUD_OFFLOAD_TOKEN", raising=False)
    service_file = tmp_path / "service.json"
    service_file.write_text(json.dumps({"url": "http://127.0.0.1:11588"}), encoding="utf-8")
    monkeypatch.setenv("CLOUD_OFFLOAD_SERVICE_FILE", str(service_file))
    service = client_module.discover_service()
    assert service["url"] == "http://127.0.0.1:11588"


def test_discovery_service_file_rejects_ollama_port(monkeypatch, tmp_path):
    monkeypatch.delenv("CLOUD_OFFLOAD_URL", raising=False)
    service_file = tmp_path / "service.json"
    service_file.write_text(json.dumps({"port": 11434, "url": "http://127.0.0.1:11434"}), encoding="utf-8")
    monkeypatch.setenv("CLOUD_OFFLOAD_SERVICE_FILE", str(service_file))
    with pytest.raises(RuntimeError, match="Ollama"):
        client_module.discover_service()


def test_discovery_default_when_nothing_configured(monkeypatch, tmp_path):
    monkeypatch.delenv("CLOUD_OFFLOAD_URL", raising=False)
    monkeypatch.setenv("CLOUD_OFFLOAD_SERVICE_FILE", str(tmp_path / "missing.json"))
    service = client_module.discover_service()
    assert service["url"] == "http://127.0.0.1:11435"


def test_health_check_matches_cloud_offload_name(monkeypatch):
    monkeypatch.setattr(
        client_module.urllib.request,
        "urlopen",
        lambda request, timeout=None: _FakeResponse(
            200, json.dumps({"name": "cloud-offload", "status": "ok"}).encode("utf-8")
        ),
    )
    assert client_module._is_healthy("http://127.0.0.1:11599") is True


def test_health_check_rejects_foreign_service(monkeypatch):
    monkeypatch.setattr(
        client_module.urllib.request,
        "urlopen",
        lambda request, timeout=None: _FakeResponse(
            200, json.dumps({"name": "Kao", "status": "ok"}).encode("utf-8")
        ),
    )
    assert client_module._is_healthy("http://127.0.0.1:11599") is False


# -- Client -------------------------------------------------------------------


def test_client_refresh_does_not_health_gate_each_request(monkeypatch):
    calls = []
    c = CloudOffloadClient(base_url="http://127.0.0.1:11501")
    c._configured_base_url = None
    monkeypatch.setattr(
        client_module,
        "discover_service",
        lambda require_healthy=False: calls.append(require_healthy)
        or {"url": "http://127.0.0.1:11501", "token": None},
    )

    c._refresh_base_url()

    assert calls == [False]


def test_run_workflow_polls_until_result(monkeypatch):
    c = CloudOffloadClient(base_url="http://127.0.0.1:11501")
    statuses = iter(
        [
            {"status": "queued", "result": None},
            {"status": "running", "result": None},
            {"status": "completed", "result": {"prompt_id": "prompt-1"}},
        ]
    )
    monkeypatch.setattr(c, "submit_workflow", lambda payload: {"job_id": "job-1"})
    monkeypatch.setattr(c, "job_status", lambda job_id: next(statuses))
    monkeypatch.setattr(client_module.time, "sleep", lambda seconds: None)

    assert c.run_comfyui_workflow({"workflow": {"1": {}}}) == {"prompt_id": "prompt-1"}


def test_run_workflow_raises_on_failed_job(monkeypatch):
    c = CloudOffloadClient(base_url="http://127.0.0.1:11501")
    monkeypatch.setattr(c, "submit_workflow", lambda payload: {"job_id": "job-1"})
    monkeypatch.setattr(
        c, "job_status", lambda job_id: {"status": "failed", "error": "boom"}
    )

    with pytest.raises(CloudOffloadError, match="boom"):
        c.run_comfyui_workflow({"workflow": {"1": {}}})


def test_partition_is_submitted_as_the_real_comfy_subgraph(monkeypatch):
    c = CloudOffloadClient(base_url="http://127.0.0.1:11501")
    submitted = []
    monkeypatch.setattr(
        c, "upload_partition_artifact", lambda path: {"artifact_id": "a" * 64}
    )
    monkeypatch.setattr(
        c, "submit_partition", lambda payload: submitted.append(payload) or {"job_id": "job-1"}
    )
    monkeypatch.setattr(
        c,
        "job_status",
        lambda job_id: {"status": "completed", "result": {"output_artifacts": {}}},
    )
    monkeypatch.setattr(c, "job_events", lambda job_id, after=0: {"events": []})
    monkeypatch.setattr(client_module.time, "sleep", lambda seconds: None)

    partition = {
        "schema": "comfy.partition.job.v1",
        "partition_id": "part-1",
        "runner": {"profile": "comfyui-partition-v1"},
        "workflow": {
            "1": {
                "class_type": "SomeNativeNode",
                "inputs": {"image": ["input", 0], "steps": 12},
            },
            "input": {
                "class_type": "CloudPartitionInput",
                "inputs": {"boundary_key": "input_0000"},
            },
            "output": {
                "class_type": "CloudPartitionOutput",
                "inputs": {"value": ["1", 0], "boundary_key": "output_0000"},
            },
        },
        "outputs": [
            {"key": "output_0000", "source_node": "1", "source_output": 0, "type": "IMAGE"}
        ],
    }

    result = c.run_comfyui_partition(partition, {"input_0000": 7}, provider="runpod")

    assert result["job_id"] == "job-1"
    assert submitted[0]["provider"] == "runpod"
    assert submitted[0]["input_artifacts"]["input_0000"] == "a" * 64
    assert submitted[0]["partition"]["runner"]["profile"] == "comfyui-partition-v1"
    assert submitted[0]["partition"]["schema"] == "comfy.partition.job.v1"


def test_partition_raises_on_failed_job(monkeypatch):
    c = CloudOffloadClient(base_url="http://127.0.0.1:11501")
    monkeypatch.setattr(c, "submit_partition", lambda payload: {"job_id": "job-1"})
    monkeypatch.setattr(
        c, "job_status", lambda job_id: {"status": "failed", "error": "boom"}
    )
    monkeypatch.setattr(c, "job_events", lambda job_id, after=0: {"events": []})
    monkeypatch.setattr(client_module.time, "sleep", lambda seconds: None)

    partition = {
        "schema": "comfy.partition.job.v1",
        "partition_id": "p",
        "workflow": {},
        "outputs": [],
    }
    with pytest.raises(CloudOffloadError, match="boom"):
        c.run_comfyui_partition(partition, {}, provider="runpod")


def test_partition_cancels_when_comfyui_interrupts(monkeypatch):
    c = CloudOffloadClient(base_url="http://127.0.0.1:11501")
    cancelled = []
    monkeypatch.setattr(c, "submit_partition", lambda payload: {"job_id": "job-1"})
    monkeypatch.setattr(
        client_module,
        "_throw_if_processing_interrupted",
        lambda: (_ for _ in ()).throw(RuntimeError("interrupted")),
    )
    monkeypatch.setattr(
        c, "cancel_job", lambda job_id: cancelled.append(job_id) or {"status": "cancelled"}
    )

    partition = {
        "schema": "comfy.partition.job.v1",
        "partition_id": "p",
        "workflow": {},
        "outputs": [],
    }
    with pytest.raises(RuntimeError, match="interrupted"):
        c.run_comfyui_partition(partition, {}, provider="runpod")
    assert cancelled == ["job-1"]


# -- Nodes --------------------------------------------------------------------


def test_cloud_workflow_node_forwards_api_prompt_and_image(monkeypatch):
    nodes = load_nodes_module()
    submitted = []
    monkeypatch.setattr(nodes, "_image_to_b64", lambda image: "encoded-image")
    monkeypatch.setattr(
        nodes.client,
        "run_comfyui_workflow",
        lambda payload: submitted.append(payload) or {"outputs": {}, "images": []},
    )

    first_image, result_json = nodes.CloudWorkflow().execute(
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


def test_cloud_status_node_returns_provider_balances(monkeypatch):
    nodes = load_nodes_module()
    monkeypatch.setattr(
        nodes.client,
        "status",
        lambda: {
            "providers": [
                {"provider": "vast.ai", "balance": {"balance": 0.0, "credit": 10.0}}
            ]
        },
    )

    payload = json.loads(nodes.CloudStatus().status()[0])

    assert payload["providers"][0]["balance"]["credit"] == 10.0


def test_node_mappings_expose_only_neutral_surface():
    nodes = load_nodes_module()

    assert set(nodes.NODE_CLASS_MAPPINGS) == {"CloudStatus", "CloudWorkflow"}
    for legacy in (
        "KaoImageTo3D",
        "KaoMultiViewTo3D",
        "KaoImageToScene",
        "KaoSaveMesh",
        "KaoMeshPreview",
        "KaoCloudStatus",
        "KaoCloudComfyUIWorkflow",
        "KaoSelectModel",
        "KaoLoadModel",
        "KaoWorkspaceProjectState",
        "KaoWorkspaceObjectIntent",
        "KaoGenerateObjectToWorkspace",
        "KaoWorkspaceSaveMesh",
        "KaoWorkspaceMaterialIntent",
    ):
        assert legacy not in nodes.NODE_CLASS_MAPPINGS
        assert not hasattr(nodes, legacy)


def test_partition_nodes_use_neutral_class_and_wire_ids():
    pytest.importorskip("comfy_api.latest")
    import partition_nodes

    assert partition_nodes.CloudPartitionGateway.define_schema().node_id == "CloudPartitionGateway"
    assert partition_nodes.CloudPartitionExtract.define_schema().node_id == "CloudPartitionExtract"
    assert partition_nodes.CloudPartitionInput.define_schema().node_id == "CloudPartitionInput"
    assert partition_nodes.CloudPartitionOutput.define_schema().node_id == "CloudPartitionOutput"
    for node in (
        partition_nodes.CloudPartitionGateway,
        partition_nodes.CloudPartitionInput,
        partition_nodes.CloudPartitionOutput,
    ):
        assert node.define_schema().category.startswith("Cloud Offload")


def test_partition_path_requires_comfy_partition_root(monkeypatch):
    pytest.importorskip("comfy_api.latest")
    import partition_nodes

    monkeypatch.delenv("COMFY_PARTITION_ROOT", raising=False)
    with pytest.raises(CloudOffloadError, match="COMFY_PARTITION_ROOT"):
        partition_nodes._partition_path("whatever.part", must_exist=False)


# === Dynamic provider discovery ===

def test_provider_names_come_from_coordinator(monkeypatch):
    calls = []

    def fake_json(self, method, path, **kwargs):
        calls.append(path)
        return {
            "default_provider": "runpod",
            "providers": [
                {"provider": "runpod", "configured": True},
                {"provider": "vast.ai", "configured": False},
                {"provider": "lambda", "configured": True},
            ],
        }

    monkeypatch.setattr(client_module.CloudOffloadClient, "_json", fake_json)
    instance = client_module.CloudOffloadClient("http://coordinator.invalid")

    assert instance.provider_names() == ["auto", "runpod", "vast.ai", "lambda"]
    assert calls == ["/api/providers"]
    # Cached: a second call must not re-query the coordinator.
    assert instance.provider_names() == ["auto", "runpod", "vast.ai", "lambda"]
    assert calls == ["/api/providers"]


def test_provider_names_fall_back_when_coordinator_unreachable(monkeypatch):
    def boom(self, method, path, **kwargs):
        raise client_module.CloudOffloadError("coordinator down")

    monkeypatch.setattr(client_module.CloudOffloadClient, "_json", boom)
    instance = client_module.CloudOffloadClient("http://coordinator.invalid")

    # Node definitions are built at import time; discovery failure must not break them.
    assert instance.provider_names() == client_module.FALLBACK_PROVIDERS


# === Declarative provider specs ===

def test_provider_spec_methods_map_to_coordinator_routes(monkeypatch):
    calls = []

    def fake_json(self, method, path, payload=None, **kwargs):
        calls.append((method, path, payload))
        return {"ok": True}

    monkeypatch.setattr(client_module.CloudOffloadClient, "_json", fake_json)
    instance = client_module.CloudOffloadClient("http://coordinator.invalid")
    spec = {"name": "acme", "base_url": "https://api.acme.dev/v1"}

    instance.provider_specs()
    instance.provider_spec("acme")
    instance.save_provider_spec("acme", spec)
    instance.delete_provider_spec("acme")
    instance.validate_provider_spec(spec)
    instance.dry_run_provider_spec(spec, api_key="probe-only")
    instance.dry_run_provider_spec(spec)

    assert calls == [
        ("GET", "/api/providers/specs", None),
        ("GET", "/api/providers/specs/acme", None),
        ("PUT", "/api/providers/specs/acme", spec),
        ("DELETE", "/api/providers/specs/acme", None),
        ("POST", "/api/providers/specs/validate", spec),
        ("POST", "/api/providers/specs/dry-run", {"spec": spec, "api_key": "probe-only"}),
        # No key supplied means "use whatever the coordinator already has".
        ("POST", "/api/providers/specs/dry-run", {"spec": spec}),
    ]


def test_provider_spec_names_are_url_encoded(monkeypatch):
    calls = []
    monkeypatch.setattr(
        client_module.CloudOffloadClient,
        "_json",
        lambda self, method, path, **kwargs: calls.append(path) or {},
    )
    instance = client_module.CloudOffloadClient("http://coordinator.invalid")

    instance.provider_spec("../../etc/passwd")

    # The coordinator sanitizes too, but a client must not send a path it did
    # not mean to address.
    assert calls == ["/api/providers/specs/..%2F..%2Fetc%2Fpasswd"]


def test_http_error_surfaces_structured_problem_lists(monkeypatch):
    import urllib.error

    body = json.dumps(
        {
            "error": {
                "code": "cloud_offload.invalid_provider_spec",
                "message": "Provider spec 'acme' is invalid",
                "details": {"problems": ["'base_url' is required", "missing 'offers'"]},
            }
        }
    ).encode("utf-8")

    def boom(request, timeout=None):
        raise urllib.error.HTTPError(
            request.full_url, 400, "Bad Request", {}, io.BytesIO(body)
        )

    monkeypatch.setattr(client_module.urllib.request, "urlopen", boom)
    instance = client_module.CloudOffloadClient("http://coordinator.invalid")

    with pytest.raises(client_module.CloudOffloadError) as excinfo:
        instance.validate_provider_spec({"name": "acme"})

    message = str(excinfo.value)
    assert "Provider spec 'acme' is invalid" in message
    assert "'base_url' is required; missing 'offers'" in message


# === Hugging Face token (write-only, proxied like provider credentials) ===

def test_provider_action_posts_the_huggingface_token(monkeypatch):
    calls = []

    def fake_json(self, method, path, payload=None, **kwargs):
        calls.append((method, path, payload))
        return {"provider": "huggingface", "configured": True}

    monkeypatch.setattr(client_module.CloudOffloadClient, "_json", fake_json)
    instance = client_module.CloudOffloadClient("http://coordinator.invalid")

    payload = instance.provider_action(
        "huggingface", "credentials", {"api_key": "hf-token"}
    )

    # The coordinator answers with a boolean only; the token never echoes back.
    assert payload == {"provider": "huggingface", "configured": True}
    assert calls == [
        ("POST", "/api/providers/huggingface/credentials", {"api_key": "hf-token"})
    ]


def test_provider_action_rejects_unknown_actions(monkeypatch):
    monkeypatch.setattr(
        client_module.CloudOffloadClient,
        "_json",
        lambda self, method, path, **kwargs: pytest.fail("must not reach the wire"),
    )
    instance = client_module.CloudOffloadClient("http://coordinator.invalid")

    with pytest.raises(CloudOffloadError, match="Unsupported provider action"):
        instance.provider_action("huggingface", "delete-everything")


# === Coordinator config (UI-editable policy) ===

def test_config_client_reads_and_patches(monkeypatch):
    calls = []

    def fake_json(self, method, path, payload=None, **kwargs):
        calls.append((method, path, payload))
        if method == "GET":
            return {"cloud": {"max_hourly_rate": 1.0, "enabled": True}}
        return {"cloud": {"max_hourly_rate": payload["max_hourly_rate"]}}

    monkeypatch.setattr(client_module.CloudOffloadClient, "_json", fake_json)
    instance = client_module.CloudOffloadClient("http://coordinator.invalid")

    assert instance.get_config()["cloud"]["max_hourly_rate"] == 1.0
    result = instance.update_config({"max_hourly_rate": 1.5})

    assert result["cloud"]["max_hourly_rate"] == 1.5
    assert calls == [
        ("GET", "/api/config", None),
        ("POST", "/api/config", {"max_hourly_rate": 1.5}),
    ]


def test_config_client_round_trips_on_prem_asset_patterns(monkeypatch):
    """The residency policy rides the existing config proxy path unchanged.

    The queue-time compiler reads ``on_prem_assets`` from GET /api/config and
    the provider dialog writes it back through POST, exactly like the other
    non-secret policy fields.
    """
    calls = []

    def fake_json(self, method, path, payload=None, **kwargs):
        calls.append((method, path, payload))
        if method == "GET":
            return {"cloud": {"on_prem_assets": ["studiox_*.safetensors"]}}
        return {"config": {"on_prem_assets": payload["on_prem_assets"]}}

    monkeypatch.setattr(client_module.CloudOffloadClient, "_json", fake_json)
    instance = client_module.CloudOffloadClient("http://coordinator.invalid")

    assert instance.get_config()["cloud"]["on_prem_assets"] == [
        "studiox_*.safetensors"
    ]
    result = instance.update_config(
        {"on_prem_assets": ["studiox_*.safetensors", "nda_*"]}
    )

    assert result["config"]["on_prem_assets"] == ["studiox_*.safetensors", "nda_*"]
    assert calls == [
        ("GET", "/api/config", None),
        ("POST", "/api/config", {"on_prem_assets": ["studiox_*.safetensors", "nda_*"]}),
    ]
