/**
 * Tests for js/subgraph_widgets.js: resolving the widget that supplies a
 * value (inner widget vs. a subgraph node's promoted widget) and forwarding
 * outer widget changes to the nodes inside.
 *
 * Uses the real workflow from the bug report
 * (`fixtures/saver_subgraph_promotion.json`) plus hand-built nested graphs.
 *
 * Run: node tests/subgraph_widgets.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { MockGraph, MockNode, findByTitle, loadWorkflow, makeContainer } from "./workflowLoader.mjs";

const {
    bindPromotedWidgets,
    findContainer,
    findPromotedTargets,
    getSourceWidget,
    installPromotedWidgetHooks,
    resolveWidgetSource,
} = await import(new URL("../js/subgraph_widgets.js", import.meta.url).href);

// ── Test Runner ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

/**
 * Run one named test, recording pass / fail.
 *
 * @param {string} name - Test name.
 * @param {Function} fn - Test body (throws on failure).
 * @returns {void}
 */
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (err) {
        failed++;
        console.log(`  FAIL ${name}\n       ${err.stack.split("\n").slice(0, 3).join("\n       ")}`);
    }
}

/**
 * Run one named async test, recording pass / fail.
 *
 * @param {string} name - Test name.
 * @param {Function} fn - Async test body (rejects on failure).
 * @returns {Promise<void>}
 */
