"""Required custom node packs for a Cloud Offload partition.

The sibling of ``asset_manifest``: that module answers "which model files does
this box reference", this one answers "which node packs must the runner have
installed before the box can run at all". Both questions are unanswerable in the
browser and both have to be settled *before* a GPU is rented, because a runner
missing a node pack fails on its first prompt with money already spent.

The attribution is exact rather than heuristic. ComfyUI stamps every node class
it loads from a pack with ``RELATIVE_PYTHON_MODULE`` — ``"nodes"`` for core,
``"comfy_extras.<mod>"`` and ``"comfy_api_nodes.<mod>"`` for the modules that
ship with it, ``"custom_nodes.<dir>"`` for a pack — and serves that same value as
``python_module`` in ``/object_info``. Reading it in-process is the same source
of truth without the round trip.

``classify_node_packs`` is deliberately pure: no filesystem, no ``nodes``, no
``folder_paths``. Everything impure lives in ``pack_identity`` and
``build_node_requirements``.
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger(__name__)

CUSTOM_NODE_PREFIX = "custom_nodes."

# Modules ComfyUI itself supplies. ``nodes`` is the built-in set; the other two
# are the remaining ``module_parent`` values ComfyUI passes to its own node
# loader, so a class in either is present wherever ComfyUI is.
CORE_MODULES = frozenset({"nodes"})
CORE_MODULE_PREFIXES = ("comfy_extras.", "comfy_api_nodes.")

SOURCE_SUFFIX = ".py"
# Never part of a pack's identity: bytecode is derived, and a checkout's git
# metadata changes with every fetch without a line of code moving.
SKIPPED_DIRECTORIES = frozenset({"__pycache__", ".git"})

PYPROJECT_FILENAME = "pyproject.toml"


def is_core_module(module: str) -> bool:
    """Whether a ``python_module`` names code that ships with ComfyUI."""
    name = str(module or "")
    return name in CORE_MODULES or name.startswith(CORE_MODULE_PREFIXES)


def pack_directory(module: str) -> str:
    """The custom node directory a ``custom_nodes.<dir>`` module belongs to."""
    remainder = str(module)[len(CUSTOM_NODE_PREFIX) :]
    return remainder.split(".", 1)[0].strip()


def classify_node_packs(
    prompt: dict[str, Any],
    member_ids: Iterable[Any],
    class_modules: dict[str, str],
) -> dict[str, list[dict[str, Any]]]:
    """Attribute every node type in a boxed subgraph to the pack that defines it.

    ``class_modules`` maps a ``class_type`` to the ``python_module`` ComfyUI
    reports for it. Core modules are ignored — the runner image has them by
    definition — and each ``custom_nodes.<dir>`` yields one required pack.

    The rule is the same closed world the asset manifest uses. A node type this
    ComfyUI cannot attribute to *any* module, or attributes to a namespace that
    is neither core nor a pack, lands in ``unknown`` rather than being waved
    through: a requirement list that quietly omits a pack turns an honest
    post-provision failure into a confident green light followed by a paid one.

    Pack entries carry the node that introduced them, the way ``classify_assets``
    keeps the introducing input site, so a later failure to locate the pack on
    disk can still name something the user can see on the canvas.
    """
    modules = {str(name): str(module or "") for name, module in (class_modules or {}).items()}
    packs: list[dict[str, Any]] = []
    unknown: list[dict[str, Any]] = []
    introduced: set[str] = set()
    reported: set[tuple[str, str]] = set()

    def report_unknown(node_id: str, class_type: str, reason: str | None = None) -> None:
        if (node_id, class_type) in reported:
            return
        reported.add((node_id, class_type))
        entry: dict[str, Any] = {"node_id": node_id, "class_type": class_type}
        if reason:
            entry["reason"] = reason
        unknown.append(entry)

    for member_id in member_ids or ():
        node_id = str(member_id)
        node = (prompt or {}).get(node_id) or {}
        class_type = str(node.get("class_type") or "").strip()
        if not class_type:
            continue
        module = modules.get(class_type)
        if module is None:
            report_unknown(node_id, class_type)
            continue
        if is_core_module(module):
            continue
        if not module.startswith(CUSTOM_NODE_PREFIX):
            report_unknown(
                node_id,
                class_type,
                f"defined in {module}, which is neither core ComfyUI nor a node pack",
            )
            continue
        directory = pack_directory(module)
        if not directory:
            report_unknown(node_id, class_type, f"defined in {module}, which names no pack")
            continue
        if directory in introduced:
            continue
        introduced.add(directory)
        packs.append({"directory": directory, "node_id": node_id, "class_type": class_type})

    return {"packs": packs, "unknown": unknown}


def _source_files(path: Path) -> list[tuple[str, Path]]:
    """Every ``.py`` file in a pack, as ``(relative posix path, file)``, sorted.

    A pack installed from a single ``.py`` file — ComfyUI ships one itself — is
    that one file, named as ComfyUI names its module.
    """
    if path.is_file():
        return [(path.name, path)] if path.suffix.lower() == SOURCE_SUFFIX else []
    found: list[tuple[str, Path]] = []
    for candidate in path.rglob("*.py"):
        if not candidate.is_file():
            continue
        relative = candidate.relative_to(path)
        if any(part in SKIPPED_DIRECTORIES for part in relative.parts[:-1]):
            continue
        found.append((relative.as_posix(), candidate))
    return sorted(found, key=lambda item: item[0])


def pack_digest(pack_dir: str | Path) -> str:
    """Content identity of an installed pack: sha256 over its source files.

    Each file contributes its relative path and then its bytes, in sorted path
    order, so moving code between files changes the digest even when the bytes
    are unchanged. Only ``.py`` files count: they are what ComfyUI executes, and
    including bytecode or git metadata would make the digest depend on when the
    pack was last imported rather than on what it does.

    This is the field that makes a requirement checkable. A declared version
    cannot do the job — a pack can carry a security fix and still call itself
    the version of the unpatched artifact on the registry.
    """
    digest = hashlib.sha256()
    for relative, source in _source_files(Path(pack_dir)):
        digest.update(f"{relative}\n".encode("utf-8"))
        digest.update(source.read_bytes())
    return digest.hexdigest()


def _pyproject_project(path: Path) -> dict[str, Any]:
    """The ``[project]`` table of a pack's pyproject, or nothing readable."""
    if not path.is_dir():
        return {}
    pyproject = path / PYPROJECT_FILENAME
    try:
        import tomllib
    except ModuleNotFoundError:  # pragma: no cover - Python 3.10 and older
        return {}
    try:
        data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        # A pack without a pyproject is ordinary — most hand-installed ones have
        # none — and a damaged one is treated the same way: undeclared.
        return {}
    project = data.get("project")
    return project if isinstance(project, dict) else {}


