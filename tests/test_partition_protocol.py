from pathlib import Path

import pytest
import torch

import partition_protocol as protocol


def test_bundle_round_trip_nested_tensor_value(tmp_path: Path):
    value = {
        "samples": torch.arange(12, dtype=torch.float32).reshape(1, 3, 2, 2),
        "conditioning": [(torch.ones((1, 2, 3)), {"strength": 0.75})],
        "metadata": {"seed": 42, "enabled": True, "nothing": None},
        "payload": b"mesh-bytes",
    }
    path = tmp_path / "value.part"

    metadata = protocol.dump_bundle(value, path)
    restored = protocol.load_bundle(path)

    assert metadata["schema"] == protocol.SCHEMA == "comfy.partition.bundle.v1"
    assert metadata["sha256"] == protocol.bundle_sha256(path)
    assert torch.equal(restored["samples"], value["samples"])
    assert torch.equal(restored["conditioning"][0][0], value["conditioning"][0][0])
    assert restored["conditioning"][0][1] == {"strength": 0.75}
    assert restored["metadata"] == value["metadata"]
    assert restored["payload"] == b"mesh-bytes"


@pytest.mark.parametrize("type_name", ["MODEL", "CLIP", "VAE", "CONTROL_NET", "*"])
def test_known_live_boundary_types_are_rejected(type_name):
    with pytest.raises(protocol.PartitionProtocolError):
        protocol.validate_boundary_type(type_name)


def test_loader_rejects_path_traversal(tmp_path: Path):
    import zipfile

    path = tmp_path / "unsafe.part"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("../manifest.json", "{}")

    with pytest.raises(protocol.PartitionProtocolError, match="unsafe"):
        protocol.load_bundle(path)


def test_unsupported_python_object_is_rejected(tmp_path: Path):
    with pytest.raises(protocol.PartitionProtocolError, match="Unsupported"):
        protocol.dump_bundle(object(), tmp_path / "bad.part")


def test_cloud_mesh_artifact_round_trip_is_explicit_and_safe(tmp_path: Path):
    mesh_path = tmp_path / "mesh.glb"
    mesh_path.write_bytes(b"glTF-mesh")
    CloudMeshArtifact = type("CloudMeshArtifact", (), {})
    mesh = CloudMeshArtifact()
    mesh.path = mesh_path
    mesh.stats = {"vertices": 12, "faces": 4}

    bundle = tmp_path / "mesh.part"
    protocol.dump_bundle(mesh, bundle)
    restored = protocol.load_bundle(bundle)

    assert restored[protocol.ARTIFACT_MARKER] == "cloud_mesh"
    assert restored["data"] == b"glTF-mesh"
    assert restored["format"] == "glb"
    assert restored["metadata"] == mesh.stats


def test_comfy_file3d_round_trip_is_explicit_and_safe(tmp_path: Path):
    File3D = type(
        "File3D",
        (),
        {"format": "glb", "get_bytes": lambda self: b"glTF-file"},
    )
    bundle = tmp_path / "file3d.part"

    protocol.dump_bundle(File3D(), bundle)
    restored = protocol.load_bundle(bundle)

    assert restored == {
        protocol.ARTIFACT_MARKER: "file_3d",
        "data": b"glTF-file",
        "format": "glb",
    }
