"""Pickle-to-safetensors conversion, checked against a published twin.

4x-UltraSharp ships as both ``.pth`` and, from the same author, ``.safetensors``.
That makes it a ground-truth oracle: a correct converter must reproduce the
published file key for key and tensor for tensor. Asserting "it loads" would
prove nothing — this asserts the twin is the same model.

Skipped where the pair is not installed, or where ComfyUI's loader is not
importable, so a checkout without models still passes.
"""

import os
from pathlib import Path

import pytest
import torch

ORIGINAL = "4x-UltraSharp.pth"
PUBLISHED_TWIN = "4x-UltraSharp.safetensors"


def oracle_directory():
    """Find a models/upscale_models holding both halves of the pair."""
    candidates = []
    try:
        import folder_paths

        candidates.extend(folder_paths.get_folder_paths("upscale_models"))
    except Exception:
        pass
    root = os.environ.get("COMFYUI_ROOT")
    if root:
        candidates.append(Path(root) / "models" / "upscale_models")
    # Installed normally, this pack sits at ComfyUI/custom_nodes/<pack>/tests.
    candidates.append(Path(__file__).resolve().parents[3] / "models" / "upscale_models")
    for candidate in candidates:
        directory = Path(candidate)
        if (directory / ORIGINAL).is_file() and (directory / PUBLISHED_TWIN).is_file():
            return directory
    return None


ORACLE = oracle_directory()


@pytest.mark.skipif(ORACLE is None, reason=f"{ORIGINAL} and {PUBLISHED_TWIN} are not installed")
def test_conversion_reproduces_the_published_twin(tmp_path: Path):
    comfy_utils = pytest.importorskip("comfy.utils")
    import converter

    result = converter.convert_to_safetensors(ORACLE / ORIGINAL, tmp_path)

    assert result["alias"] == PUBLISHED_TWIN
    assert result["cache_path"] == str(tmp_path / PUBLISHED_TWIN)
    assert result["orig_sha256"] != result["conv_sha256"]
    assert result["dropped_keys"] == []

    # On the 4x-UltraSharp pair this conversion is byte-identical to the
    # published file, not merely equivalent. Asserting that would over-fit —
    # safetensors metadata and key order are free to differ — so the equality
    # checked here is the one that has to hold for every pair: same keys, same
    # tensors.
    converted = comfy_utils.load_torch_file(result["cache_path"])
    published = comfy_utils.load_torch_file(str(ORACLE / PUBLISHED_TWIN))

    # Report the asymmetry rather than just a count: a missing key and an extra
    # key are different bugs.
    assert sorted(set(converted) - set(published)) == []
    assert sorted(set(published) - set(converted)) == []
    unequal = [
        key
        for key in published
        if converted[key].shape != published[key].shape
        or not torch.equal(converted[key].to(torch.float32), published[key].to(torch.float32))
    ]
    assert unequal == []
