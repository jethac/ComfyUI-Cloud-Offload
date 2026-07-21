"""ComfyUI-Cloud-Offload: run selected ComfyUI nodes on rented cloud GPUs."""

if __package__:
    from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
else:  # pytest may collect this repository as a top-level module
    from nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

try:
    if __package__:
        from .partition_nodes import (
            CloudPartitionExtract,
            CloudPartitionGateway,
            CloudPartitionInput,
            CloudPartitionOutput,
        )
    else:
        from partition_nodes import (
            CloudPartitionExtract,
            CloudPartitionGateway,
            CloudPartitionInput,
            CloudPartitionOutput,
        )
except ModuleNotFoundError as exc:
    if exc.name != "comfy_api":
        raise
else:
    NODE_CLASS_MAPPINGS.update(
        {
            "CloudPartitionGateway": CloudPartitionGateway,
            "CloudPartitionExtract": CloudPartitionExtract,
            "CloudPartitionInput": CloudPartitionInput,
            "CloudPartitionOutput": CloudPartitionOutput,
        }
    )

WEB_DIRECTORY = "./web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