async function testAsync(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (err) {
        failed++;
        console.log(`  FAIL ${name}\n       ${err.stack.split("\n").slice(0, 3).join("\n       ")}`);
    }
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const WORKFLOW = JSON.parse(readFileSync(new URL("./fixtures/saver_subgraph_promotion.json", import.meta.url), "utf8"));

/**
 * Load the bug-report workflow.
 *
 * @returns {{root: MockGraph, container: MockNode, promoted: MockNode, primitiveDriven: MockNode}}
 */
function bugWorkflow() {
    const { root } = loadWorkflow(WORKFLOW);
    const container = root.nodes.find((n) => n.subgraph);
    return {
        root,
        container,
        promoted: findByTitle(root, "Promoted to subgraph"),
        primitiveDriven: findByTitle(root, "Primitive inside subgraph"),
    };
}

/**
 * Give a node the opt-in hooks and record every call.
 *
 * @param {MockNode} node - Node to decorate.
 * @returns {{changed: Array, bound: Array}} Recorded calls.
 */
function listen(node) {
    const calls = { changed: [], bound: [] };
    node.onPromotedWidgetChanged = (name, value, host) => calls.changed.push({ name, value, host });
    node.onPromotedWidgetBound = (name, host) => calls.bound.push({ name, host });
    return calls;
}

/**
 * A Saver-like node with a `load_saved` widget input.
 *
 * @param {*} id - Node id.
 * @param {string} [value] - Inner widget value.
 * @returns {MockNode} The node.
 */
function saverLike(id, value = "None") {
    return new MockNode(id, {
        type: "PromptStashSaver",
        inputs: [{ name: "load_saved", widget: { name: "load_saved" } }],
        widgets: { load_saved: value },
    });
}

/**
 * A container node with one promoted `load_saved` input.
 *
 * @param {*} id - Node id.
 * @param {MockGraph} subgraph - Its subgraph.
 * @param {string} [value] - Outer widget value.
 * @returns {MockNode} The container.
 */
function containerLike(id, subgraph, value) {
    const node = new MockNode(id, { inputs: [{ name: "load_saved", widget: { name: "load_saved" } }] });
    return makeContainer(node, subgraph, { load_saved: value });
}

/**
 * Root -> container A (outer widget "Outer") -> container B (input fed by
 * A's subgraph input) -> Saver (input fed by B's subgraph input).
 *
 * @returns {{root: MockGraph, a: MockNode, b: MockNode, saver: MockNode}}
 */
function nestedGraph() {
    const root = new MockGraph("root");
    root.subgraphs = new Map();
    const sa = new MockGraph("sa", root);
    const sb = new MockGraph("sb", root);
    root.subgraphs.set("sa", sa);
    root.subgraphs.set("sb", sb);

    const a = root.add(containerLike(1, sa, "Outer"));
    const b = sa.add(containerLike(2, sb, "Stale middle"));
    const saver = sb.add(saverLike(3, "Stale inner"));

    sa.addInput("load_saved");
    sa.connect("-10", 0, b, 0);
    sb.addInput("load_saved");
    sb.connect("-10", 0, saver, 0);
    return { root, a, b, saver };
}

// ── Source Widget (bug-report workflow) ───────────────────────────────────

test("fixture: containers are found for the subgraph", () => {
    const { container, promoted } = bugWorkflow();
    assert.ok(container, "container present");
    assert.equal(findContainer(promoted.graph), container);
    assert.equal(findContainer(container.graph), null, "root graph has no container");
});

test("fixture: promoted Saver reads the outer widget, not its stale inner value", () => {
    const { container, promoted } = bugWorkflow();
    assert.equal(promoted.widget("load_saved").value, "None");
    assert.equal(promoted.widget("prompt_lists").value, "Flux");

    const loadSaved = getSourceWidget(promoted, "load_saved");
    const lists = getSourceWidget(promoted, "prompt_lists");
    assert.equal(loadSaved, container.widgets.find((w) => w.name === "load_saved"));
    assert.equal(loadSaved.value, "SystemPrompt Klein 9B");
    assert.equal(lists.value, "WAN Video Prompts");
});

test("fixture: unlinked widgets resolve to themselves", () => {
    const { promoted } = bugWorkflow();
    assert.equal(getSourceWidget(promoted, "prompt_text"), promoted.widget("prompt_text"));
    assert.equal(getSourceWidget(promoted, "save_as_key"), promoted.widget("save_as_key"));
});

test("fixture: Primitive-driven Saver reads its own widget", () => {
    const { primitiveDriven } = bugWorkflow();
    assert.equal(getSourceWidget(primitiveDriven, "load_saved"), primitiveDriven.widget("load_saved"));
    assert.equal(getSourceWidget(primitiveDriven, "load_saved").value, "SDXL Clean");
    assert.equal(getSourceWidget(primitiveDriven, "prompt_lists").value, "SDXL Personas");
});

test("fixture: unknown widget name resolves to null", () => {
    const { promoted } = bugWorkflow();
    assert.equal(getSourceWidget(promoted, "nope"), null);
});

// ── Targets (bug-report workflow) ─────────────────────────────────────────

test("fixture: each container input feeds only the promoted Saver", () => {
    const { container, promoted } = bugWorkflow();
    for (const name of ["load_saved", "prompt_lists"]) {
        const input = container.inputs.find((i) => i.name === name);
        const targets = findPromotedTargets(container, input);
        assert.equal(targets.length, 1, name);
        assert.equal(targets[0].node, promoted, name);
        assert.equal(targets[0].widgetName, name);
    }
});

// ── Forwarding ────────────────────────────────────────────────────────────

test("bind: opted-in node is told about its outer widgets", () => {
    const { container, promoted } = bugWorkflow();
    const calls = listen(promoted);
    bindPromotedWidgets(container);
    assert.deepEqual(calls.bound.map((c) => c.name).sort(), ["load_saved", "prompt_lists"]);
    assert.equal(calls.bound.find((c) => c.name === "load_saved").host.value, "SystemPrompt Klein 9B");
    assert.equal(calls.changed.length, 0, "binding is not a change");
});

test("bind: outer change stores the value, then notifies the node inside", () => {
    const { container, promoted } = bugWorkflow();
    const calls = listen(promoted);
    bindPromotedWidgets(container);
    const host = container.widgets.find((w) => w.name === "load_saved");

    let storedFirst = false;
    promoted.onPromotedWidgetChanged = (name, value) => {
        storedFirst = host.value === "Other";
        calls.changed.push({ name, value });
    };
    host.callback("Other");

    assert.equal(host.value, "Other");
    assert.ok(storedFirst, "original callback ran before the notification");
    assert.deepEqual(calls.changed, [{ name: "load_saved", value: "Other" }]);
});

test("bind: is idempotent (one notification per change)", () => {
    const { container, promoted } = bugWorkflow();
    const calls = listen(promoted);
    bindPromotedWidgets(container);
    bindPromotedWidgets(container);
    container.widgets.find((w) => w.name === "prompt_lists").callback("SDXL Personas");
    assert.equal(calls.changed.length, 1);
});

test("bind: widgets feeding no opted-in node are left alone", () => {
    const { container } = bugWorkflow();
    const before = container.widgets.map((w) => w.callback);
    bindPromotedWidgets(container);
    assert.deepEqual(container.widgets.map((w) => w.callback), before);
});

test("hooks: a rebuilt outer widget is wrapped again on widget-promoted", () => {
    const { container, promoted } = bugWorkflow();
    const calls = listen(promoted);
    installPromotedWidgetHooks(container);

    // The frontend replaces the outer widget object on re-promotion.
    const index = container.widgets.findIndex((w) => w.name === "load_saved");
    const fresh = { name: "load_saved", value: "Fresh", options: { values: [] } };
    fresh.callback = (next) => {
        fresh.value = next;
    };
    container.widgets[index] = fresh;
    container.subgraph.events.dispatchEvent(
        new CustomEvent("widget-promoted", { detail: { subgraphNode: container } })
    );

    fresh.callback("After");
    assert.deepEqual(calls.changed.map((c) => [c.name, c.value]), [["load_saved", "After"]]);
});

await testAsync("hooks: an outer widget rebuilt silently into input._widget is wrapped", async () => {
    const { container, promoted } = bugWorkflow();
    const calls = listen(promoted);
    const input = container.inputs.find((i) => i.name === "load_saved");
    input._widget = container.widgets.find((w) => w.name === "load_saved");
    installPromotedWidgetHooks(container);

    // The frontend's widgets getter re-projects a fresh object, no event.
    const fresh = { name: "load_saved", value: "Lazy", options: { values: [] } };
    fresh.callback = (next) => {
        fresh.value = next;
    };
    input._widget = fresh;
    assert.equal(input._widget, fresh, "slot still reads back what was written");
    await Promise.resolve();

    fresh.callback("Changed");
    assert.equal(fresh.value, "Changed");
    assert.deepEqual(calls.changed.map((c) => [c.name, c.value]), [["load_saved", "Changed"]]);
});

test("hooks: removing the container drops the listener", () => {
    const { container, promoted } = bugWorkflow();
    const calls = listen(promoted);
    installPromotedWidgetHooks(container);
    container.onRemoved();
    calls.bound.length = 0;
    container.subgraph.events.dispatchEvent(
        new CustomEvent("widget-promoted", { detail: { subgraphNode: container } })
    );
    assert.equal(calls.bound.length, 0);
});

// ── Nested Subgraphs ──────────────────────────────────────────────────────

test("nested: source is the outermost container's widget", () => {
    const { a, saver } = nestedGraph();
    const source = getSourceWidget(saver, "load_saved");
    assert.equal(source, a.widgets[0]);
    assert.equal(source.value, "Outer");
});

test("nested: targets are followed down to the real node", () => {
    const { a, saver } = nestedGraph();
    const targets = findPromotedTargets(a, a.inputs[0]);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].node, saver);
    assert.equal(targets[0].widgetName, "load_saved");
});

