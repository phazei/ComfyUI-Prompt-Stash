# AGENT.md

Guidelines for working on this project. Read this before making changes.

## Project Goals

Prompt Stash is a small ComfyUI custom node pack for saving prompts into named lists and capturing text from upstream nodes (LLMs, etc.). The philosophy:

- **Small and focused** -- three nodes, one shared JSON library, no extra dependencies
- **Never break saved workflows** -- widget order, node class names and the data file format are effectively public API
- **Work on both renderers** -- classic LiteGraph canvas and the Vue (Nodes 2.0) renderer, plus nodes inside subgraphs
- **Robust error handling** -- a missing/corrupt data file or an odd frontend version must not crash ComfyUI or the node

## Architecture

### Layout

| File | Purpose |
|------|---------|
| `__init__.py` | HTTP routes (save/delete/init/get_prompt/list ops/import/export) + node registration |
| `prompt_stash_saver_node.py` | `PromptStashSaver` -- prompt box, save/load from lists, `text` + `meta` outputs |
| `prompt_stash_passthrough_node.py` | `PromptStashPassthrough` -- text capture + "pause to edit"; owns the `continue` / `clear_all` routes |
| `prompt_stash_manager_node.py` | `PromptStashManager` -- add/delete/sort lists (no outputs, UI-only node) |
| `prompt_stash_every_nth_node.py` | `PromptStashEveryNthQueue` -- BOOLEAN True once every N queues; the countdown lives in the frontend |
| `data_utils.py` | Data file location/init/migration, import validation + merge, workflow/prompt helpers |
| `default_prompt_stash_data.json` | Template copied to the user data file on first run |
| `js/*.js` | Frontend extensions, one per node + `multi_button.js` widget + shared `utils.js` |
| `node_list.json` | Registry descriptions per node |
| `example_workflows/` | Sample workflow (JSON + PNG) |

### Python (Nodes + Routes)

- **V1 schema** (`INPUT_TYPES`, `RETURN_TYPES`, `FUNCTION`, `NODE_CLASS_MAPPINGS` in `__init__.py`). This pack is NOT on V3 -- don't mix in `comfy_api.latest` / `comfy_entrypoint` piecemeal. Adding `comfy_entrypoint` does nothing while `NODE_CLASS_MAPPINGS` exists (ComfyUI's loader takes the V1 branch). A V3 migration would be a deliberate, whole-pack change that must keep the class names and widget order
- Node class names (`PromptStashSaver`, `PromptStashPassthrough`, `PromptStashManager`) are the workflow `type` -- never rename them
- All nodes live in category `utils`
- `WEB_DIRECTORY = "./js"`
- Routes are plain `@PromptServer.instance.routes.post/get(...)` decorators at module import. Prefixes: `/prompt_stash_saver/*` (also hosts list ops: `add_list`, `delete_list`, `sort_list`), `/prompt_stash_manager/*` (import/export), `/prompt_stash_passthrough/*` (continue, clear_all)
- Route handlers create a **fresh node instance per request** (`PromptStashSaver()` / `PromptStashManager()`), and `__init__` re-reads the data file from disk. There is no in-memory cache shared between requests, and no file lock
- Server -> client pushes go through `PromptServer.instance.send_sync(...)`:
  - `prompt-stash-update-all` `{lists}` -- after any data change, and **also on every `PromptStashSaver()` construction** (`load_data()` broadcasts). Saver JS relies on this: it calls `/prompt_stash_saver/init` and ignores the response, getting its lists from the broadcast that the constructor sends. Don't remove the broadcast from `load_data()` without changing `prompt_stash_saver.js` to read the `init` response
  - `prompt-stash-update-prompt` `{node_id, prompt}` -- captured input text pushed into the node's prompt box
  - `prompt-stash-set-continue` `{node_id, show}` -- show/hide the Passthrough Continue button
- Output messages use `print(...)`, prefixed `Prompt Stash:` for normal messages (no `logging` module in use)

### Data File

