"""Convert a pickle-format model file into its safetensors twin.

Wired to nothing. This is the mechanism half of a policy question that is not
settled yet: a partition that declares a ``.ckpt`` or ``.pth`` asset is asking a
rented machine to unpickle bytes, and the safe answer is to ship the tensors
instead. The conversion is content-addressed on both sides — the original's
digest and the converted file's — so a twin can be cached, shared and matched
back to the file it came from without trusting either filename.

Only ``comfy.utils.load_torch_file`` and ``comfy.utils.save_torch_file`` touch
the files: ComfyUI's own loader is the one place in the process already trusted
to read a pickle, and its saver is plain ``safetensors``. Nothing here executes
a model or imports the code a checkpoint might name.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import torch

try:
    from .asset_manifest import digest_file
except ImportError:  # pragma: no cover - collected as a top-level module
    from asset_manifest import digest_file


def convert_to_safetensors(path: str | Path, out_dir: str | Path) -> dict[str, Any]:
    """Write ``path``'s tensors to a safetensors file under ``out_dir``.

    Returns the digests of both files, the ``alias`` the twin would be known by
    (the original's name with a ``.safetensors`` suffix), where it was written,
    and any keys that could not cross: a pickle may carry optimizer state,
    counters or arbitrary objects, and dropping those silently would be the same
    class of mistake as an incomplete asset manifest. They are reported instead.
    """
    import comfy.utils

    source = Path(path)
    if source.suffix.lower() in {".safetensors", ".sft"}:
        raise ValueError(f"{source.name} is already a safetensors file")

    alias = f"{source.stem}.safetensors"
    destination = Path(out_dir)
    destination.mkdir(parents=True, exist_ok=True)
    cache_path = destination / alias

    state_dict = comfy.utils.load_torch_file(str(source))
    tensors = {
        key: value for key, value in state_dict.items() if isinstance(value, torch.Tensor)
    }
    dropped_keys = sorted(set(state_dict) - set(tensors))
    comfy.utils.save_torch_file(tensors, str(cache_path))

    return {
        "orig_sha256": digest_file(source, {}),
        "conv_sha256": digest_file(cache_path, {}),
        "alias": alias,
        "cache_path": str(cache_path),
        "dropped_keys": dropped_keys,
    }
