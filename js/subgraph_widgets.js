/**
 * Promoted subgraph widgets: finding the widget that really supplies a value,
 * and forwarding changes made on a subgraph node's widgets to the nodes inside.
 *
 * When a node's widget input inside a subgraph is linked to a subgraph input,
 * the frontend "promotes" it: the subgraph node (the container) shows its own
 * widget for that input. On current frontends (checked against 1.57) that
 * outer widget:
 *   - keeps its OWN value (widgetValueStore, keyed by the container's id); the
 *     inner widget keeps a stale value that the backend never sees -- at queue
 *     time the outer value is substituted;
 *   - got its options as a deep copy taken at promotion time, so later changes
 *     to the inner widget's options never reach it;
 *   - has a `callback` that only writes the store. The inner widget's callback
 *     never runs, so node logic driven by it (Saver: load the selected prompt,
 *     refilter the list) never runs either.
 *
 * Both renderers call the outer widget's `callback` when the user changes it
 * (classic canvas: BaseWidget.setValue; Vue: processedWidgetRenderModel's
 * update handler). Only the classic canvas also calls the container's
 * `onWidgetChanged`, so the callback is the hook. The outer widget object is
 * rebuilt on every (re)promotion (the subgraph then dispatches
 * `widget-promoted`) and also lazily, with no event, by the container's
 * `widgets` getter. Both are caught: the event re-binds, and each input's
 * `_widget` slot is watched (`trapInputWidget`).
 *
 * Inner nodes opt in by defining:
 *   - `onPromotedWidgetChanged(widgetName, value, hostWidget)` -- the user
 *     changed the outer widget;
 *   - `onPromotedWidgetBound(widgetName, hostWidget)` (optional) -- the outer
 *     widget was (re)created; sync state without side effects.
 *
 * Pure module: no `app` import, so it runs under Node with mock graphs
 * (tests/subgraph_widgets.test.mjs).
 */

import { walkGraph } from "./utils.js";

/** Origin id of links that start at a subgraph's input node (a string since frontend 1.46). */
export const SUBGRAPH_INPUT_ID = "-10";

/** Marks an outer widget whose callback has already been wrapped. */
const WRAPPED = Symbol("promptStashPromotedWrap");

/** Marks a container input whose `_widget` slot is watched. */
const TRAPPED = Symbol("promptStashPromotedSlot");

// ── Lookups ──────────────────────────────────────────────────────────────

/**
 * The input slot that carries a widget (by `input.widget.name`, else by name).
 *
 * @param {Object} node - Node.
 * @param {string} name - Widget name.
 * @returns {Object|null} Input slot, or null.
 */
function widgetInput(node, name) {
    const inputs = node?.inputs ?? [];
    return inputs.find((i) => i?.widget?.name === name) ?? inputs.find((i) => i?.name === name) ?? null;
}

/**
 * A graph's link by id.
 *
 * @param {Object} graph - Graph or subgraph.
 * @param {*} id - Link id.
 * @returns {Object|null} Link, or null.
 */
function linkOf(graph, id) {
    if (id == null) return null;
    try {
        return graph?.getLink?.(id) ?? (graph?.links instanceof Map ? graph.links.get(id) : graph?.links?.[id]) ?? null;
    } catch {
        return null;
    }
}

/**
 * Whether a node is a subgraph container (SubgraphNode).
 *
 * @param {Object} node - Node.
 * @returns {boolean} True for containers.
 */
export function isContainer(node) {
    if (!node?.subgraph) return false;
    return typeof node.isSubgraphNode === "function" ? !!node.isSubgraphNode() : true;
}

/**
 * The container node whose subgraph is `graph`, searched from the root
 * through every nesting level. Each container has its own subgraph (copies
 * and clones get their own definition), so the first match is the one.
 *
 * @param {Object} graph - A subgraph.
 * @returns {Object|null} The container node, or null (root graph / not found).
 */
