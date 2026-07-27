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
    """Expose the coordinator's provider surface same-origin to the browser.

    The browser cannot call the coordinator directly (different origin, and the
    bearer token stays server-side), so ComfyUI proxies provider discovery,
    per-connector administration, and declarative provider spec authoring.
    Nothing passing through here is persisted in ComfyUI: credentials and dry-run
    probe keys are forwarded to the coordinator and dropped.
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

    async def _read_body(request):
        try:
            return await request.json() if request.can_read_body else {}
        except Exception:
            return {}

    async def _proxy(call, *args):
        """Run one coordinator call off the event loop, as a JSON response."""
        import asyncio

        try:
            payload = await asyncio.to_thread(call, *args)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=502)
        return web.json_response(payload)

    @PromptServer.instance.routes.get("/cloud_offload/config")
    async def cloud_offload_get_config(request):
        return await _proxy(client.get_config)

    @PromptServer.instance.routes.post("/cloud_offload/config")
    async def cloud_offload_update_config(request):
        # Coordinator policy (e.g. the hourly-rate ceiling), not per-browser
        # settings. The coordinator rejects secret fields itself.
        return await _proxy(client.update_config, await _read_body(request))

    # Declarative provider specs. Registered before the generic
    # ``{provider}/{action}`` route below, which would otherwise swallow
    # ``POST /cloud_offload/providers/specs/validate`` as provider="specs".
    #
    # A spec holds no credentials by construction, so these bodies are ordinary
    # configuration. The one exception is the dry-run probe key, which is passed
    # through for that single request and never persisted on either side.

    @PromptServer.instance.routes.get("/cloud_offload/providers/specs")
    async def cloud_offload_list_specs(request):
        return await _proxy(client.provider_specs)

    @PromptServer.instance.routes.post("/cloud_offload/providers/specs/validate")
    async def cloud_offload_validate_spec(request):
        body = await _read_body(request)
        return await _proxy(client.validate_provider_spec, body.get("spec", body))

    @PromptServer.instance.routes.post("/cloud_offload/providers/specs/dry-run")
    async def cloud_offload_dry_run_spec(request):
        body = await _read_body(request)
        return await _proxy(
            client.dry_run_provider_spec, body.get("spec", body), body.get("api_key")
        )

    @PromptServer.instance.routes.get("/cloud_offload/providers/specs/{name}")
    async def cloud_offload_get_spec(request):
        return await _proxy(client.provider_spec, request.match_info["name"])

    @PromptServer.instance.routes.put("/cloud_offload/providers/specs/{name}")
    async def cloud_offload_put_spec(request):
        body = await _read_body(request)
        return await _proxy(
            client.save_provider_spec,
            request.match_info["name"],
            body.get("spec", body),
        )

    @PromptServer.instance.routes.delete("/cloud_offload/providers/specs/{name}")
    async def cloud_offload_delete_spec(request):
        return await _proxy(client.delete_provider_spec, request.match_info["name"])

    @PromptServer.instance.routes.post("/cloud_offload/assets")
    async def cloud_offload_assets(request):
        """Classify and digest the model files a boxed subgraph declares.

        Purely local: unlike the routes above this one never reaches the
        coordinator. The browser cannot read ``folder_paths`` or hash weights,
        so the compiler asks the ComfyUI process it is already talking to, and
        gets back the content identity of every model the box references.
        """
        import asyncio

        if __package__:
            from .asset_manifest import build_manifest
        else:
            from asset_manifest import build_manifest

        body = await _read_body(request)
        prompt = body.get("prompt")
        member_ids = body.get("member_ids")
        if not isinstance(prompt, dict) or not isinstance(member_ids, list):
            return web.json_response(
                {"error": "A prompt object and a member_ids list are required"},
                status=400,
            )
        try:
            payload = await asyncio.to_thread(build_manifest, prompt, member_ids)
        except Exception as exc:
            # 500, not the 502 the proxy routes use: the failure is this
            # process's, and the compiler treats any error as "no manifest".
            return web.json_response({"error": str(exc)}, status=500)
        return web.json_response(payload)

    @PromptServer.instance.routes.post(
        "/cloud_offload/providers/{provider}/{action}"
    )
    async def cloud_offload_provider_action(request):
        """Proxy provider administration to the coordinator.

        Credentials pass straight through to the coordinator, which stores them
        outside ComfyUI. They are never written to comfy.settings.json.
        """
        provider = request.match_info["provider"]
        action = request.match_info["action"]
        if action not in {"credentials", "settings", "test"}:
            return web.json_response({"error": "Unsupported action"}, status=404)
        body = await _read_body(request)
        return await _proxy(client.provider_action, provider, action, body)


_register_routes()

WEB_DIRECTORY = "./web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
