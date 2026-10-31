# Tests

Plain Node tests for the pure JS modules (no npm dependencies, no browser, no ComfyUI).

```sh
node tests/subgraph_widgets.test.mjs   # promoted subgraph widgets: source lookup + change forwarding
```

Each script exits non-zero on failure.

## Files

- `workflowLoader.mjs` -- mock `LGraph` / `LGraphNode` stand-ins (`MockGraph`, `MockNode`, `makeContainer`) and `loadWorkflow(workflow)`, which builds them from a serialized workflow (UI format 0.4, root + `definitions.subgraphs`). Widgets come from `widgets_values_named`; a container's widgets are its promoted inputs, valued from its own `widgets_values_named`, with a callback that only stores the value (like the frontend's store-backed outer widgets). Adapted from ComfyUI-Enhancement-Utils.
- `subgraph_widgets.test.mjs` -- `js/subgraph_widgets.js` against the fixture below and hand-built nested subgraphs: the widget that supplies a value (own widget, outer widget, outermost widget through nesting, unknown when the outer input is fed by another node), the nodes a container input feeds, wrapping / re-wrapping outer widget callbacks and forwarding changes to opted-in nodes.
- `fixtures/saver_subgraph_promotion.json` -- the workflow from the subgraph bug report. One subgraph with two Prompt Stash Savers: "Promoted to subgraph" has `load_saved` / `prompt_lists` linked to subgraph inputs (outer values `SystemPrompt Klein 9B` / `WAN Video Prompts`, stale inner values `None` / `Flux`); "Primitive inside subgraph" is driven by two Primitive nodes inside the subgraph.

## Limits

The mocks cover graph structure only. Frontend behaviour still needs checking by hand (see "Testing" in `AGENTS.md`): that both renderers call the outer widget's callback, that writing `.value` / `.options` on it updates what is shown, and Vue re-rendering.
