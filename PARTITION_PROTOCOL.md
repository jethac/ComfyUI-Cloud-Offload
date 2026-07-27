# ComfyUI Cloud Offload Partition Protocol

This document is the executable contract for cloud-partitioned ComfyUI graphs.
The wire format is versioned independently from the coordinator and ComfyUI
releases.

## User-visible unit

A Cloud Offload partition is an ordinary visible ComfyUI group box whose group
flags contain a `cloud_offload_partition` object. The original nodes remain
editable and visible inside the box; marking a partition never collapses them
into an opaque proxy node:

```json
{
  "version": 1,
  "enabled": true,
  "partition_id": "uuid",
  "provider": "auto",
  "profile": "comfyui-partition-v1",
  "gpu_type": "any",
  "min_gpu_ram_gb": 16,
  "keep_warm": true
}
```

The frontend creates the subgraph from the current selection and preserves the
metadata in workflow JSON. A partition may contain any node installed in the
selected immutable runner image, which executes the complete selected subgraph
without lowering individual nodes into a second cloud job. Partition boundaries
are deliberately more restrictive than partition contents.

## Portable boundary values

The first protocol version accepts:

- `IMAGE`, `MASK`, `LATENT`, `CONDITIONING`, `AUDIO`, and tensor-backed custom
  values whose runtime value consists only of tensors and JSON-compatible data;
- file-backed mesh values and Comfy `FILE_3D` values, copied into the bundle
  and restored to a fresh local file;
- `STRING`, `INT`, `FLOAT`, `BOOLEAN`, and JSON-compatible custom values;
- byte buffers and explicitly declared file artifacts.

`MODEL`, `CLIP`, `VAE`, `CONTROL_NET`, live samplers, model patches, callables,
and arbitrary Python objects are not portable. The compiler must reject such a
crossing before queueing and recommend moving the corresponding loader or
producer into the cloud partition. A custom type can become portable only by
registering an explicit serializer.

## Compiled local graph

At queue time each marked subgraph is compiled into:

1. one hidden `CloudPartitionGateway` node with dynamic boundary inputs;
2. one hidden `CloudPartitionExtract` node per boundary output;
3. a remote API-format workflow containing the original internal nodes plus
   `CloudPartitionInput` and `CloudPartitionOutput` bridge nodes.

The gateway asynchronously submits one coordinator job and returns a single
opaque partition-result value. Extractors return ordinary ComfyUI values,
allowing the unchanged local downstream graph to resume.

## Artifact bundle

Boundary values use `comfy.partition.bundle.v1`, a ZIP container with:

- `manifest.json`: recursive value tree and protocol metadata;
- `tensors.safetensors`: all tensor leaves, stored on CPU without pickle;
- `blobs/<id>`: byte/file leaves addressed by generated identifiers.

Bundles are written with the `.part` extension. Readers must reject unknown
schemas, unsafe ZIP names, duplicate members, undeclared members, oversized
manifests, excessive nesting, and unsupported runtime values. Artifact identity
is the SHA-256 digest of the complete bundle.

## Declared assets

A compiled job may carry `assets`: the model files its subgraph references, each
as `{category, filename, sha256, size, format}`. The list is produced inside
ComfyUI (`POST /cloud_offload/assets`), not in the browser, because only the
server process can map a widget string to a file in `folder_paths` and hash it.

Classification is closed-world. A string that looks like a model file but
matches no category blocks compilation, naming the node and the value: an
incomplete manifest is worse than none, because it converts an honest
post-provision failure into a green light followed by a paid failure. If the
route itself is unreachable the compiler stamps no `assets` at all, and the job
behaves as it did before declared assets existed.

## Required node packs

A compiled job may carry `node_packs`: the custom node packs its subgraph needs
installed on the runner, each as `{id, directory, version, digest, declared}`.
The list comes from the same route as `assets` (`POST /cloud_offload/assets`), in
the same round trip, because both questions are asked about the same box at the
same moment.

Attribution is exact, not heuristic: ComfyUI reports the defining module of every
node class it loaded (`nodes`, `comfy_extras.*` and `comfy_api_nodes.*` are core;
`custom_nodes.<dir>` is a pack), which is the same value `/object_info` publishes
as `python_module`.

Every record carries a `digest` — sha256 over the pack's `.py` files, each
contributing its relative path and then its bytes in sorted path order — because
a declared `version` cannot be trusted to identify code. A pack may carry a
security fix and still declare the version of the unpatched release published
under the same number, so version equality proves nothing about content.

Attribution is closed-world on the same terms as declared assets. A node type
this ComfyUI cannot attribute to a pack blocks compilation, naming the class and
node. If the route is unreachable, or pack detection fails, the compiler stamps
no `node_packs` and the job behaves as it did before required node packs existed.

## Coordinator flow

The local gateway uploads input bundles to authenticated coordinator artifact
routes (`POST /api/artifacts`). The queued job contains only artifact IDs and
the extracted remote prompt. A worker downloads inputs over its authenticated
outbound coordinator channel, executes the colocated headless ComfyUI, uploads
output bundles, and completes the job with output artifact IDs. Cloud ComfyUI is
never exposed publicly.

## Incremental execution events

The runner connects to the colocated ComfyUI websocket before submitting the
remote prompt and relays its execution stream to the coordinator. Each event is
stored with a monotonically increasing sequence number and can be resumed with
`GET /api/jobs/{job_id}/events?after={sequence}`. Events include:

- prompt submission/start/success and terminal errors;
- the original internal node ID on `executing`, `executed`, and cached-node
  messages;
- node-local `value`/`max` progress and a computed overall partition percent;
- preview images emitted during execution and images produced by preview/output
  nodes, capped at 2 MiB per preview;
- staging and result-upload phases around the remote Comfy execution.

The local gateway republishes these as `comfy.partition.progress` ComfyUI
events. The frontend maps original remote node IDs back to the still-visible
nodes in the cloud box, highlights the currently executing node, marks
completed/cached nodes, updates the group title and percent, and displays live
previews. A partition that provides only a generic spinner until completion is
not protocol compliant.

## Required behavior

- Validation happens before provisioning a paid worker.
- Cancellation of the local prompt cancels the coordinator job and remote Comfy
  prompt.
- Remote progress and previews are mapped to the parent partition node.
- Cache identity includes the remote prompt, input artifact digests, partition
  settings, runner image digest, and custom-node/model manifest.
- Retries never execute a non-idempotent partition twice without an explicit
  attempt identity.
- Multiple independent partitions may execute concurrently; dependent
  partitions preserve graph order.
- Errors identify the internal remote node and display it on the parent
  partition rather than surfacing only as a gateway failure.
