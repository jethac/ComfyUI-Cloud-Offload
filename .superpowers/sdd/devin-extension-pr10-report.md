# PR #10 validation report

Date: 2026-09-01 (Asia/Tokyo)

## Status

Validated locally in an isolated worktree. Sol review identified a real mounted-handler defect: the create button read and POSTed legacy 1–9 GB values without invoking the validator. The handler now validates the complete policy before confirmation/POST, with a mounted-path regression test. No RunPod mutations, spending, pushes, merges, or GitHub state changes were performed.

## Worktree and commits

- Worktree: `B:\\lab\\ComfyUI-Cloud-Offload\\.worktrees\\luna-extension-pr10`
- State: detached at PR head (the worktree was created from the PR ref)
- Base: `13f9eb25a882e1a0aab0177023742fa8af729f93` (upstream `fork/main` merge base)
- Original PR head: `455b727bc1d340034d9fe4c7f70aac0402b7ebf8`
- Validation fix head (after commit): recorded below
- PR change: `web/preparedStorage.js` only; adds `RUNPOD_NETWORK_VOLUME_MIN_GB = 10`, validates 10–4000 GB, and changes the HTML input `min` to 10.

## Decision evidence

The current official RunPod v2 create-network-volume reference documents `size` as an integer with required range `10 <= x <= 4096`: <https://docs.runpod.io/api-reference-v2/network-volumes/create-a-network-volume>.

The live v2 OpenAPI document retrieved on 2026-09-01 reports the same schema (`CreateNetworkVolumeRequest.properties.size.minimum = 10`, `maximum = 4096`): <https://api.runpod.io/v2/openapi.json>. Therefore the PR’s 10 GB lower bound remains correct. The repository’s 4000 GB upper bound is stricter than the provider’s current 4096 GB maximum and is not changed by this PR.

Repository-wide source inspection found no smaller volume request. The only managed-volume request is the prepared-storage UI path (`size_gb: policy.managed_size_gb`); its default is 250 GB. Before PR #10, users could enter/submit 1–9 GB through this client-side policy validator; those values would be forwarded to the coordinator and rejected by v2. The PR is therefore a preventive client-side guard, not a correction to an observed provider call in this repository. Existing/adopted volume IDs do not request a new volume size.

## Tests

- `python -m pytest -q`: **82 passed, 3 skipped**.
- `node --test web/*.test.mjs`: **68 passed, 0 failed**.
- `npm test --prefix web` was attempted but the package has no `test` script (expected command is the direct `node --test` invocation above).

## Concerns

- The original PR did not add a boundary regression test; this validation fix adds a mounted-path test proving 9 GB is never sent and 10 GB is sent.
- The UI uses `max="4000"` while RunPod v2 documents 4096 GB. This is an existing product policy choice, not a PR #10 defect.
- The PR’s comment refers to a “schema rejects” floor; this is supported by the current official v2 reference and live OpenAPI schema, without making a provider API call.

## Report path

`.superpowers/sdd/devin-extension-pr10-report.md`

## Sol review follow-up

- Production fix: `web/preparedStorage.js` invokes `validatePreparedStorage(policy)` in the managed-create click handler before region confirmation, estimate, and POST. Adoption behavior is unchanged.
- Regression test: `web/preparedStorage.test.mjs` uses a mounted fake DOM and verifies a legacy 9 GB value produces no volume request, while 10 GB produces `size_gb: 10`.
- Validation fix commit SHA: `ed2c81d8ed52c92ba8c95c69b6def5dc6747aea3`
- Post-fix tests: `node --test web/*.test.mjs` — 69 passed, 0 failed; `python -m pytest -q` — 82 passed, 3 skipped.
