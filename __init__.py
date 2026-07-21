"""ComfyUI-Cloud-Offload: cloud partition and legacy Kao service nodes."""

if __package__:
    from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
else:  # pytest may collect this repository as a top-level module
    from nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

try:
    if __package__:
        from .partition_nodes import (
            KaoCloudPartitionExtract,
            KaoCloudPartitionGateway,
            KaoPartitionInput,
            KaoPartitionOutput,
        )
    else:
        from partition_nodes import (
            KaoCloudPartitionExtract,
            KaoCloudPartitionGateway,
            KaoPartitionInput,
            KaoPartitionOutput,
        )
except ModuleNotFoundError as exc:
    if exc.name != "comfy_api":
        raise
else:
    NODE_CLASS_MAPPINGS.update(
        {
            "KaoCloudPartitionGateway": KaoCloudPartitionGateway,
            "KaoCloudPartitionExtract": KaoCloudPartitionExtract,
            "KaoPartitionInput": KaoPartitionInput,
            "KaoPartitionOutput": KaoPartitionOutput,
        }
    )

WEB_DIRECTORY = "./web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
