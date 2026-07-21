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

def _register_routes() -> None:
    """Expose a same-origin provider list to the Cloud Offload box dialog.

    The browser cannot call the coordinator directly (different origin, and the
    bearer token stays server-side), so ComfyUI proxies the discovery route.
    """
    try:
        from server import PromptServer
        from aiohttp import web
    except ImportError:  # pragma: no cover - outside ComfyUI
        return

    if __package__:
        from .client import client
    else:
        from client import client

    @PromptServer.instance.routes.get("/cloud_offload/providers")
    async def cloud_offload_providers(request):
        import asyncio

        try:
            payload = await asyncio.to_thread(client.providers)
        except Exception as exc:
            return web.json_response(
                {"providers": [], "error": str(exc)}, status=502
            )
        return web.json_response(payload)

    @PromptServer.instance.routes.post(
        "/cloud_offload/providers/{provider}/{action}"
    )
    async def cloud_offload_provider_action(request):
        """Proxy provider administration to the coordinator.

        Credentials pass straight through to the coordinator, which stores them
        outside ComfyUI. They are never written to comfy.settings.json.
        """
        import asyncio

        provider = request.match_info["provider"]
        action = request.match_info["action"]
        if action not in {"credentials", "settings", "test"}:
            return web.json_response({"error": "Unsupported action"}, status=404)
        try:
            body = await request.json() if request.can_read_body else {}
        except Exception:
            body = {}
        try:
            payload = await asyncio.to_thread(
                client.provider_action, provider, action, body
            )
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=502)
        return web.json_response(payload)


_register_routes()

WEB_DIRECTORY = "./web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
