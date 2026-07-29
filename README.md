# ComfyUI-Cloud-Offload

Run selected ComfyUI nodes on rented cloud GPUs as a visible, editable
**Cloud Offload** box. Draw a box around any part of your graph and it executes
on a remote runner while the original nodes stay expanded and report live
progress, previews, and errors in place.

This pack is a thin client. All provisioning, queueing, provider credentials,
and remote execution live in the separately built
**[Cloud Offload coordinator](https://github.com/jethac/cloud-offload)**
service (Python package `cloud_offload`). RunPod is the default provider;
Vast.ai is the alternative, and support for
[studio fleets and pooled compute](https://github.com/jethac/cloud-offload/blob/main/docs/fleet-provider.md)
is designed and on the roadmap.

## Requirements

- A running Cloud Offload coordinator service. The pack never imports it as a
  library and never handles provider credentials — it only speaks HTTP to the
  coordinator's client-facing routes.

## Installation

1. Start the Cloud Offload coordinator separately (see the `cloud-offload`
   repo), for example:
   ```bash
   python -m cloud_offload serve --host 127.0.0.1
   ```

2. Install the pack — from the [Comfy Registry](https://registry.comfy.org/publishers/jethac/nodes/cloud-offload):
   ```bash
   comfy node install cloud-offload
   ```
   or clone into `custom_nodes`:
   ```bash
   cd ComfyUI/custom_nodes
   git clone https://github.com/jethac/ComfyUI-Cloud-Offload.git
   ```

3. Restart ComfyUI.

## Coordinator discovery

The pack discovers the coordinator in this order:

1. `CLOUD_OFFLOAD_URL` environment variable;
2. `~/.cloud-offload/service.json` (a JSON file with a `url` and optional
   `token_path`);
3. the localhost default `http://127.0.0.1:11435`.

Port `11434` (Ollama's reserved port) is never used. For a non-local or
authenticated coordinator, set `CLOUD_OFFLOAD_TOKEN`, or let the pack read the
token path recorded in the service file. The request itself is the
authoritative availability check; discovery does not health-gate every call.

## Nodes

| Node | Category | Description |
|------|----------|-------------|
| **Cloud Status** | `Cloud Offload` | Show queue counts, active workers, and RunPod/Vast.ai balances as JSON |
| **Cloud Workflow** | `Cloud Offload` | Submit a whole API-format ComfyUI workflow to a cloud runner and return its first image + result JSON |

The four partition **bridge** nodes are compiler-generated and hidden
(`is_dev_only`); users never place them by hand. They live under
`Cloud Offload/Internal`:

| Node | Role |
|------|------|
| `CloudPartitionGateway` | Local proxy that submits the boxed subgraph and pauses until it completes |
| `CloudPartitionExtract` | Restores one ordinary Comfy value from the partition result |
| `CloudPartitionInput` | Runner-side bridge that restores an uploaded boundary value |
| `CloudPartitionOutput` | Runner-side bridge that writes a typed boundary bundle |

## Cloud Offload box

Select one or more nodes and choose **Cloud Offload selection** from ComfyUI's
selection toolbox. A visible box appears around them and owns the provider, GPU
type, minimum VRAM, timeout, and warm-runner policy. The nodes stay expanded
and receive incremental remote progress: the currently executing node is
highlighted, completed/cached nodes are marked, the box title shows percent,
and live previews appear.

At queue time the box is compiled into a hidden gateway plus typed input/output
bridges (see [PARTITION_PROTOCOL.md](PARTITION_PROTOCOL.md)). The runner image
must contain every custom node and model the boxed subgraph uses. The default
runner is model-agnostic: a pinned ComfyUI plus the partition bridge nodes, so
any node installed in that image can ride inside the box and report normal
node-level progress.

### GPU recommendation and rental confirmation

After the gateway uploads the final boundary artifacts, it runs free preflight
before it submits paid work. The default confirmation shows the recommended
provider, GPU, region, hourly price, estimated total-cost and time ranges,
prepared-cache coverage, rationale, confidence, and meaningful uncertainty.
It starts automatically after the server-controlled ten-second countdown.

The panel also provides **Start now**, **Cancel**, **Choose another GPU**, and
**Don't show this confirmation again**. Opening details or changing the GPU
pauses automatic start. A material price, cost, capacity, region, or storage
change always opens a new mandatory confirmation. The coordinator enforces the
countdown, so no paid job can start early from the browser.

Use the **Cloud Offload** action-bar button to restore confirmation or change
the countdown, recommendation policy, hard hourly and total-cost limits,
allowed regions, or material-change tolerances. Hiding normal confirmation
does not disable these hard limits or mandatory change notices.

## Example

```text
[Load Image] → [ ☁ Cloud Offload box: [KSampler] → [VAE Decode] ] → [Save Image]
```

Only portable boundary values may cross the box edge (`IMAGE`, `MASK`,
`LATENT`, `CONDITIONING`, `AUDIO`, tensors, JSON-compatible values, byte
buffers, and file-backed mesh / 3D-file artifacts). Live objects (`MODEL`,
`CLIP`, `VAE`, control nets, samplers, …) are rejected before a paid runner is
provisioned; move their loader or producer inside the box.

## License

Apache-2.0
