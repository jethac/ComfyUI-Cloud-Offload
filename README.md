# ComfyUI-Kao

Kao nodes for ComfyUI. 3D generation powered by [Kao](https://github.com/jethac/kao).

## Installation

1. Install and start Kao separately:
   ```bash
   pip install kao
   kao serve --host 127.0.0.1
   ```

2. Clone/symlink to custom_nodes:
   ```bash
   cd ComfyUI/custom_nodes
   git clone http://truenas-scale:8088/jethac/comfyui-kao.git ComfyUI-Kao
   # or symlink for dev:
   # mklink /D ComfyUI-Kao B:\lab\ComfyUI-Kao
   ```

3. Restart ComfyUI.

ComfyUI-Kao talks to the Kao service over HTTP. It does not import Kao as a
Python library. It discovers Kao from `KAO_URL` or `~/.kao/service.json`; Kao
auto-selects an available service port and never uses Ollama's reserved 11434
port. Discovery validates Kao's `/api/health` endpoint before node execution.
For a non-local Kao service, set `KAO_TOKEN` or let ComfyUI-Kao read the token
path from the local Kao service file.

Generation nodes submit work through Kao's unified job API and block until the
job finishes or returns a clear service error. Existing workflows remain local
by default. Set a generation node's `execution` input to `auto` or `cloud` to
let Kao route it, and optionally choose `vast.ai` or `runpod`. Provider
credentials remain in Kao and are never handled by ComfyUI-Kao. Cancelling a
ComfyUI workflow forwards cancellation to its active Kao job.

Model dropdowns come from Kao's readiness-aware `/api/models` endpoint and are
filtered by both node task and execution choice. Local only shows models whose
adapter, exact cached weights, and hardware checks pass; cloud only shows models
covered by a configured immutable worker profile; auto is their union. If none
are runnable, the node reports the readiness failure instead of offering a model
that will predictably fail after submission.

## Nodes

| Node | Description |
|------|-------------|
| **Kao Load Model** | Load a Kao model (hunyuan3d-2.1-turbo, etc.) |
| **Kao Select Model** | Select a model for cloud work without loading it locally |
| **Kao Cloud Status** | Show routing, workers, and Vast.ai/RunPod balances as JSON |
| **Kao Image → 3D** | Generate a mesh with standard GLB preview and optional texture outputs |
| **Kao Multi-View → 3D** | Generate mesh from front/left/back views |
| **Kao Image → Scene** | Reconstruct scene (depth, pointcloud) |
| **Kao Save Mesh** | Export mesh to GLB/OBJ/PLY/STL |
| **Kao Mesh Preview** | Show mesh stats |
| **Workspace Project State** | Create/check a shared workspace root/world/stage input and return JSON plus key paths |
| **Workspace Object Intent** | Create/update `worlds/<world>/output/<object>/object.json` |
| **Kao Generate Object To Workspace** | Generate a GLB into an object workspace and write artifact metadata |
| **Workspace Save Mesh** | Save an incoming `KAO_MESH` to an indexed workspace artifact path with sidecar metadata |
| **Workspace Material Intent** | Write a provider-neutral material prompt/intent for Material Maker or texture pipelines |

Workspace nodes are under `Kao/Workspace`. They use Kao's workspace HTTP API.
Their compatibility `root` input now defaults to `B:\lab\Kao`; the running Kao
service remains the authority for the actual workspace root:

```text
<root>/
  worlds/
    <world>/
      source/
      output/<object>/
        object.json
        0-object.glb
        0-object.metadata.json
        .0-object__model-request.json
        materials/
          bark.json
```

## Example Workflow

```text
[Load Image] → [Kao Image → 3D] → [Kao Save Mesh]
                         ↓
          model_name: hunyuan3d-2.1-turbo
```

`Kao Image → 3D` defaults to `hunyuan3d-2.1-turbo` and asks Kao to load
the selected model on demand for local execution. Its optional `model` socket
is retained for advanced workflows and compatibility with existing `Kao Load
Model` and `Kao Select Model` connections; a connected model takes precedence
over the inline dropdown.

Workspace flow:

```text
[Load Image] → [Kao Generate Object To Workspace]
                         ↑
       [Workspace Object Intent] / root + world + object
```
