"""Declared asset manifest for a Cloud Offload partition.

The queue-time compiler runs in the browser: it can see the prompt, but it
cannot ask ComfyUI which strings name model files and it cannot hash gigabytes
of weights. This module is the server side of that gap. It turns the plain
widget strings inside a boxed subgraph into a content-addressed manifest — every
model file the partition really references, with its sha256 — so the coordinator
can decide whether a runner can be given those exact bytes *before* a GPU is
rented.

``classify_assets`` is deliberately pure: no filesystem, no network, no
``folder_paths``. Everything impure lives in ``build_manifest``, which is only
importable inside a running ComfyUI.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote, urlparse

logger = logging.getLogger(__name__)

# Suffixes that make a string model-shaped. A value carrying one of these but
# absent from every folder_paths category is the dangerous case: the graph
# believes it names a model, and this ComfyUI cannot say which one.
MODEL_SUFFIXES = (
    ".safetensors",
    ".ckpt",
    ".pth",
    ".pt",
    ".bin",
    ".gguf",
    ".onnx",
)

# Serialization families, reported so a runner (or an operator) can tell a
# tensor-only file from one that will hand a pickle to torch.load.
_SAFETENSORS_SUFFIXES = frozenset({".safetensors"})
_PICKLE_SUFFIXES = frozenset({".ckpt", ".pth", ".pt", ".bin"})

DIGEST_CACHE_FILENAME = "asset-digests.json"
_DIGEST_CHUNK_BYTES = 4 * 1024 * 1024


def _normalize(value: str) -> str:
    """Fold a filename to its comparison form.

    ComfyUI lists nested model files with the host separator, while a workflow
    saved on another platform carries the other one; the same file must not look
    like two.
    """
    return str(value).replace("\\", "/").strip().lower()


def is_model_shaped(value: str) -> bool:
    """Whether a string looks like it names a model file."""
    return _normalize(value).endswith(MODEL_SUFFIXES)


def asset_format(filename: str) -> str:
    """Serialization family of a model file, by suffix."""
    suffix = Path(_normalize(filename)).suffix
    if suffix in _SAFETENSORS_SUFFIXES:
        return "safetensors"
    if suffix in _PICKLE_SUFFIXES:
        return "pickle"
    return "other"


def classify_assets(
    prompt: dict[str, Any],
    member_ids: Iterable[Any],
    filename_lists: dict[str, Iterable[str]],
) -> dict[str, list[dict[str, Any]]]:
    """Match a boxed subgraph's string inputs against the known model files.

    ``filename_lists`` maps a ``folder_paths`` category to the filenames it
    offers. Only plain strings are considered: an input of the form
    ``[node_id, slot]`` is a link to another node, never an asset name.

    The rule is closed-world. A string that matches no category but *looks* like
    a model file is reported in ``unknown`` rather than ignored, because an
    incomplete manifest is worse than no manifest: it converts an honest
    post-provision failure into a confident green light followed by a paid one.
    A string in several categories is still an asset, tagged with
    ``ambiguous_categories`` so the ambiguity is visible instead of guessed at.
    """
    lookups = {
        str(category): {_normalize(name) for name in names or ()}
        for category, names in (filename_lists or {}).items()
    }
    assets: list[dict[str, Any]] = []
    unknown: list[dict[str, Any]] = []
    introduced: set[tuple[str, str]] = set()

    for member_id in member_ids or ():
        node_id = str(member_id)
        node = (prompt or {}).get(node_id) or {}
        for input_name, value in (node.get("inputs") or {}).items():
            if not isinstance(value, str) or not value.strip():
                continue
            normalized = _normalize(value)
            categories = sorted(
                category for category, names in lookups.items() if normalized in names
            )
            if not categories:
                if is_model_shaped(value):
                    unknown.append(
                        {
                            "node_id": node_id,
                            "input_name": str(input_name),
                            "value": value,
                        }
                    )
                continue
            identity = (categories[0], normalized)
            if identity in introduced:
                continue
            introduced.add(identity)
            asset: dict[str, Any] = {
                "node_id": node_id,
                "input_name": str(input_name),
                "category": categories[0],
                "filename": value,
            }
            if len(categories) > 1:
                asset["ambiguous_categories"] = categories
            assets.append(asset)

    return {"assets": assets, "unknown": unknown}


def digest_cache_path() -> Path:
    """Where the sha256 cache lives.

    ComfyUI's user directory is the right home — it survives a node pack
    reinstall and is already the place per-install state belongs. Outside
    ComfyUI (or on a build too old to expose it) the file sits beside the pack,
    which is throwaway state either way: a lost cache costs one rehash.
    """
    try:
        import folder_paths

        user_directory = folder_paths.get_user_directory()
    except Exception:  # pragma: no cover - outside ComfyUI
        return Path(__file__).parent / f".{DIGEST_CACHE_FILENAME}"
    return Path(user_directory) / "cloud_offload" / DIGEST_CACHE_FILENAME


def load_digest_cache(path: Path | None = None) -> dict[str, dict[str, Any]]:
    """Read the persisted digest cache, treating any damage as a cold cache."""
    cache_path = Path(path) if path else digest_cache_path()
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        str(key): value
        for key, value in data.items()
        if isinstance(value, dict) and value.get("sha256")
    }


def save_digest_cache(cache: dict[str, dict[str, Any]], path: Path | None = None) -> None:
    """Persist the digest cache, never failing a manifest over it."""
    cache_path = Path(path) if path else digest_cache_path()
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(cache, indent=2, sort_keys=True), encoding="utf-8")
    except OSError as exc:  # pragma: no cover - a read-only install still works
        logger.warning("Cloud Offload could not persist the asset digest cache: %s", exc)


def digest_file(path: str | Path, cache: dict[str, dict[str, Any]]) -> str:
    """Return a file's sha256, reusing ``cache`` while size and mtime hold.

    Hashing a multi-gigabyte checkpoint on every queue is not affordable, so the
    cache is keyed by path and invalidated by ``(size, mtime_ns)``: the pair that
    changes whenever the bytes are rewritten in place, including by a
    same-length overwrite.
    """
    file_path = Path(path)
    stat = file_path.stat()
    key = str(file_path.resolve())
    entry = cache.get(key)
    if (
        isinstance(entry, dict)
        and entry.get("size") == stat.st_size
        and entry.get("mtime_ns") == stat.st_mtime_ns
    ):
        return str(entry["sha256"])

    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(_DIGEST_CHUNK_BYTES), b""):
            digest.update(chunk)
    sha256 = digest.hexdigest()
    cache[key] = {"sha256": sha256, "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}
    return sha256


def _huggingface_token() -> str | None:
    token = os.environ.get("HF_TOKEN", "").strip()
    if token:
        return token
    token = os.environ.get("CLOUD_OFFLOAD_HUGGINGFACE_API_KEY", "").strip()
    if token:
        return token
    try:
        import keyring

        return keyring.get_password("cloud-offload", "huggingface") or None
    except Exception:
        return None


def parse_huggingface_url(url: str) -> tuple[str, str, str]:
    """Return ``(repo_id, revision, filename)`` for a Hub resolve URL."""
    parsed = urlparse(str(url))
    parts = [unquote(part) for part in parsed.path.strip("/").split("/")]
    if parsed.hostname not in {"huggingface.co", "www.huggingface.co"}:
        raise ValueError("model source is not a huggingface.co URL")
    if len(parts) < 5 or parts[2] != "resolve":
        raise ValueError("model source is not a Hugging Face resolve URL")
    return "/".join(parts[:2]), parts[3], "/".join(parts[4:])


def resolve_huggingface_source(source: dict[str, Any]) -> dict[str, Any]:
    """Resolve a workflow model URL to its immutable Hub identity."""
    import huggingface_hub

    repo_id, revision, filename = parse_huggingface_url(source["url"])
    info = huggingface_hub.HfApi(token=_huggingface_token()).model_info(
        repo_id, revision=revision, files_metadata=True
    )
    sibling = next(
        (item for item in info.siblings if item.rfilename == filename), None
    )
    lfs = getattr(sibling, "lfs", None)
    sha256 = getattr(lfs, "sha256", None)
    size = getattr(lfs, "size", None)
    if not sibling or not sha256 or size is None:
        raise ValueError(f"{filename} has no LFS sha256 metadata")
    return {
        "category": str(source["directory"]),
        "filename": str(source["name"]),
        "sha256": str(sha256),
        "size": int(size),
        "format": asset_format(str(source["name"])),
    }


def remote_assets(
    unknown: Iterable[dict[str, Any]],
    model_sources: Iterable[dict[str, Any]],
    resolver=resolve_huggingface_source,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Resolve missing local models that carry downloadable workflow metadata."""
    catalog = {
        _normalize(source.get("name", "")): source
        for source in model_sources or ()
        if isinstance(source, dict)
        and source.get("name")
        and source.get("url")
        and source.get("directory")
    }
    assets: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    resolved: dict[str, dict[str, Any]] = {}
    introduced: set[tuple[str, str]] = set()
    for entry in unknown:
        source = catalog.get(_normalize(entry.get("value", "")))
        if not source:
            unresolved.append(entry)
            continue
        key = str(source["url"])
        try:
            if key not in resolved:
                resolved[key] = resolver(source)
            asset = resolved[key]
        except Exception as exc:
            unresolved.append({**entry, "reason": f"model source metadata unavailable: {exc}"})
            continue
        identity = (asset["category"], _normalize(asset["filename"]))
        if identity not in introduced:
            introduced.add(identity)
            assets.append(dict(asset))
    return assets, unresolved


