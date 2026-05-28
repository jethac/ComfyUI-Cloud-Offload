import importlib.util
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
    statuses = iter([
        {"status": "queued", "progress": 0},
        {"status": "running", "progress": 50},
        {"status": "completed", "progress": 100},
    ])

    monkeypatch.setattr(client, "create_job", lambda payload: {"job_id": "job-1"})
    monkeypatch.setattr(client, "job_status", lambda job_id: next(statuses))
    monkeypatch.setattr(client, "job_result", lambda job_id: {"seed": 42})
    monkeypatch.setattr(nodes.time, "sleep", lambda seconds: None)

    assert client.generate_job({"model": "hunyuan3d-2.1-turbo"}) == {"seed": 42}


def test_generate_job_raises_on_failed_job(monkeypatch):
    nodes = load_nodes_module()
    client = nodes.KaoClient(base_url="http://127.0.0.1:11501")

    monkeypatch.setattr(client, "create_job", lambda payload: {"job_id": "job-1"})
    monkeypatch.setattr(client, "job_status", lambda job_id: {"status": "failed", "error": "boom"})

    try:
        client.generate_job({"model": "hunyuan3d-2.1-turbo"})
    except nodes.KaoServiceError as exc:
        assert "boom" in str(exc)
    else:
        raise AssertionError("Expected KaoServiceError")