test("nested: only the outermost widget is bound and forwarded", () => {
    const { a, b, saver } = nestedGraph();
    const calls = listen(saver);
    const middleCallback = b.widgets[0].callback;

    bindPromotedWidgets(b);
    assert.equal(b.widgets[0].callback, middleCallback, "linked middle input not wrapped");
    assert.equal(calls.bound.length, 0);

    bindPromotedWidgets(a);
    assert.equal(calls.bound.length, 1);
    assert.equal(calls.bound[0].host, a.widgets[0]);

    a.widgets[0].callback("Picked");
    assert.deepEqual(calls.changed.map((c) => [c.name, c.value]), [["load_saved", "Picked"]]);
});

test("nested: outermost input fed by another node -> unknown source", () => {
    const { root, a, saver } = nestedGraph();
    const feeder = root.add(new MockNode(9, { outputs: [{ name: "out" }] }));
    root.connect(feeder, 0, a, 0);
    assert.equal(getSourceWidget(saver, "load_saved"), null);
});

/**
 * Root -> Primitive -> container A's input -> Saver inside.
 *
 * @returns {{root: MockGraph, a: MockNode, saver: MockNode, primitive: MockNode}}
 */
function primitiveFedContainer() {
    const root = new MockGraph("root");
    root.subgraphs = new Map();
    const sa = new MockGraph("sa", root);
    root.subgraphs.set("sa", sa);
    const a = root.add(containerLike(1, sa, "Outer"));
    const saver = sa.add(saverLike(2, "Inner"));
    sa.addInput("load_saved");
    sa.connect("-10", 0, saver, 0);
    const primitive = root.add(new MockNode(5, { type: "PrimitiveNode", outputs: [{ name: "COMBO" }] }));
    primitive.isVirtualNode = true;
    root.connect(primitive, 0, a, 0);
    return { root, a, saver, primitive };
}

test("primitive-fed container: source is the container's widget", () => {
    const { a, saver } = primitiveFedContainer();
    assert.equal(getSourceWidget(saver, "load_saved"), a.widgets[0]);
    const source = resolveWidgetSource(saver, "load_saved");
    assert.equal(source.node, a);
    assert.equal(source.widget.name, "load_saved");
});

test("primitive-fed container: widget is bound and forwards the Primitive's writes", () => {
    const { a, saver } = primitiveFedContainer();
    const calls = listen(saver);
    bindPromotedWidgets(a);
    assert.equal(calls.bound.length, 1);
    // What the Primitive's applyToGraph does: set the value, call the callback.
    a.widgets[0].value = "FromPrimitive";
    a.widgets[0].callback(a.widgets[0].value);
    assert.deepEqual(calls.changed.map((c) => [c.name, c.value]), [["load_saved", "FromPrimitive"]]);
});

test("direct link from a node (Primitive) keeps the widget itself", () => {
    const g = new MockGraph("root");
    const primitive = g.add(new MockNode(1, { type: "PrimitiveNode", outputs: [{ name: "COMBO" }] }));
    const saver = g.add(saverLike(2, "Chosen"));
    g.connect(primitive, 0, saver, 0);
    assert.equal(getSourceWidget(saver, "load_saved"), saver.widget("load_saved"));
});

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
