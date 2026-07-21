"""HTTP client for the standalone Cloud Offload coordinator service.

This module owns everything the partition system needs to talk to the
coordinator (repo ``cloud-offload``, Python package ``cloud_offload``): service
discovery, the thin HTTP client, artifact upload/download, job polling, and the
file-artifact restore helpers used when a cloud partition returns a mesh or a
3D file.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import socket
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional


OLLAMA_PORT = 11434
DEFAULT_COORDINATOR_PORT = 11435
SERVICE_NAME = "cloud-offload"
URL_ENV = "CLOUD_OFFLOAD_URL"
TOKEN_ENV = "CLOUD_OFFLOAD_TOKEN"
SERVICE_FILE_ENV = "CLOUD_OFFLOAD_SERVICE_FILE"
HEALTH_TIMEOUT = 0.1
PARTITION_MEDIA_TYPE = "application/vnd.comfy.partition+zip"
# Fallback only. The selectable list is discovered from the coordinator's
# /api/providers route so that plugin-registered connectors appear without a
# node-pack release; this is used when the coordinator is unreachable.
FALLBACK_PROVIDERS = ["auto", "runpod", "vast.ai"]
PROVIDER_CACHE_SECONDS = 30


class CloudOffloadError(RuntimeError):
    """Raised when the Cloud Offload coordinator is unavailable or rejects a request."""


def _url_port(url: str) -> int | None:
    parsed = urllib.parse.urlparse(url)
    if parsed.port is not None:
        return parsed.port
    if parsed.scheme == "http":
        return 80
    if parsed.scheme == "https":
        return 443
    return None


def _normalize_url(url: str, source: str) -> str:
    normalized = url.rstrip("/")
    if _url_port(normalized) == OLLAMA_PORT:
        raise RuntimeError(
            f"{source} resolves to port {OLLAMA_PORT}, which is reserved for Ollama"
        )
    return normalized


def _read_token(path: str | None = None) -> str | None:
    configured = os.environ.get(TOKEN_ENV)
    if configured:
        return configured.strip()
    if not path:
        return None
    try:
        token = Path(path).expanduser().read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return token or None


def _is_healthy(url: str, token: str | None = None) -> bool:
    request = urllib.request.Request(
        f"{_normalize_url(url, 'Cloud Offload coordinator')}/api/health"
    )
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=HEALTH_TIMEOUT) as response:
            if response.status != 200:
                return False
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return False
    return payload.get("name") == SERVICE_NAME and payload.get("status") == "ok"


def discover_service(require_healthy: bool = False) -> Dict[str, Any]:
    """Resolve the coordinator URL and token.

    Discovery order: ``CLOUD_OFFLOAD_URL`` env var, then
    ``~/.cloud-offload/service.json``, then the localhost default. Port
    ``11434`` (Ollama) is never used.
    """
    configured = os.environ.get(URL_ENV)
    if configured:
        url = _normalize_url(configured, URL_ENV)
        token = _read_token()
        if require_healthy and not _is_healthy(url, token):
            raise RuntimeError(f"Cloud Offload coordinator is not healthy at {url}")
        return {"url": url, "token": token}

    service_file = Path(
        os.environ.get(
            SERVICE_FILE_ENV, Path.home() / ".cloud-offload" / "service.json"
        )
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
            url = _normalize_url(service_info["url"], str(service_file))
            token = _read_token(service_info.get("token_path"))
            if not require_healthy or _is_healthy(url, token):
                return {"url": url, "token": token}
    except FileNotFoundError:
        pass
    except json.JSONDecodeError:
        pass

    if require_healthy:
        raise RuntimeError("No healthy Cloud Offload coordinator found")

    return {"url": f"http://127.0.0.1:{DEFAULT_COORDINATOR_PORT}", "token": None}


def discover_url() -> str:
    return discover_service()["url"]


def _throw_if_processing_interrupted() -> None:
    """Forward ComfyUI cancellation to the coordinator without requiring ComfyUI in tests."""
    try:
        import comfy.model_management
    except ImportError:
        return
    comfy.model_management.throw_exception_if_processing_interrupted()


def _file_3d_glb(path: Path):
    try:
        from comfy_api.latest import Types
    except ImportError:
        return str(path)
    return Types.File3D(str(path), "glb")


class CloudMeshArtifact:
    """File-backed mesh object restored from a cloud partition result."""

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


class CloudOffloadClient:
    """Small HTTP client for the Cloud Offload coordinator service.

    Only the client-facing coordinator routes are used: ``/api/health``,
    ``/api/status``, ``/api/partitions``, ``/api/workflows``,
    ``/api/artifacts[/{id}]``, and ``/api/jobs/{id}[/events|/cancel]``.
    """

    def __init__(self, base_url: Optional[str] = None, timeout: int = 600):
        self._configured_base_url = base_url
        self.token: Optional[str] = _read_token() if base_url else None
        self.base_url = (
            _normalize_url(base_url, "CloudOffloadClient")
            if base_url
            else discover_url()
        )
        self.timeout = timeout
        self._provider_cache: tuple[float, list[str]] | None = None

    def _refresh_base_url(self) -> None:
        if self._configured_base_url is None:
            # Do not health-gate every request. The request itself remains the
            # authoritative availability check.
            service = discover_service(require_healthy=False)
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
            raise CloudOffloadError(str(exc)) from exc
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
                error = payload.get("error", {})
                detail = error.get("message") or payload.get("detail", detail)
                # The coordinator puts actionable lists (provider spec problems,
                # for one) in details rather than the message; carry them across
                # so the caller can show what actually went wrong.
                problems = (error.get("details") or {}).get("problems")
                if isinstance(problems, list) and problems:
                    detail = f"{detail}: " + "; ".join(str(item) for item in problems)
            except Exception:
                pass
            raise CloudOffloadError(f"Cloud Offload coordinator error: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, socket.timeout) as exc:
            reason = getattr(exc, "reason", exc)
            raise CloudOffloadError(
                f"Cloud Offload coordinator unavailable at {self.base_url}: {reason}"
            ) from exc

    # -- Health / status -------------------------------------------------

    def health(self) -> Dict[str, Any]:
        return self._json("GET", "/api/health", timeout=10)

    def status(self) -> Dict[str, Any]:
        return self._json("GET", "/api/status", timeout=15)

    def providers(self) -> Dict[str, Any]:
        return self._json("GET", "/api/providers", timeout=15)

    def provider_action(
        self, provider: str, action: str, payload: Dict[str, Any] | None = None
    ) -> Dict[str, Any]:
        """Administer one connector: credentials, settings, or a test probe."""
        if action not in {"credentials", "settings", "test"}:
            raise CloudOffloadError(f"Unsupported provider action: {action}")
        return self._json(
            "POST",
            f"/api/providers/{urllib.parse.quote(provider)}/{action}",
            payload=payload or {},
            timeout=30,
        )

    # -- Declarative provider specs --------------------------------------

    def provider_specs(self) -> Dict[str, Any]:
        """List the declarative provider specs the coordinator has on disk."""
        return self._json("GET", "/api/providers/specs", timeout=15)

    def provider_spec(self, name: str) -> Dict[str, Any]:
        """Fetch one provider spec by name."""
        return self._json(
            "GET", f"/api/providers/specs/{urllib.parse.quote(name, safe='')}", timeout=15
        )

    def save_provider_spec(self, name: str, spec: Dict[str, Any]) -> Dict[str, Any]:
        """Create or replace a provider spec. The coordinator validates first."""
        return self._json(
            "PUT",
            f"/api/providers/specs/{urllib.parse.quote(name, safe='')}",
            payload=spec,
            timeout=30,
        )

    def delete_provider_spec(self, name: str) -> Dict[str, Any]:
        """Delete a user provider spec."""
        return self._json(
            "DELETE", f"/api/providers/specs/{urllib.parse.quote(name, safe='')}", timeout=15
        )

    def validate_provider_spec(self, spec: Dict[str, Any]) -> Dict[str, Any]:
        """Check a spec without writing it or contacting the provider."""
        return self._json(
            "POST", "/api/providers/specs/validate", payload=spec, timeout=15
        )

    def dry_run_provider_spec(
        self, spec: Dict[str, Any], api_key: Optional[str] = None
    ) -> Dict[str, Any]:
        """Probe a spec's offers endpoint before saving it.

        Read-only on the provider's side. ``api_key`` is passed through for that
        one probe; the coordinator neither stores nor echoes it, and ComfyUI
        never writes it anywhere.
        """
        payload: Dict[str, Any] = {"spec": spec}
        if api_key:
            payload["api_key"] = api_key
        return self._json(
            "POST", "/api/providers/specs/dry-run", payload=payload, timeout=60
        )

    def provider_names(self) -> list[str]:
        """Selectable provider names, newest registry state first.

        Node definitions are built at import time, so a failure here must not
        break node registration: fall back to the built-in names.
        """
        now = time.monotonic()
        cached = self._provider_cache
        if cached and now - cached[0] < PROVIDER_CACHE_SECONDS:
            return list(cached[1])
        try:
            payload = self.providers()
            names = [
                str(entry["provider"])
                for entry in payload.get("providers") or []
                if entry.get("provider")
            ]
        except Exception:
            names = []
        resolved = ["auto", *dict.fromkeys(names)] if names else list(FALLBACK_PROVIDERS)
        self._provider_cache = (now, resolved)
        return list(resolved)

    # -- Job submission --------------------------------------------------

    def submit_workflow(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._json("POST", "/api/workflows", payload=payload, timeout=30)

    def submit_partition(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._json("POST", "/api/partitions", payload=payload, timeout=30)

    # -- Artifacts -------------------------------------------------------

    def upload_partition_artifact(self, path: str | Path) -> Dict[str, Any]:
        """Stream a bundle to the coordinator without base64 or loading it all into memory."""
        import requests

        self._refresh_base_url()
        path = Path(path)
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        with path.open("rb") as handle:
            response = requests.post(
                self._url("/api/artifacts"),
                headers=self._headers({"Accept": "application/json"}),
                data={"sha256": digest.hexdigest()},
                files={"file": (path.name, handle, PARTITION_MEDIA_TYPE)},
                timeout=max(120, self.timeout),
            )
        if not response.ok:
            raise CloudOffloadError(f"Cloud Offload artifact upload failed: {response.text}")
        return response.json()

    def download_partition_artifact(self, artifact_id: str, path: str | Path) -> Path:
        """Stream and verify a content-addressed bundle from the coordinator."""
        import requests

        self._refresh_base_url()
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        response = requests.get(
            self._url(f"/api/artifacts/{urllib.parse.quote(artifact_id)}"),
            headers=self._headers({"Accept": PARTITION_MEDIA_TYPE}),
            stream=True,
            timeout=max(120, self.timeout),
        )
        if not response.ok:
            raise CloudOffloadError(f"Cloud Offload artifact download failed: {response.text}")
        digest = hashlib.sha256()
        with path.open("wb") as handle:
            for chunk in response.iter_content(1024 * 1024):
                if chunk:
                    digest.update(chunk)
                    handle.write(chunk)
        if digest.hexdigest() != artifact_id:
            path.unlink(missing_ok=True)
            raise CloudOffloadError(f"Cloud Offload artifact digest mismatch: {artifact_id}")
        return path

    # -- Jobs ------------------------------------------------------------

    def job_status(self, job_id: str) -> Dict[str, Any]:
        return self._json(
            "GET", f"/api/jobs/{urllib.parse.quote(job_id)}", timeout=10
        )

    def job_events(self, job_id: str, after: int = 0, limit: int = 200) -> Dict[str, Any]:
        return self._json(
            "GET",
            f"/api/jobs/{urllib.parse.quote(job_id)}/events",
            query={"after": max(0, int(after)), "limit": int(limit)},
            timeout=10,
        )

    def cancel_job(self, job_id: str) -> Dict[str, Any]:
        return self._json(
            "POST", f"/api/jobs/{urllib.parse.quote(job_id)}/cancel", timeout=10
        )

    # -- High-level flows ------------------------------------------------

    def run_comfyui_workflow(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Submit and wait for a whole API-format workflow on a cloud runner."""
        job = self.submit_workflow(payload)
        job_id = job["job_id"]
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                _throw_if_processing_interrupted()
            except Exception:
                try:
                    self.cancel_job(job_id)
                finally:
                    raise
            status = self.job_status(job_id)
            state = status.get("status")
            if state == "completed":
                return status.get("result") or {}
            if state in {"failed", "dead_letter"}:
                raise CloudOffloadError(
                    status.get("error") or "Cloud workflow failed"
                )
            if state in {"cancelled", "cancel_requested"}:
                raise CloudOffloadError("Cloud workflow was cancelled")
            if time.monotonic() >= deadline:
                raise CloudOffloadError(
                    f"Timed out waiting for cloud workflow {job_id}"
                )
            time.sleep(1)

    def run_comfyui_partition(
        self,
        partition: Dict[str, Any],
        boundary_values: Dict[str, Any],
        *,
        provider: str = "auto",
        timeout_seconds: int = 3600,
        progress_callback: Any | None = None,
    ) -> Dict[str, Any]:
        """Serialize inputs, execute a compiled partition, and restore outputs."""
        try:
            from .partition_protocol import dump_bundle, load_bundle
        except ImportError:
            from partition_protocol import dump_bundle, load_bundle

        with tempfile.TemporaryDirectory(prefix="cloud-offload-partition-") as temporary:
            root = Path(temporary)
            input_artifacts: Dict[str, str] = {}
            for boundary_key, value in boundary_values.items():
                path = root / f"{boundary_key}.part"
                dump_bundle(value, path)
                uploaded = self.upload_partition_artifact(path)
                input_artifacts[boundary_key] = uploaded["artifact_id"]
            job = self.submit_partition(
                {
                    "partition": partition,
                    "input_artifacts": input_artifacts,
                    "provider": provider,
                    "timeout_seconds": int(timeout_seconds),
                }
            )
            job_id = job["job_id"]
            deadline = time.monotonic() + int(timeout_seconds)
            event_cursor = 0
            while True:
                try:
                    _throw_if_processing_interrupted()
                except Exception:
                    try:
                        self.cancel_job(job_id)
                    finally:
                        raise
                status = self.job_status(job_id)
                try:
                    event_page = self.job_events(job_id, event_cursor)
                    for item in event_page.get("events") or []:
                        event_cursor = max(event_cursor, int(item.get("sequence") or 0))
                        if progress_callback is not None:
                            progress_callback(
                                {
                                    **(item.get("event") or {}),
                                    "sequence": item.get("sequence"),
                                    "created_at": item.get("created_at"),
                                    "job_id": job_id,
                                }
                            )
                    next_after = event_page.get("next_after")
                    if isinstance(next_after, int):
                        event_cursor = max(event_cursor, next_after)
                except CloudOffloadError:
                    # Status completion remains authoritative; a transient event-page
                    # read is retried on the next poll from the last durable cursor.
                    pass
                state = status.get("status")
                if state == "completed":
                    result = status.get("result") or {}
                    values = {}
                    for boundary_key, artifact_id in (result.get("output_artifacts") or {}).items():
                        path = root / f"result-{boundary_key}.part"
                        self.download_partition_artifact(artifact_id, path)
                        values[boundary_key] = load_bundle(path)
                    return {**result, "values": values, "job_id": job_id}
                if state in {"failed", "dead_letter"}:
                    raise CloudOffloadError(status.get("error") or "Cloud partition failed")
                if time.monotonic() >= deadline:
                    raise CloudOffloadError(f"Cloud partition {job_id} exceeded {timeout_seconds}s")
                time.sleep(1)


client = CloudOffloadClient()
