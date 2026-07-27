"""Required custom node packs: attribution, the closed-world rule, digests.

Attribution is pure, so these tests never need a ComfyUI: they hand
``classify_node_packs`` the class -> python_module map ``/object_info`` would
have published. The digest tests build throwaway pack directories.
"""

import sys
import textwrap
from pathlib import Path
from types import SimpleNamespace

import node_requirements


CLASS_MODULES = {
    "CheckpointLoaderSimple": "nodes",
    "SaveAnimatedWEBP": "comfy_extras.nodes_images",
    "GeminiNode": "comfy_api_nodes.nodes_gemini",
    "QwenLayerDecode": "custom_nodes.eric-qwen-layer",
    "QwenLayerEncode": "custom_nodes.eric-qwen-layer",
    "GroundingDinoSAM": "custom_nodes.ComfyUI-Grounding",
}


def prompt_fixture():
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
        "2": {"class_type": "QwenLayerEncode", "inputs": {"model": ["1", 0]}},
        "3": {"class_type": "QwenLayerDecode", "inputs": {"latent": ["2", 0]}},
        "4": {"class_type": "SaveAnimatedWEBP", "inputs": {"images": ["3", 0]}},
        "5": {"class_type": "GroundingDinoSAM", "inputs": {"image": ["3", 0]}},
    }


# === Attribution ===

def test_core_node_types_require_nothing():
    result = node_requirements.classify_node_packs(
        prompt_fixture(), ["1", "4"], CLASS_MODULES
    )

    assert result == {"packs": [], "unknown": []}


def test_api_nodes_are_core_too():
    prompt = {"1": {"class_type": "GeminiNode", "inputs": {}}}

    assert node_requirements.classify_node_packs(prompt, ["1"], CLASS_MODULES) == {
        "packs": [],
        "unknown": [],
    }


def test_a_custom_pack_is_detected_once_however_many_nodes_use_it():
    result = node_requirements.classify_node_packs(
        prompt_fixture(), ["1", "2", "3", "4", "5"], CLASS_MODULES
    )

    assert result["unknown"] == []
    assert result["packs"] == [
        # Deduped by directory, keeping the node that introduced it.
        {"directory": "eric-qwen-layer", "node_id": "2", "class_type": "QwenLayerEncode"},
        {"directory": "ComfyUI-Grounding", "node_id": "5", "class_type": "GroundingDinoSAM"},
    ]


def test_only_members_are_inspected():
    result = node_requirements.classify_node_packs(prompt_fixture(), ["1", "5"], CLASS_MODULES)

    assert [pack["directory"] for pack in result["packs"]] == ["ComfyUI-Grounding"]


def test_an_unattributable_node_type_is_reported_not_ignored():
    prompt = {
        "1": {"class_type": "QwenLayerEncode", "inputs": {}},
        "7": {"class_type": "SomeUninstalledNode", "inputs": {}},
    }

    result = node_requirements.classify_node_packs(prompt, ["1", "7"], CLASS_MODULES)

    assert [pack["directory"] for pack in result["packs"]] == ["eric-qwen-layer"]
    assert result["unknown"] == [{"node_id": "7", "class_type": "SomeUninstalledNode"}]


def test_a_node_type_from_an_unrecognized_namespace_is_unknown():
    prompt = {"1": {"class_type": "Strange", "inputs": {}}}

    result = node_requirements.classify_node_packs(
        prompt, ["1"], {"Strange": "some_other_loader.nodes"}
    )

    assert result["packs"] == []
    assert result["unknown"] == [
        {
            "node_id": "1",
            "class_type": "Strange",
            "reason": "defined in some_other_loader.nodes, which is neither core "
            "ComfyUI nor a node pack",
        }
    ]


def test_core_modules_are_recognized_by_namespace():
    assert node_requirements.is_core_module("nodes")
    assert node_requirements.is_core_module("comfy_extras.nodes_mask")
    assert node_requirements.is_core_module("comfy_api_nodes.nodes_openai")
    assert not node_requirements.is_core_module("custom_nodes.eric-qwen-layer")


# === Pack identity and content digest ===

def write_pack(root: Path, name: str, sources: dict[str, str], pyproject: str = "") -> Path:
    pack = root / name
    for relative, body in sources.items():
        path = pack / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
    if pyproject:
        (pack / "pyproject.toml").write_text(textwrap.dedent(pyproject), encoding="utf-8")
    return pack


def test_pack_identity_reads_the_registry_id_and_version(tmp_path: Path):
    pack = write_pack(
        tmp_path,
        "eric-qwen-layer",
        {"__init__.py": "NODE_CLASS_MAPPINGS = {}\n"},
        pyproject="""
            [project]
            name = "eric-qwen-layer"
            version = "0.1.0"
        """,
    )

    identity = node_requirements.pack_identity(pack)

    assert identity["id"] == "eric-qwen-layer"
    assert identity["directory"] == "eric-qwen-layer"
    assert identity["version"] == "0.1.0"
    assert identity["declared"] == {"id": True, "version": True}
    assert len(identity["digest"]) == 64


def test_a_pack_without_a_pyproject_falls_back_to_its_directory_name(tmp_path: Path):
    pack = write_pack(tmp_path, "hand_installed_pack", {"__init__.py": "x = 1\n"})

    identity = node_requirements.pack_identity(pack)

    assert identity["id"] == "hand_installed_pack"
    assert identity["version"] == ""
    # Both fields inferred, which is the difference between "version 0.1.0" and
    # "this pack never stated a version".
    assert identity["declared"] == {"id": False, "version": False}