def build_manifest(
    prompt: dict[str, Any],
    member_ids: Iterable[Any],
    model_sources: Iterable[dict[str, Any]] = (),
) -> dict[str, list[dict[str, Any]]]:
    """Classify, resolve and digest every model file a boxed subgraph declares.

    The impure half: reads the live ``folder_paths`` registry, touches disk, and
    hashes. Returns assets stripped down to the content identity the coordinator
    routes on, plus everything this ComfyUI could not vouch for.
    """
    import folder_paths

    filename_lists: dict[str, list[str]] = {}
    for category in list(folder_paths.folder_names_and_paths):
        try:
            filename_lists[category] = folder_paths.get_filename_list(category)
        except Exception as exc:
            # One unreadable category must not blind the whole manifest; a file
            # it would have matched still surfaces as unknown and blocks.
            logger.warning("Cloud Offload could not list %s model files: %s", category, exc)

    classified = classify_assets(prompt, member_ids, filename_lists)
    cache = load_digest_cache()
    snapshot = dict(cache)
    assets: list[dict[str, Any]] = []
    remote, unknown = remote_assets(classified["unknown"], model_sources)
    assets.extend(remote)

    for entry in classified["assets"]:
        category = entry["category"]
        filename = entry["filename"]
        full_path = folder_paths.get_full_path(category, filename)
        if not full_path or not Path(full_path).is_file():
            unknown.append(
                {
                    "node_id": entry["node_id"],
                    "input_name": entry["input_name"],
                    "value": filename,
                    "reason": f"listed under {category} but missing on disk",
                }
            )
            continue
        asset: dict[str, Any] = {
            "category": category,
            "filename": filename,
            "sha256": digest_file(full_path, cache),
            "size": Path(full_path).stat().st_size,
            "format": asset_format(filename),
        }
        if entry.get("ambiguous_categories"):
            asset["ambiguous_categories"] = entry["ambiguous_categories"]
        assets.append(asset)

    if cache != snapshot:
        save_digest_cache(cache)
    return {"assets": assets, "unknown": unknown}