export function findContainer(graph) {
    const root = graph?.rootGraph;
    if (!root || root === graph) return null;
    let found = null;
    walkGraph(root, (node) => {
        if (!found && node.subgraph === graph) found = node;
    });
    return found;
}

/**
 * The outer widget a container shows for one of its inputs.
 *
 * @param {Object} container - Container node.
 * @param {Object} input - One of its input slots.
 * @returns {Object|null} The widget, or null when the input has none.
 */
export function hostWidgetForInput(container, input) {
    if (!input) return null;
    if (input._widget) return input._widget;
    const name = input.widget?.name ?? input.name;
    return (container?.widgets ?? []).find((w) => w?.name === name) ?? null;
}

/**
 * The container input matching a subgraph input slot.
 *
 * @param {Object} container - Container node.
 * @param {Object} subgraph - Its subgraph.
 * @param {number} slot - Subgraph input index (link `origin_slot`).
 * @returns {Object|null} Container input, or null.
 */
function containerInputForSlot(container, subgraph, slot) {
    const sgInput = subgraph?.inputs?.[slot];
    const inputs = container?.inputs ?? [];
    if (sgInput) {
        const bySlot = inputs.find((i) => i?._subgraphSlot === sgInput);
        if (bySlot) return bySlot;
        const byName = inputs.find((i) => i?.name === sgInput.name);
        if (byName) return byName;
    }
    return inputs[slot] ?? null;
}

/**
 * Whether a link starts at a virtual value node (Primitive), which copies its
 * value into the target widget and calls the widget's callback.
 *
 * @param {Object} graph - Graph holding the link.
 * @param {Object} link - The link.
 * @returns {boolean} True for Primitive-like origins.
 */
function isValueSourceLink(graph, link) {
    const origin = graph?.getNodeById?.(link.origin_id);
    return !!origin?.isVirtualNode;
}

/**
 * Whether a container input is fed from a subgraph input one level further
 * out (a nested container): its widget is hidden and stale, the outer one
 * counts.
 *
 * @param {Object} container - Container node.
 * @param {Object} input - One of its input slots.
 * @returns {boolean} True when fed from an enclosing subgraph's input.
 */
function isFedFromEnclosingSubgraph(container, input) {
    if (input?.link == null) return false;
    const link = linkOf(container.graph, input.link);
    return !!link && String(link.origin_id) === SUBGRAPH_INPUT_ID;
}

/**
 * Where the value of `node`'s widget `name` really comes from: the node and
 * input slot whose widget holds it.
 *
 * Normally the node itself (also when a Primitive or other node feeds it:
 * those copy their value into the widget). When the input is linked to a
 * subgraph input, it is the container's widget for that input, followed up
 * through nested containers -- and a Primitive feeding that container input
 * writes into the container's widget, so it stays the source.
 *
 * @param {Object} node - Node owning the widget.
 * @param {string} name - Widget name.
 * @returns {{node: Object, input: Object|null, widget: Object}|null} The
 *   source; null when it can't be determined (e.g. the outermost container
 *   input is fed by a non-Primitive node).
 */
export function resolveWidgetSource(node, name) {
    const own = (node?.widgets ?? []).find((w) => w?.name === name) ?? null;
    let current = node;
    let input = widgetInput(node, name);

    /** @returns {Object|null} The result for the current hop. */
    const here = () => {
        const widget = current === node ? own : hostWidgetForInput(current, input);
        return widget ? { node: current, input, widget } : null;
    };

    for (let guard = 0; guard < 32; guard++) {
        if (input?.link == null) return here();
        const link = linkOf(current.graph, input.link);
        if (!link) return here();
        if (String(link.origin_id) !== SUBGRAPH_INPUT_ID) {
            return current === node || isValueSourceLink(current.graph, link) ? here() : null;
        }

        const container = findContainer(current.graph);
        if (!container) return null;
        const outer = containerInputForSlot(container, current.graph, link.origin_slot);
        if (!outer) return null;
        current = container;
        input = outer;
    }
    return null;
}

