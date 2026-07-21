# ComfyUI-Cloud-Offload

Run selected ComfyUI nodes on rented cloud GPUs as a visible, editable
**Cloud Offload** box. Formerly ComfyUI-Kao: the pack still includes legacy
Kao 3D generation and workspace nodes while they are decomposed into
ordinary ComfyUI nodes.

## Installation

1. Install and start Kao separately:
   ```bash
   pip install kao
   kao serve --host 127.0.0.1
   ```

2. Clone/symlink to custom_nodes:
   ```bash
   cd ComfyUI/custom_nodes
   git clone <remote-url> ComfyUI-Cloud-Offload
   # or symlink for dev:
   # mklink /J ComfyUI-Cloud-Offload B:\lab\ComfyUI-Cloud-Offload
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

Each generation node owns its model/runtime choice. Generation nodes have no
provider, execution, model selector, or inline `model_name` controls.
Cloud placement and provider selection belong exclusively to a visible **Cloud
Offload** box around the nodes to run remotely.

## Nodes

| Node | Description |
|------|-------------|
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
```

`Kao Image → 3D` uses `hunyuan3d-2.1-turbo`. To run it remotely, draw a
**Cloud Offload** box around the generation node; the box's
provider and runner settings are authoritative.

### Cloud Offload

Select one or more nodes and choose **Cloud Offload selection** from ComfyUI's
selection toolbox. The visible box owns provider, GPU, timeout, and warm-runner
policy. Nodes remain expanded and receive incremental remote progress.

The runner must contain every custom node and model used by the submitted
workflow. Cloud Offload uses the `comfyui-omni` runtime, which includes pinned
copies of ComfyUI-Kao, ComfyUI-See-through, ComfyUI-Grounding, and the Kao 3D
generation runtime. Kao nodes remain ordinary nodes in the submitted subgraph,
so mixed boxes execute as one graph and report normal node-level progress.

Workspace flow:

```text
[Load Image] → [Kao Generate Object To Workspace]
                         ↑
       [Workspace Object Intent] / root + world + object
```
