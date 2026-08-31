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
| `07-fan-in-table.md` | Shared-helper fan-in and call cycles | Table |
| `mmd/` | All seven diagrams as bare `.mmd` sources | Mermaid source |
| `svg/` | Pre-rendered SVGs of the same seven diagrams | SVG |

## Viewing

Three options, easiest first:

1. **`svg/`** — open in any browser or image viewer, no tooling needed.
2. **`.md` files** — render natively in VS Code / Kiro Markdown preview, GitHub, and
   GitLab.
3. **`mmd/`** — paste into <https://mermaid.live>, or re-render locally.

To re-render after editing a `.mmd` source:

```bash
npm install -g @mermaid-js/mermaid-cli
cd app_controller_uml/mmd
for f in *.mmd; do mmdc -i "$f" -o "../svg/${f%.mmd}.svg" -b white; done
```

All seven sources were verified to render without errors with `mermaid-cli`.

## Source of truth

`controller/appcontroller.go`. If you change that file, these diagrams go stale —
they are a hand-built snapshot, not generated output.
