# ApplicationController UML / Call Graph

Diagrams derived from `controller/appcontroller.go` (Argo CD v3).

Every relationship shown was read directly out of that file. Dashed arrows in the
call graphs mean "function value passed as a callback", not a direct invocation.

## Contents

| File | Diagram | Type |
|---|---|---|
| `01-class-diagram.md` | Types and their methods | Mermaid `classDiagram` |
| `02-startup-dispatch.md` | `NewApplicationController` and `Run` wiring | Mermaid `flowchart` |
| `03-triggers-fanin.md` | Trigger sources feeding `requestAppRefresh` | Mermaid `flowchart` |
| `04-refresh-loop.md` | `processAppRefreshQueueItem` call tree | Mermaid `flowchart` |
| `05-operation-project-hydration.md` | Operation, project, hydration loops | Mermaid `flowchart` |
| `06-sequence-reconcile.md` | One full reconcile across both loops | Mermaid `sequenceDiagram` |
| `07-fan-in-table.md` | Shared-helper fan-in, goroutine classes, call cycles | Tables + Mermaid `flowchart` |
| `mmd/` | Generated: mermaid block of each diagram | Mermaid source |
| `svg/` | Generated: pre-rendered SVGs | SVG |
| `png/` | Generated: pre-rendered PNGs | PNG |
| `sync-diagrams.ps1` | Regenerates `mmd/`, `svg/`, `png/` from the `.md` files | script |

## Concurrency notation

Every diagram is annotated with how the code is serialized. The markers are the
same across all seven files.

| Marker | Meaning |
|---|---|
| `[P xN]` | **Parallel.** N goroutines execute this concurrently. |
| `[S x1]` | **Serial.** Exactly one goroutine, strictly sequential. |
| `[1/key]` | **Per-key serialized.** The workqueue guarantees at most one in-flight execution per app key, so parallelism is across *different* apps only. |
| `[LOCK]` | Guarded by a mutex. Concurrent callers serialize here. |
| `[SEM N]` | Bounded by a weighted semaphore of N permits. |
| `[ANY]` | Reached from several different goroutines. Must be goroutine-safe; holds no assumptions about its caller. |
| `[I/O]` | Blocking call to something outside the process — repo-server, Kubernetes API, or Redis. Occupies its worker slot for the whole duration. |

A few compound forms appear where the plain marker would lose information:

| Form | Reads as |
|---|---|
| `[P per-cluster]` | Parallel, but N is the number of managed clusters rather than a configured worker count. Only `handleObjectUpdated`. |
| `[LOCK across I/O]` | The mutex is held while a network call completes, so contention shows up as latency. Only `appProjCache.GetAppProject`. |
| `[S x1 each]` | Several independent singletons, not one goroutine shared between them. Used for the background goroutines in diagram 02. |

Thick edges (`==>`) mark a **cross-goroutine handoff**: work leaving the current
goroutine via a queue or an API write, to be picked up later by a different worker
class. Plain edges are ordinary in-goroutine calls.

Fill colours carry the same information, for skimming:

| Colour | Class |
|---|---|
| blue | parallel entry point |
| green | serial entry point |
| amber | lock-serialized |
| red | semaphore-bounded, or a cross-goroutine handoff |
| purple | blocking `[I/O]` |
| teal | `[ANY]` — many caller goroutines, but no lock of its own |
| grey | work queue |

`N` in `[P xN]` is the configured worker count, shown at its default:

| Value | Flag | Env | Default |
|---|---|---|---|
| `statusProcessors` | `--status-processors` | `ARGOCD_APPLICATION_CONTROLLER_STATUS_PROCESSORS` | 20 |
| `operationProcessors` | `--operation-processors` | `ARGOCD_APPLICATION_CONTROLLER_OPERATION_PROCESSORS` | 10 |
| `kubectlParallelismLimit` | `--kubectl-parallelism-limit` | `ARGOCD_APPLICATION_CONTROLLER_KUBECTL_PARALLELISM_LIMIT` | 20 |

All three are read in `cmd/argocd-application-controller/commands/argocd_application_controller.go`.
A `kubectl-parallelism-limit` below 1 leaves `ctrl.kubectlSemaphore` nil, which
disables the bound entirely.

### The one rule that is easy to miss

Per-key serialization is **per queue, not global**. `appRefreshQueue` and
`appOperationQueue` maintain independent `processing` sets, so the same
Application can be inside `processAppRefreshQueueItem` and
`processAppOperationQueueItem` at the same instant. That race is the reason the
operation worker re-GETs the app from the API server instead of trusting the
informer, and the reason `autoSync` treats `ErrAnotherOperationInProgress` as
benign.

## Viewing

Three options, easiest first:

1. **`svg/`** — open in any browser or image viewer, no tooling needed.
2. **`.md` files** — render natively in VS Code / Kiro Markdown preview, GitHub, and
   GitLab.
3. **`mmd/`** — paste into <https://mermaid.live>, or re-render locally.

## Editing

The **`.md` files are the source**. `mmd/`, `svg/`, and `png/` are all generated
from the fenced ` ```mermaid ` block inside each `NN-*.md`.

Edit the `.md`, then regenerate:

```powershell
npm install -g @mermaid-js/mermaid-cli
cd app_controller_uml
.\sync-diagrams.ps1              # all seven
.\sync-diagrams.ps1 -Only 04,06  # just these
```

`sync-diagrams.ps1` extracts each mermaid block to `mmd/`, renders `svg/` and
`png/`, fails loudly on a Mermaid parse error, and warns if a block contains
non-ASCII characters.

**Do not hand-edit anything in `mmd/`** — it is overwritten on the next run.

The equivalent without the script, if you only have a shell:

```bash
cd app_controller_uml/mmd
for f in *.mmd; do
  mmdc -i "$f" -o "../svg/${f%.mmd}.svg" -b white
  mmdc -i "$f" -o "../png/${f%.mmd}.png" -b white -s 2
done
```

All seven sources were verified to render without errors with `mermaid-cli` 11.16.0.

Keep the Mermaid sources **ASCII-only**. Non-ASCII glyphs (`x`-multiply signs,
arrows, guillemets, emoji) survive Mermaid but render inconsistently once the SVG
is embedded elsewhere, which is why the concurrency markers use `x` and plain
brackets. In `classDiagram` members, only bracketed suffixes like `[P x20]` are
safe — parentheses get parsed as a parameter list, `~...~` as a generic type, and
`$$...$$` loses a character.

## Source of truth

`controller/appcontroller.go`. If you change that file, these diagrams go stale —
the *content* is a hand-built snapshot, even though the rendered assets are
generated.

The concurrency annotations additionally depend on two things outside that file:

- **`Run` (lines 929-962)** — the worker fan-out. Adding, removing, or re-scoping a
  `go wait.Until` invalidates every `[P xN]` and `[S x1]` marker.
- **the flag defaults** in
  `cmd/argocd-application-controller/commands/argocd_application_controller.go` —
  the numbers in `[P x20]`, `[P x10]`, and `[SEM 20]` are defaults, not invariants.
  A cluster running non-default `--status-processors` has different arithmetic, and
  the *shape* of the diagrams still holds while the counts do not.

One claim in these diagrams comes from client-go rather than from Argo CD source:
that a single `AddEventHandler` registration drives its `AddFunc`, `UpdateFunc`, and
`DeleteFunc` from one `processorListener` goroutine, serializing them against each
other. Both informers here register exactly one handler each, which is what makes
those lanes `[S x1]`.