- Location: `folder_paths.get_user_directory()/prompt_stash/prompt_stash_data.json` (`get_user_data_directory()`). Fallback when that fails: `prompt_stash_data.json` in the node folder (gitignored)
- `init_data_file()` handles: one-time migration from the old node-folder location (copy then delete), first-run seeding from `default_prompt_stash_data.json` (or a built-in minimal default), and adding `"version"` to old files
- Format: `{"version": "1.0", "lists": {list_name: {prompt_name: prompt_text}}}`. Dict key order is the display order (Sort A-Z rewrites it with `casefold()`)
- Unknown list names on save/get fall back to `"default"`. The last remaining list can't be deleted (`len(lists) <= 1`); `"default"` itself is deletable
- Import (`validate_import_data` + `deep_merge_lists`): drops invalid entries, strips names, merges into existing lists, renames clashes to `name (2)`, `name (3)`... Never overwrites. Returns a summary shown in a toast
- Export streams the raw file as `prompt_stash_export_<timestamp>.json`
- Always write with `encoding='utf-8'`, `indent=2` -- users hand-edit and diff this file

### Node Behaviour

- **Saver / Passthrough shared pattern**:
  - `use_input_text` (BOOLEAN) chooses between the `text` input (lazy, `forceInput`) and the `prompt_text` widget
  - `check_lazy_status` requests `text` only when `use_input_text` is on. If `text` isn't in the prompt at all it raises a clear `ValueError` (`prompt_has_input`) instead of ComfyUI's "says it needs input text, but there is no input to that node at all"
  - `IS_CHANGED` hashes the inputs that affect output; `text` only counts when `use_input_text` is on
  - When input text is used, `process()` pushes it to the UI (`prompt-stash-update-prompt`) **and rewrites the saved metadata**: in `extra_pnginfo.workflow` (via `update_node_in_workflow`, subgraph-aware) sets `use_input_text=False` and `prompt_text=<captured>`, and does the same in `prompt`. Loading an output image therefore reproduces the captured text without re-running the LLM