def test_a_pyproject_without_a_version_says_so(tmp_path: Path):
    pack = write_pack(
        tmp_path,
        "pack",
        {"__init__.py": "x = 1\n"},
        pyproject="""
            [project]
            name = "registry-name"
        """,
    )

    identity = node_requirements.pack_identity(pack)

    assert (identity["id"], identity["version"]) == ("registry-name", "")
    assert identity["declared"] == {"id": True, "version": False}


def test_the_digest_changes_when_a_source_file_changes(tmp_path: Path):
    pack = write_pack(tmp_path, "pack", {"__init__.py": "x = 1\n", "nodes.py": "y = 2\n"})
    before = node_requirements.pack_digest(pack)

    (pack / "nodes.py").write_text("y = 3\n", encoding="utf-8")

    assert node_requirements.pack_digest(pack) != before


def test_the_digest_changes_when_a_file_is_renamed(tmp_path: Path):
    # The bytes are identical either way, so a path-blind digest would call the
    # two packs the same. Moving code between files is a real change.
    pack = write_pack(tmp_path, "pack", {"__init__.py": "", "nodes.py": "y = 2\n"})
    before = node_requirements.pack_digest(pack)

    (pack / "nodes.py").rename(pack / "renamed.py")

    assert node_requirements.pack_digest(pack) != before


def test_the_digest_ignores_bytecode_and_git_churn(tmp_path: Path):
    pack = write_pack(tmp_path, "pack", {"__init__.py": "x = 1\n"})
    before = node_requirements.pack_digest(pack)

    (pack / "__pycache__").mkdir()
    (pack / "__pycache__" / "__init__.cpython-311.pyc").write_bytes(b"\x00compiled")
    (pack / "__pycache__" / "helper.py").write_text("noise\n", encoding="utf-8")
    (pack / ".git").mkdir()
    (pack / ".git" / "hooks.py").write_text("noise\n", encoding="utf-8")
    (pack / "README.md").write_text("docs\n", encoding="utf-8")

    assert node_requirements.pack_digest(pack) == before


def test_two_packs_with_the_same_sources_share_a_digest(tmp_path: Path):
    sources = {"__init__.py": "x = 1\n", "sub/impl.py": "y = 2\n"}
    first = write_pack(tmp_path / "a", "pack", sources)
    second = write_pack(tmp_path / "b", "pack", sources)

    assert node_requirements.pack_digest(first) == node_requirements.pack_digest(second)


def test_a_single_file_pack_is_digested_as_itself(tmp_path: Path):
    # ComfyUI ships one of these (websocket_image_save.py), so the shape is real.
    single = tmp_path / "websocket_image_save.py"
    single.write_text("NODE_CLASS_MAPPINGS = {}\n", encoding="utf-8")

    identity = node_requirements.pack_identity(single)

    assert identity["id"] == "websocket_image_save"
    assert identity["directory"] == "websocket_image_save"
    assert identity["digest"] == node_requirements.pack_digest(single)


# === The impure wrapper, against stand-ins for nodes and folder_paths ===

def install(tmp_path: Path, monkeypatch, class_modules=CLASS_MODULES, packs=("eric-qwen-layer",)):
    """A ComfyUI stand-in: a node registry and one custom node search path."""
    custom_nodes = tmp_path / "custom_nodes"
    custom_nodes.mkdir(parents=True, exist_ok=True)
    for name in packs:
        write_pack(custom_nodes, name, {"__init__.py": f"# {name}\n"})
    mappings = {
        class_type: type(class_type, (), {"RELATIVE_PYTHON_MODULE": module})
        for class_type, module in class_modules.items()
    }
    monkeypatch.setitem(sys.modules, "nodes", SimpleNamespace(NODE_CLASS_MAPPINGS=mappings))
    monkeypatch.setitem(
        sys.modules,
        "folder_paths",
        SimpleNamespace(get_folder_paths=lambda category: [str(custom_nodes)]),
    )
    return custom_nodes


def test_build_resolves_and_digests_each_required_pack(tmp_path: Path, monkeypatch):
    custom_nodes = install(tmp_path, monkeypatch)

    requirements = node_requirements.build_node_requirements(
        prompt_fixture(), ["1", "2", "3", "4"]
    )

    assert requirements["unknown"] == []
    assert requirements["packs"] == [
        {
            "id": "eric-qwen-layer",
            "directory": "eric-qwen-layer",
            "version": "",
            "digest": node_requirements.pack_digest(custom_nodes / "eric-qwen-layer"),
            "declared": {"id": False, "version": False},
        }
    ]


def test_build_ignores_a_box_of_core_nodes(tmp_path: Path, monkeypatch):
    install(tmp_path, monkeypatch)

    assert node_requirements.build_node_requirements(prompt_fixture(), ["1", "4"]) == {
        "packs": [],
        "unknown": [],
    }


def test_build_reports_a_class_this_comfyui_never_loaded(tmp_path: Path, monkeypatch):
    install(tmp_path, monkeypatch)
    prompt = {"7": {"class_type": "SomeUninstalledNode", "inputs": {}}}

    requirements = node_requirements.build_node_requirements(prompt, ["7"])

    assert requirements["packs"] == []
    assert requirements["unknown"] == [
        {"node_id": "7", "class_type": "SomeUninstalledNode"}
    ]


def test_build_reports_a_pack_that_is_not_on_any_custom_node_path(tmp_path: Path, monkeypatch):
    install(tmp_path, monkeypatch, packs=())

    requirements = node_requirements.build_node_requirements(prompt_fixture(), ["2"])

    assert requirements["packs"] == []
    assert requirements["unknown"] == [
        {
            "node_id": "2",
            "class_type": "QwenLayerEncode",
            "reason": "loaded from eric-qwen-layer, which is not on any custom node path",
        }
    ]
