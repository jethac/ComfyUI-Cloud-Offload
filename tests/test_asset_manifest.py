"""Declared asset manifest: classification, the closed-world rule, digests.

Classification is pure, so these tests never need a ComfyUI: they hand
``classify_assets`` the filename lists ``folder_paths`` would have produced. The
digest tests use throwaway files — never a real checkpoint.
"""

import hashlib
import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import asset_manifest


FILENAME_LISTS = {
    "checkpoints": ["sd_xl_base_1.0.safetensors", "SDXL/refiner.safetensors"],
    "loras": ["detail_tweaker.safetensors", "shared.safetensors"],
    "upscale_models": ["4x-UltraSharp.pth", "shared.safetensors"],
}


def prompt_fixture():
    return {
        "1": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": "sd_xl_base_1.0.safetensors"},
        },
        "2": {
            "class_type": "LoraLoader",
            "inputs": {
                "model": ["1", 0],
                "lora_name": "detail_tweaker.safetensors",
                "strength_model": 0.8,
            },
        },
        "3": {
            "class_type": "CLIPTextEncode",
            "inputs": {"clip": ["1", 1], "text": "a hero shot, 4x-UltraSharp lighting"},
        },
        "4": {
            "class_type": "UpscaleModelLoader",
            "inputs": {"model_name": "4x-UltraSharp.pth"},
        },
    }


# === Classification ===

def test_classifies_assets_across_categories():
    result = asset_manifest.classify_assets(
        prompt_fixture(), ["1", "2", "3", "4"], FILENAME_LISTS
    )

    assert result["unknown"] == []
    assert result["assets"] == [
        {
            "node_id": "1",
            "input_name": "ckpt_name",
            "category": "checkpoints",
            "filename": "sd_xl_base_1.0.safetensors",
        },
        {
            "node_id": "2",
            "input_name": "lora_name",
            "category": "loras",
            "filename": "detail_tweaker.safetensors",
        },
        {
            "node_id": "4",
            "input_name": "model_name",
            "category": "upscale_models",
            "filename": "4x-UltraSharp.pth",
        },
    ]


def test_only_members_are_inspected():
    result = asset_manifest.classify_assets(prompt_fixture(), ["1"], FILENAME_LISTS)

    assert [asset["filename"] for asset in result["assets"]] == [
        "sd_xl_base_1.0.safetensors"
    ]


def test_link_arrays_are_never_assets():
    prompt = {
        "1": {"class_type": "L", "inputs": {"model": ["9", 0], "clip": [9, 1]}},
    }

    assert asset_manifest.classify_assets(prompt, ["1"], FILENAME_LISTS) == {
        "assets": [],
        "unknown": [],
    }


def test_text_prompts_and_images_are_ignored():
    # A text widget mentioning a model name is not a reference, and an image
    # filename is not model-shaped, so neither reaches the manifest.
    prompt = {
        "1": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": "shot in the style of shared"},
        },
        "2": {"class_type": "LoadImage", "inputs": {"image": "plate.png"}},
    }

    assert asset_manifest.classify_assets(prompt, ["1", "2"], FILENAME_LISTS) == {
        "assets": [],
        "unknown": [],
    }


def test_model_shaped_but_unlisted_values_are_unknown():
    prompt = {
        "7": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": "StudioX_Hero.SAFETENSORS"},
        },
        "8": {"class_type": "GGUFLoader", "inputs": {"model": "llm-q4.gguf"}},
    }

    result = asset_manifest.classify_assets(prompt, ["7", "8"], FILENAME_LISTS)

    assert result["assets"] == []
    assert result["unknown"] == [
        {"node_id": "7", "input_name": "ckpt_name", "value": "StudioX_Hero.SAFETENSORS"},
        {"node_id": "8", "input_name": "model", "value": "llm-q4.gguf"},
    ]


def test_a_filename_in_two_categories_is_flagged_not_guessed():
    prompt = {"1": {"class_type": "LoraLoader", "inputs": {"lora_name": "shared.safetensors"}}}

    result = asset_manifest.classify_assets(prompt, ["1"], FILENAME_LISTS)

    assert result["assets"] == [
        {
            "node_id": "1",
            "input_name": "lora_name",
            "category": "loras",
            "filename": "shared.safetensors",
            "ambiguous_categories": ["loras", "upscale_models"],
        }
    ]


def test_repeated_references_keep_the_introducing_site():
    prompt = {
        "1": {"class_type": "LoraLoader", "inputs": {"lora_name": "detail_tweaker.safetensors"}},
        "2": {"class_type": "LoraLoader", "inputs": {"lora_name": "detail_tweaker.safetensors"}},
    }

    result = asset_manifest.classify_assets(prompt, ["1", "2"], FILENAME_LISTS)

    assert len(result["assets"]) == 1
    assert result["assets"][0]["node_id"] == "1"