/**
 * The widget that actually supplies the value of `node`'s widget `name`
 * (see `resolveWidgetSource`).
 *
 * @param {Object} node - Node owning the widget.
 * @param {string} name - Widget name.
 * @returns {Object|null} The supplying widget, or null when unknown.
 */
export function getSourceWidget(node, name) {
    return resolveWidgetSource(node, name)?.widget ?? null;
}

/**
 * The real (non-container) nodes and widget names a container input feeds,
 * followed down through nested containers.
 *
 * @param {Object} container - Container node.
 * @param {Object} input - One of its input slots.
 * @returns {Array<{node: Object, widgetName: string}>} Targets (may be empty).
 */
export function findPromotedTargets(container, input) {
    const out = [];
    const seen = new Set();

    /**
     * @param {Object} host - Container node.
     * @param {Object} hostInput - Its input slot.
     * @param {number} depth - Nesting guard.
     */
    const visit = (host, hostInput, depth) => {
        if (depth > 32 || !hostInput) return;
        const subgraph = host.subgraph;
        const index = (host.inputs ?? []).indexOf(hostInput);
        const sgInput =
            hostInput._subgraphSlot ??
            (subgraph?.inputs ?? []).find((i) => i?.name === hostInput.name) ??
            subgraph?.inputs?.[index];
        for (const linkId of sgInput?.linkIds ?? []) {
            const link = linkOf(subgraph, linkId);
            if (!link) continue;
            const target = subgraph.getNodeById?.(link.target_id);
            const targetInput = target?.inputs?.[link.target_slot];
            if (!target || !targetInput) continue;
            if (isContainer(target)) {
                visit(target, targetInput, depth + 1);
                continue;
            }
            const widgetName = targetInput.widget?.name ?? targetInput.name;
            const key = `${target.id}\u0000${widgetName}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ node: target, widgetName });
        }
    };

    visit(container, input, 0);
    return out;
}

// ── Forwarding ───────────────────────────────────────────────────────────

/**
 * Targets of a container input that opted in to promoted-widget forwarding.
 *
 * @param {Object} container - Container node.
 * @param {Object} input - Its input slot.
 * @returns {Array<{node: Object, widgetName: string}>} Opted-in targets.
 */
function listeningTargets(container, input) {
    return findPromotedTargets(container, input).filter(
        (t) => typeof t.node.onPromotedWidgetChanged === "function"
    );
}

/**
 * Wrap a container's outer widgets so user changes reach the opted-in nodes
 * inside, and tell those nodes the widgets are (re)bound. Idempotent: an
 * already wrapped widget object is left alone. Widgets whose input feeds no
 * opted-in node are not touched, nor are inputs fed from an enclosing
 * subgraph's input (a nested container: its widget is hidden and stale, the
 * outermost container's widget is the one that counts). Inputs fed by a
 * Primitive ARE bound: the Primitive writes the widget and calls its callback.
 *
 * @param {Object} container - Container node.
 * @returns {void}
 */
export function bindPromotedWidgets(container) {
    if (!isContainer(container)) return;
    for (const input of container.inputs ?? []) {
        if (!input) continue;
        trapInputWidget(container, input);
        bindInput(container, input);
    }
}

/**
 * Wrap one container input's outer widget (if it feeds an opted-in node) and
 * tell those nodes it is bound.
 *
 * @param {Object} container - Container node.
 * @param {Object} input - One of its input slots.
 * @returns {void}
 */
function bindInput(container, input) {
    if (isFedFromEnclosingSubgraph(container, input)) return;
    const host = hostWidgetForInput(container, input);
    if (!host) return;
    const targets = listeningTargets(container, input);
    if (!targets.length) return;

    if (!host[WRAPPED]) wrapHostCallback(container, input, host);

    for (const { node, widgetName } of targets) {
        try {
            node.onPromotedWidgetBound?.(widgetName, host);
        } catch (error) {
            console.error("PromptStash: promoted widget bind failed", error);
        }
    }
}

/**
 * Watch an input's `_widget` slot so every new outer widget object gets bound.
 *
 * `widget-promoted` isn't enough: the frontend also rebuilds the outer widget
 * lazily -- the container's `widgets` getter projects a fresh store-backed
 * object into `input._widget` whenever it is empty (after a store id
 * migration, `promotionUtils` re-registration, ...) without dispatching any
 * event. Seen live on 1.57.6: after a page refresh the container was hooked
 * but its outer widgets were unwrapped, so outer changes went nowhere.
 *
 * The accessor keeps the frontend's semantics (plain get / set of the same
 * value). Binding is deferred to a microtask so it never runs in the middle
 * of the frontend's own projection / render.
 *
 * @param {Object} container - Container node.
 * @param {Object} input - One of its input slots.
 * @returns {void}
 */
function trapInputWidget(container, input) {
    if (input[TRAPPED]) return;
    const desc = Object.getOwnPropertyDescriptor(input, "_widget");
    if (desc && (desc.get || desc.set || desc.configurable === false)) return;
    let current = input._widget;
    try {
        Object.defineProperty(input, "_widget", {
            configurable: true,
            enumerable: desc?.enumerable ?? true,
            get: () => current,
            set: (next) => {
                current = next;
                if (next && typeof next === "object" && !next[WRAPPED]) {
                    queueMicrotask(() => {
                        if (current === next && !next[WRAPPED]) bindInput(container, input);
                    });
                }
            },
        });
        input[TRAPPED] = true;
    } catch (error) {
        console.warn("PromptStash: could not watch promoted widget slot", error);
    }
}

/**
 * Replace an outer widget's callback with one that runs the original (which
 * stores the value) and then notifies the opted-in nodes inside. Targets are
 * looked up on every change, so relinking inside the subgraph is picked up.
 *
 * @param {Object} container - Container node.
 * @param {Object} input - The input slot the widget belongs to.
 * @param {Object} host - The outer widget.
 * @returns {void}
 */
function wrapHostCallback(container, input, host) {
    const original = host.callback;
    const wrapped = function (value, ...rest) {
        const result = original?.call(this, value, ...rest);
        // The original stored the value; read it back in case it normalised it.
        const current = host.value === undefined ? value : host.value;
        for (const { node, widgetName } of listeningTargets(container, input)) {
            try {
                node.onPromotedWidgetChanged(widgetName, current, host);
            } catch (error) {
                console.error("PromptStash: promoted widget change failed", error);
            }
        }
        return result;
    };
    try {
        host.callback = wrapped;
        if (host.callback !== wrapped) {
            Object.defineProperty(host, "callback", { value: wrapped, writable: true, configurable: true });
        }
        host[WRAPPED] = true;
    } catch (error) {
        console.warn("PromptStash: could not hook promoted widget", error);
    }
}

/**
 * Hook a container so its outer widgets are (re)wrapped now and whenever the
 * frontend rebuilds them (`widget-promoted`). Listeners are dropped when the
 * container is removed. Safe to call more than once.
 *
 * @param {Object} container - Container node.
 * @returns {void}
 */
export function installPromotedWidgetHooks(container) {
    if (!isContainer(container)) return;
    bindPromotedWidgets(container);
    if (container._promptStashPromotedHooks) return;

    const events = container.subgraph?.events;
    if (typeof events?.addEventListener !== "function") return;

    const controller = new AbortController();
    container._promptStashPromotedHooks = controller;
    events.addEventListener(
        "widget-promoted",
        (e) => {
            const host = e?.detail?.subgraphNode;
            if (host && host !== container) return;
            bindPromotedWidgets(container);
        },
        { signal: controller.signal }
    );

    const onRemoved = container.onRemoved;
    container.onRemoved = function (...args) {
        controller.abort();
        container._promptStashPromotedHooks = null;
        return onRemoved?.apply(this, args);
    };
}