- **Saver**: outputs `text` and `meta` (JSON string: `prompt_name`, `list_name`, `source` = `input|saved|manual`, `save_as_key`, `load_saved`, `use_input_text`; precedence documented in `build_meta`). `load_saved` / `prompt_lists` are COMBOs declared in Python with stub values (`["None"]` / `["default"]`) only so the frontend creates Primitive-connectable input sockets; real options are filled client-side. `VALIDATE_INPUTS` takes those two params so ComfyUI skips static combo validation for them
- **Passthrough**: `pause_to_edit` blocks the executor thread in a `time.sleep(0.1)` loop until `/prompt_stash_passthrough/continue/{node_id}` sets status `"continue"` (with the edited text). State is in class-level dicts (`status_by_id`, `edited_text_by_id`) keyed by the **string** UNIQUE_ID (`"5"` or `"12:5"` in subgraphs). Re-sends `set-continue` every 2s so a refreshed browser gets the button back. `/clear_all` (Manager's "(Clear All Paused)" button) releases every paused node
- **Manager**: no outputs, `process()` is a no-op. The `existing_lists` combo is created in JS (not declared in Python)
- **Every Nth Queue**: `every` (INT) + hidden `value` (BOOLEAN, socket removed in JS); `process()` just returns `value`. The countdown is `node.properties.countdown` (1 = True next run), never sent to the backend. A widget `beforeQueued` hook (called by the frontend once per queued prompt, before `graphToPrompt`, for nodes in subgraphs too) writes `value` and advances the countdown -- skipped for muted/bypassed nodes, and not advanced on partial execution. Only `value` reaches the backend, so off runs share one cache key

### JavaScript (Frontend Extensions)

- Plain ES modules, no build step. Imports: `import { app } from "../../scripts/app.js"`, `import { api } from "../../scripts/api.js"`, shared helpers from `./utils.js`
- Extension names: `phazei.PromptStashSaver`, `phazei.PromptStashPassthrough`, `phazei.PromptStashManager`, `phazei.PromptStashEveryNthQueue`, `phazei.MULTI_BUTTON`
- Pattern: `beforeRegisterNodeDef` -> wrap `nodeType.prototype.onNodeCreated` (always call the original first) -> find widgets by `.name` -> attach callbacks / listeners -> wrap `onRemoved` to remove every `api` listener and interval
- Event handlers are stored on the node (`this.handlePromptStash...`) so `onRemoved` can unregister the same function. Each handler starts with `if (isUnassignedNode(this)) { this.onRemoved?.(); return; }` to drop listeners of detached/zombie nodes
- Match server pushes to nodes with `nodeMatchesUniqueId(node, event.detail.node_id)`; build ids to send with `getUniqueIdFromNode(node)`. Both are subgraph-aware
- Labels via `setDefaultLabel(node, widget, "Label")` -- only changes `.label`, keeps a user's rename. Never change `widget.name` (it must equal the Python input key)
- Buttons via the custom `MULTI_BUTTON` widget (`js/multi_button.js`, registered through `getCustomWidgets`): a row of canvas-drawn buttons, `serialize: false`, supports `confirm`, `setDisabled(i, bool)`, `update()`, optional single/multi select. Used by Saver (Save / Delete) and Manager (Sort / Add / Delete, Export / Import, and a decorative easter-egg row named `actions`). Guarded with `typeof app.widgets?.MULTI_BUTTON === "function"`
- Toasts via `app.extensionManager?.toast?.add({...})` -- always optional-chained
- Global "R" refresh: Saver implements the extension's `refreshComboInNodes()` hook, walking all graphs (`walkGraph`) and calling `node._repopulateCombos()` because `reloadNodeDefs` resets combos to the Python stubs

### Shared Utilities (`js/utils.js`)

- `nodeMatchesUniqueId`, `getUniqueIdFromNode`, `isUnassignedNode`, `walkGraph`, `setDefaultLabel`
- Primitive-node support: `findGetConfigSymbol`, `installComboGetConfig`, `refreshConnectedPrimitives`, `syncValueToConnectedPrimitive`
- `forceWidgetReactiveUpdate(node, widget)` -- Vue re-render + clears `value_not_in_list` error

## LiteGraph + Nodes 2.0 Compatibility

Every UI change must work on **both** renderers. Both use the same `LGraphNode` objects, widgets and callbacks. They differ in how nodes are drawn and receive input:
- **LiteGraph (classic)**: nodes and widgets are painted on the graph `<canvas>`, and mouse events reach the node's `onMouse*` handlers.
- **Nodes 2.0 (Vue)**: each node is a Vue DOM component (`[data-node-id="<id>"]`) layered over the canvas. Widgets are Vue components that read reactive state, and canvas-drawn custom widgets are hosted in a small per-widget canvas (`WidgetLegacy.vue`).

The user can switch renderers while a workflow is open, so **don't decide the renderer once in `onNodeCreated`**. Check at the moment you act, as `handlePromptStashSetContinue` does with `isVueRenderer()`, or do both paths when both are harmless.

### Works the same on both (prefer these)
- Reading and writing `widget.value`, `widget.label`, `widget.callback`, finding widgets by `.name`
- `api` events, routes, toasts (`app.extensionManager?.toast`)
- `node.setDirtyCanvas(true, true)` / `app.graph.setDirtyCanvas(...)`: needed for LiteGraph and harmless under Vue. Keep calling it
- Built-in widget types declared in Python (`STRING`, `BOOLEAN`, COMBO): the frontend renders them natively in both modes. Declaring a widget in `INPUT_TYPES` is more robust than creating it in JS

Prefer the frontend's own data model (widgets, values, labels) over custom drawing. That way both renderers pick up the change without extra code.

### LiteGraph-only. Needs a separate Vue path
- **Painting on the node** (`onDrawForeground` / `onDrawBackground`): Vue nodes don't use it. Passthrough's Continue button is drawn in the title bar on the canvas and also added as a DOM `<button>` for Vue (`updateDomContinueButton`). Any new canvas-drawn decoration needs the same DOM counterpart
- **Node mouse handlers** (`onMouseDown` / `onMouseMove` / `onMouseLeave` with node-local hit-testing against stored rects like `buttonArea`): these don't drive Vue nodes. Give the DOM element its own listeners
- **`computeSize` overrides**: they set the LiteGraph size. Don't assume they have the same effect on Vue nodes; check the layout visually in both modes

### Vue-only requirements
- **Reactivity of combo options**: mutating `widget.options.values` from JS is invisible to Vue, and assigning the same value is skipped (`Object.is`). After changing options, call `triggerComboReactivity(widget)` (own widgets) or `forceWidgetReactiveUpdate(node, widget)` (also fires `node.onWidgetChanged` to clear the red `value_not_in_list` outline). They write `value + "\x00"`, then the real value. The intermediate value is never rendered because Vue batches synchronous updates. This also applies to **other** nodes you update, such as connected Primitives (`refreshConnectedPrimitives`)
- **Custom canvas widgets** (`MULTI_BUTTON`):
  - Redraw with both `node.setDirtyCanvas(...)` and `widget.triggerDraw?.()`. `triggerDraw` is set by `WidgetLegacy.vue` and is undefined on the classic canvas, so always optional-chain it
  - `pointerup` coordinates arrive in a different space from `pointerdown` in the Vue host canvas. Record the hit on `pointerdown` and trust that index when the `pointerup` hit-test misses (see `MULTI_BUTTON.mouse`)
  - Accept both `mouse(event, x, y)` and `mouse(event, [x, y])` signatures
  - Keep a fixed height from `computeSize` and draw only inside the `(width, y)` you're given
- **DOM injection into Vue nodes**:
  - Find the element with ``document.querySelector(`[data-node-id="${node.id}"]`)`` and **null-check** it. It doesn't exist yet right after a state change (defer: Continue uses `setTimeout(..., 50)`), and only nodes in the graph being viewed are rendered
  - Make creation idempotent: look for your class (`.prompt-stash-continue-btn`) before adding
  - Vue owns the element and can re-create it (re-render, entering/leaving a subgraph, switching workflows), dropping your additions. Re-assert state rather than assuming it persists. The Passthrough backend re-sends `prompt-stash-set-continue` every 2s, and the handler re-adds the button
  - Style inline (only `.js` is auto-loaded, there's no CSS file) and call `e.stopPropagation()` in click handlers so the canvas doesn't also handle the click
  - Remove injected elements in `onRemoved`
- **Badges** (`node.badges`) aren't reactive from extension JS. If live badge text is ever needed, update the DOM directly (see the Enhancement-Utils profiler for the approach)

### General rules from the shared frontend
- **Positions**: write `node.pos = [x, y]` (goes through the setter that updates Vue's layout store). Never `node.pos[0] = x`. That mutates the array directly and Vue never sees it. Reading `node.pos[0]` is fine
- **IDs**: `node.id` is a string on current frontends. The `[data-node-id]` attribute and server `node_id` comparisons must use the string form
- **Feature-detect, don't version-check**: `typeof app.widgets?.MULTI_BUTTON === "function"`, `widget.triggerDraw?.()`, `node.onWidgetChanged?.(...)`

## Code Style

### Python

- Docstrings on non-trivial functions (newer code has them; add them when touching older code)
- Keep `INPUT_TYPES`, `IS_CHANGED`, `check_lazy_status` and `process` signatures in sync -- every one lists all inputs including hidden ones, with the same defaults
- Imports: standard library, then ComfyUI (`server`, `folder_paths`, `comfy`), then local (`.data_utils`)
- Wrap all file I/O in try/except; return `False` / fallback data rather than raising from routes

### JavaScript

- JSDoc on helper functions with `@param` / `@returns`
- Section headers: `// ── Section Name ──────────`
- `const` by default, `let` only when reassigned, never `var`
- Arrow functions for callbacks; per-node methods attached as `this._name = () => {...}` (hoisted no-op first if other code may call it early, e.g. `_refreshSaveDeleteRow`)
- Defensive checks everywhere: `this.widgets.find(...)` results, `node.inputs ?? []`, `?.` on frontend APIs that vary between versions
- After changing widget values from code: `this.serialize_widgets = true` and `app.graph.setDirtyCanvas(true, true)`
- Long explanatory comments for any frontend workaround, including *why* and the ComfyUI version/issue that caused it

## Key Gotchas

### Widget Order Is Saved Workflow Format
`widgets_values` in saved workflows is positional. `forceInput` inputs (`text`) don't take a slot. New inputs must be **appended at the end** of `optional`; never reorder or remove existing ones. `process()` writes metadata by index: Saver `0 = use_input_text`, `1 = prompt_text`; Passthrough adds `2 = pause_to_edit`. Update those indices if the layout ever changes.

### Lazy Inputs Still Invalidate the Cache
ComfyUI folds the full signature of every *linked* upstream node into a node's cache key, even for lazy inputs it never requests (ComfyUI issue #11744). Saver and Passthrough each wrap `app.graphToPrompt` once (`patchGraphToPromptOnce`) and delete the `text` link from the API prompt when `inputs.use_input_text === false`. The decision is made **from the API prompt**, not the canvas widget -- the widget can be stale (promoted to a subgraph input, driven by a link). If they disagreed, the backend would request a `text` input that had been stripped. Only strip literal `false`; a link or missing value means unknown, keep it.

### Combo Options Live Only on the Client
The real `load_saved` / `prompt_lists` options are never sent to the backend's node definition. Consequences:
- `VALIDATE_INPUTS` must keep `load_saved` and `prompt_lists` as parameters, or every real selection fails validation as "value not in list"
- `/object_info` and the "R" refresh show the stubs; `refreshComboInNodes()` repopulates from the node's surviving `this.data`
- Primitive nodes read combo options via a framework-internal **anonymous symbol** (GET_CONFIG) on the input's widget. It isn't importable, so `findGetConfigSymbol` discovers it at runtime (symbol-keyed function returning an array) and `installComboGetConfig` overrides it to return live options, falling back to last-known-good when the live list looks like the stub. Installed one `requestAnimationFrame` after creation because input slots aren't wired yet in `onNodeCreated`
- The value sync is normally one-way (Primitive -> node). When the node changes its own value (save, delete, prompt edit clears selection), `syncValueToConnectedPrimitive` pushes it back **without** calling the Primitive's callback (avoids ping-pong). On delete, set the value *before* `_syncComboInput`, or `refreshComboInNode` clamps the Primitive to `"None"`

### Two Renderers
See [LiteGraph + Nodes 2.0 Compatibility](#litegraph--nodes-20-compatibility). The usual failures are:
- Changed combo options that don't show in Vue (no reactivity trigger)
- Canvas-drawn UI that's missing in Vue (no DOM counterpart)
- Buttons that don't respond in Vue (`pointerup` coordinate mismatch)

### Node IDs Are Strings
Frontend >= 1.46 brands `node.id` as a string (`"5"`); an unassigned node is `"-1"`. Always compare with `String(...)` (see `nodeMatchesUniqueId`, `isUnassignedNode`). On the Python side, UNIQUE_ID is a string and may contain `:` subgraph paths -- the Passthrough continue route receives it in the URL and must use the same string as the dict key.

### Subgraphs
- UNIQUE_ID for nodes inside subgraphs is a path (`"54:62:73"`). `update_node_in_workflow` walks `workflow.nodes` -> `definitions.subgraphs[*].nodes` by that path
- `app.graph` is the root graph; walk subgraphs with `walkGraph` (uses `node.subgraph`)

### Pause-to-Edit Blocks Execution
The paused node sleeps in ComfyUI's executor thread -- the whole queue waits. If the browser tab is closed while paused, the only ways out are the Continue button after reopening (re-sent every 2s) or Manager's "(Clear All Paused)". ComfyUI's Interrupt does **not** break the loop (it doesn't check `comfy.model_management.processing_interrupted()`). Changing pause state must not change `IS_CHANGED` (it's deliberately excluded from the hash).

### Endpoints Called Two Ways
Most JS uses `api.fetchApi('/...')` (respects ComfyUI's API base path). Manager's import uses raw `fetch('/prompt_stash_manager/import')` and export uses an `<a href="/prompt_stash_manager/export">` -- these assume ComfyUI is served at the root. Prefer `api.fetchApi` / `api.apiURL(...)` for anything new.

## Adding New Features

### New Widget / Input on an Existing Node
1. Append it at the **end** of `optional` in `INPUT_TYPES`
2. Add it (with the same default) to `IS_CHANGED`, `check_lazy_status` and `process` signatures; include it in the `IS_CHANGED` hash if it affects output
3. Find it in JS by `.name`, label it with `setDefaultLabel`
4. Load an old saved workflow and confirm existing widget values still map correctly
5. Check it on both renderers (see Testing)

### New UI Element (button, indicator, overlay)
1. Prefer a real widget (Python-declared or `MULTI_BUTTON`) over painting on the node, so both renderers handle it
2. If it must be custom-drawn, write the LiteGraph version and the Vue DOM version together, sharing one handler (like `handleContinueClick`)
3. Pick the path at the moment you act (`isVueRenderer()`), not in `onNodeCreated`
4. Clean up DOM elements, intervals and listeners in `onRemoved`

### New Node
1. Create `prompt_stash_<name>_node.py` with a V1-style class
2. Import it in `__init__.py`, add to `NODE_CLASS_MAPPINGS` and `NODE_DISPLAY_NAME_MAPPINGS`, and add a description to `node_list.json`
3. Add `js/prompt_stash_<name>.js` with `app.registerExtension({ name: "phazei.<Name>", ... })` following the `onNodeCreated` / `onRemoved` pattern above
4. If it reads/writes the stash, use `init_data_file()` and broadcast `prompt-stash-update-all` after successful writes
5. Document it in `README.md`

### New Route
- Register with `@PromptServer.instance.routes.<method>(...)` using one of the existing prefixes
- Return `web.json_response(...)`; give errors a JSON `{"error": ...}` body and a 4xx/5xx status
- Broadcast `prompt-stash-update-all` after any data change so every open node updates

## Testing

There is no automated test suite. Verify manually in ComfyUI. **Run each UI check twice, once with Nodes 2.0 off and once with it on** (toggle in ComfyUI settings). Also switch renderers with the workflow open, and confirm dropdowns, buttons and the Continue button still work without reloading. Check the browser console for errors in both modes. Checks:
- Saving / loading / deleting prompts, switching lists, Manager add / delete / sort, import / export
- `use_input_text` on and off (and on with nothing connected -> clear error)
- Every Nth Queue driving `use_input_text`: off runs keep the LLM and sampler cached; batch count > 1 advances once per item
- Nodes inside a subgraph (continue button, captured text update), including entering and leaving the subgraph while paused
- Save / Delete / Sort buttons respond to clicks and grey out correctly (`MULTI_BUTTON` disabled state)
- Saving a prompt shows it in every Saver's dropdown right away, with no stale options or red outline in Vue
- A Primitive connected to `load_saved` / `prompt_lists`, including after the "R" refresh and after reloading the workflow
- Reloading an old saved workflow / image metadata

`ruff` is used for linting (`.ruff_cache/` exists; no config, so defaults).

## Release

- Version lives in `pyproject.toml`. A push to `main` that changes `pyproject.toml` triggers `.github/workflows/publish.yml` (Comfy Registry publish). Only bump the version when a release is intended
- Commit style: conventional prefixes (`feat:`, `fix:`) for recent commits

## Dependencies

None beyond ComfyUI itself (`aiohttp`, `server`, `folder_paths`, `comfy` are provided by ComfyUI).

## Reference

- [ComfyUI Custom Nodes Walkthrough](https://docs.comfy.org/custom-nodes/walkthrough)
- [ComfyUI issue #11744 -- lazy inputs and cache keys](https://github.com/Comfy-Org/ComfyUI/issues/11744)
- [Repository](https://github.com/phazei/ComfyUI-Prompt-Stash)