def test_nested_filenames_match_across_separator_styles():
    # A workflow authored on Linux names the file with a forward slash; the same
    # install lists it with the host separator. One file, not two.
    prompt = {"1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "SDXL\\refiner.safetensors"}}}

    result = asset_manifest.classify_assets(prompt, ["1"], FILENAME_LISTS)

    assert result["unknown"] == []
    assert result["assets"][0]["category"] == "checkpoints"


def test_format_is_reported_by_suffix():
    assert asset_manifest.asset_format("model.safetensors") == "safetensors"
    assert asset_manifest.asset_format("model.PTH") == "pickle"
    assert asset_manifest.asset_format("model.onnx") == "other"


# === Digest cache ===

def test_digest_cache_reuses_an_unchanged_file(tmp_path: Path):
    path = tmp_path / "weights.safetensors"
    path.write_bytes(b"tensor bytes")
    cache: dict = {}

    first = asset_manifest.digest_file(path, cache)
    # Rewrite the same number of bytes and restore the mtime: the cache key is
    # unchanged, so a second call must answer from the cache rather than rehash.
    entry = cache[str(path.resolve())]
    path.write_bytes(b"OTHER  bytes")
    os.utime(path, ns=(entry["mtime_ns"], entry["mtime_ns"]))

    assert asset_manifest.digest_file(path, cache) == first


def test_digest_cache_recomputes_when_the_file_changes(tmp_path: Path):
    path = tmp_path / "weights.safetensors"
    path.write_bytes(b"tensor bytes")
    cache: dict = {}
    first = asset_manifest.digest_file(path, cache)

    time.sleep(0.01)
    path.write_bytes(b"different bytes")
    second = asset_manifest.digest_file(path, cache)

    assert second != first
    assert cache[str(path.resolve())]["sha256"] == second


def test_digest_cache_round_trips_through_json(tmp_path: Path):
    path = tmp_path / "weights.safetensors"
    path.write_bytes(b"tensor bytes")
    cache_path = tmp_path / "asset-digests.json"
    cache: dict = {}
    digest = asset_manifest.digest_file(path, cache)

    asset_manifest.save_digest_cache(cache, cache_path)
    restored = asset_manifest.load_digest_cache(cache_path)

    assert restored == cache
    assert asset_manifest.digest_file(path, restored) == digest


def test_a_damaged_cache_file_reads_as_cold(tmp_path: Path):
    cache_path = tmp_path / "asset-digests.json"
    cache_path.write_text("{not json", encoding="utf-8")

    assert asset_manifest.load_digest_cache(cache_path) == {}
    assert asset_manifest.load_digest_cache(tmp_path / "absent.json") == {}


# === The impure wrapper, against a stand-in folder_paths ===

def fake_folder_paths(tmp_path: Path, present=("checkpoints/base.safetensors",)):
    """A folder_paths stand-in backed by files under ``tmp_path``."""
    models = tmp_path / "models"
    listed = {
        "checkpoints": ["base.safetensors", "ghost.safetensors"],
        "loras": ["detail.safetensors"],
    }
    for relative in present:
        path = models / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"weights for " + relative.encode())

    def get_full_path(category, filename):
        path = models / category / filename
        return str(path) if path.is_file() else None

    return SimpleNamespace(
        folder_names_and_paths=dict.fromkeys(listed, ()),
        get_filename_list=lambda category: listed[category],
        get_full_path=get_full_path,
        get_user_directory=lambda: str(tmp_path / "user"),
    )


def test_build_manifest_digests_resolved_files(tmp_path: Path, monkeypatch):
    monkeypatch.setitem(sys.modules, "folder_paths", fake_folder_paths(tmp_path))
    prompt = {"1": {"class_type": "L", "inputs": {"ckpt_name": "base.safetensors"}}}

    manifest = asset_manifest.build_manifest(prompt, ["1"])

    body = b"weights for checkpoints/base.safetensors"
    assert manifest["unknown"] == []
    assert manifest["assets"] == [
        {
            "category": "checkpoints",
            "filename": "base.safetensors",
            "sha256": hashlib.sha256(body).hexdigest(),
            "size": len(body),
            "format": "safetensors",
        }
    ]
    # The digest cache landed in the ComfyUI user directory, not beside the pack.
    assert (tmp_path / "user" / "cloud_offload" / "asset-digests.json").is_file()


def test_build_manifest_reports_a_listed_file_that_is_gone(tmp_path: Path, monkeypatch):
    monkeypatch.setitem(sys.modules, "folder_paths", fake_folder_paths(tmp_path))
    prompt = {"1": {"class_type": "L", "inputs": {"ckpt_name": "ghost.safetensors"}}}

    manifest = asset_manifest.build_manifest(prompt, ["1"])

    assert manifest["assets"] == []
    assert manifest["unknown"] == [
        {
            "node_id": "1",
            "input_name": "ckpt_name",
            "value": "ghost.safetensors",
            "reason": "listed under checkpoints but missing on disk",
        }
    ]


def test_remote_assets_resolve_missing_models_from_workflow_metadata():
    unknown = [
        {"node_id": "70:32", "input_name": "model_name", "value": "moge.safetensors"}
    ]
    sources = [
        {
            "name": "moge.safetensors",
            "directory": "geometry_estimation",
            "url": "https://huggingface.co/org/repo/resolve/main/models/moge.safetensors",
        }
    ]
    expected = {
        "category": "geometry_estimation",
        "filename": "moge.safetensors",
        "sha256": "a" * 64,
        "size": 123,
        "format": "safetensors",
    }

    assets, unresolved = asset_manifest.remote_assets(
        unknown, sources, resolver=lambda _source: expected
    )

    assert assets == [expected]
    assert unresolved == []


def test_parse_huggingface_url_pins_repo_revision_and_path():
    assert asset_manifest.parse_huggingface_url(
        "https://huggingface.co/Comfy-Org/MoGe/resolve/main/geometry/moge.safetensors"
    ) == ("Comfy-Org/MoGe", "main", "geometry/moge.safetensors")