def pack_identity(pack_dir: str | Path) -> dict[str, Any]:
    """Identify one installed pack: registry id, version, and content digest.

    ``id`` and ``version`` come from the pack's ``[project]`` table when it has
    one — that name is the Comfy Registry id an operator would pin — and fall
    back to the directory name and an empty version when it does not.
    ``declared`` records which of the two ComfyUI actually got told, so a
    consumer can tell "version 0.1.0" from "no version was ever stated".
    """
    path = Path(pack_dir)
    directory = path.stem if path.suffix.lower() == SOURCE_SUFFIX else path.name
    project = _pyproject_project(path)
    identifier = str(project.get("name") or "").strip()
    version = str(project.get("version") or "").strip()
    return {
        "id": identifier or directory,
        "directory": directory,
        "version": version,
        "digest": pack_digest(path),
        "declared": {"id": bool(identifier), "version": bool(version)},
    }


def _locate_pack(roots: Iterable[Path], directory: str) -> Path | None:
    """Find an installed pack by the directory name ComfyUI attributed it to."""
    for root in roots:
        candidate = root / directory
        if candidate.is_dir():
            return candidate
        single_file = root / f"{directory}{SOURCE_SUFFIX}"
        if single_file.is_file():
            return single_file
    return None


def build_node_requirements(
    prompt: dict[str, Any], member_ids: Iterable[Any]
) -> dict[str, list[dict[str, Any]]]:
    """Resolve the packs a boxed subgraph needs, with their content identity.

    The impure half: reads the live node registry and the custom node search
    paths, and hashes what it finds on disk. ``nodes.NODE_CLASS_MAPPINGS`` plus
    ``RELATIVE_PYTHON_MODULE`` is exactly what ``/object_info`` publishes as
    ``python_module``, read in-process rather than over an HTTP call this
    process would be making to itself.
    """
    import folder_paths
    import nodes

    class_modules = {
        str(class_type): getattr(node_class, "RELATIVE_PYTHON_MODULE", "nodes")
        for class_type, node_class in nodes.NODE_CLASS_MAPPINGS.items()
    }
    classified = classify_node_packs(prompt, member_ids, class_modules)
    roots = [Path(root) for root in folder_paths.get_folder_paths("custom_nodes")]
    packs: list[dict[str, Any]] = []
    unknown: list[dict[str, Any]] = list(classified["unknown"])

    for entry in classified["packs"]:
        directory = entry["directory"]
        located = _locate_pack(roots, directory)
        if located is None:
            # ComfyUI loaded the class from this directory, so something is
            # wrong with the search paths rather than with the graph. Blocking
            # is still the right answer: an unhashable pack cannot be required.
            unknown.append(
                {
                    "node_id": entry["node_id"],
                    "class_type": entry["class_type"],
                    "reason": f"loaded from {directory}, which is not on any custom node path",
                }
            )
            continue
        try:
            packs.append(pack_identity(located))
        except OSError as exc:
            logger.warning("Cloud Offload could not read node pack %s: %s", located, exc)
            unknown.append(
                {
                    "node_id": entry["node_id"],
                    "class_type": entry["class_type"],
                    "reason": f"installed at {directory} but unreadable: {exc}",
                }
            )

    return {"packs": packs, "unknown": unknown}
