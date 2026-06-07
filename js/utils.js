/**
 * Utility functions for ComfyUI-Prompt-Stash
 */

// ── Primitive Node Support (connectable combo inputs) ──────────────────────
//
// Since ComfyUI frontend >=1.16, widget->input "conversion" was removed and
// input sockets co-exist automatically -- but only for widgets declared in the
// node's Python INPUT_TYPES. A Primitive node reads a combo's allowed values
// from the input slot's widget via a framework-internal anonymous symbol
// (GET_CONFIG). That symbol is not importable from a custom extension, so we
// discover it at runtime and override it to expose the combo's *live* options.

/**
 * The framework's GET_CONFIG symbol, used by Primitive nodes to read combo
 * options from an input slot's widget. Discovered at runtime by inspecting an
 * already-wired input widget for a symbol-keyed function that returns an array
 * (the InputSpec shape). Cached after first discovery.
 *
 * @type {symbol|null}
 */
let _getConfigSymbol = null;

/**
 * Find the framework's GET_CONFIG symbol by inspecting the node's input slots'
 * widgets for symbol-keyed properties whose value is a function returning an
 * array.
 *
 * @param {LGraphNode} node - The node instance.
 * @returns {symbol|null} The GET_CONFIG symbol, or null if not found.
 */
export function findGetConfigSymbol(node) {
    if (_getConfigSymbol) return _getConfigSymbol;

    for (const input of node.inputs ?? []) {
        if (!input.widget) continue;
        const symbols = Object.getOwnPropertySymbols(input.widget);
        for (const sym of symbols) {
            const val = input.widget[sym];
            if (typeof val === "function") {
                try {
                    if (Array.isArray(val())) {
                        _getConfigSymbol = sym;
                        return sym;
                    }
                } catch (_) {
                    // Skip symbols whose getter throws.
                }
            }
        }
    }
    return null;
}

/**
 * Install (or re-assert) a GET_CONFIG override on a combo widget's input slot
 * so that connected Primitive nodes read the combo's live options instead of
 * the static list from the Python node definition.
 *
 * The optional fallback guards against the global "R" refresh
 * (reloadNodeDefs), which transiently resets the combo's options.values to the
 * static list from the node definition. That clobber happens before our
 * refresh hook can repopulate, and a connected Primitive's refreshComboInNode
 * would read the stub list and reset its value to item 0. When the live
 * options look like the static stub, we return the fallback (last-known-good)
 * list instead so the Primitive keeps its selection.
 *
 * @param {LGraphNode} node - The node instance.
 * @param {string} widgetName - The combo widget / input name.
 * @param {Object} [opts]
 * @param {() => string[]} [opts.getFallbackValues] - Returns the last-known-good
 *   option list, used when the live options look like the static stub.
 * @param {string[]} [opts.stubValues] - Single-element option lists equal to one
 *   of these are treated as the static stub.
 */
export function installComboGetConfig(node, widgetName, opts = {}) {
    const sym = findGetConfigSymbol(node);
    if (!sym) return;

    const input = node.inputs?.find((i) => i.widget?.name === widgetName);
    if (!input?.widget) return;

    const combo = node.widgets?.find((w) => w.name === widgetName);
    if (!combo) return;

    const { getFallbackValues, stubValues = [] } = opts;

    // Return the live options in the InputSpec shape: [valuesArray, opts].
    // The Primitive reads [0] as the combo values.
    input.widget[sym] = () => {
        const live = combo.options?.values;
        const looksLikeStub =
            !Array.isArray(live) ||
            live.length === 0 ||
            (live.length === 1 && stubValues.includes(live[0]));

        if (looksLikeStub && getFallbackValues) {
            const fb = getFallbackValues();
            if (Array.isArray(fb) && fb.length > 0) {
                return [fb.slice(), {}];
            }
        }

        return [(live ?? []).slice(), {}];
    };
}

/**
 * Notify any Primitive node connected to a combo's input slot that its options
 * changed. The Primitive caches the input slot's widget object and reads
 * GET_CONFIG lazily; calling refreshComboInNode() forces it to re-read the
 * (overridden) GET_CONFIG and rebuild its own dropdown.
 *
 * @param {LGraphNode} node - The node instance.
 * @param {string} widgetName - The combo widget / input name.
 */
export function refreshConnectedPrimitives(node, widgetName) {
    const input = node.inputs?.find((i) => i.widget?.name === widgetName);
    if (!input || input.link == null) return;

    const graph = node.graph;
    const link = graph?.links?.[input.link];
    if (!link) return;

    const sourceNode = graph.getNodeById?.(link.origin_id);
    if (sourceNode && typeof sourceNode.refreshComboInNode === "function") {
        // refreshComboInNode() updates widget.options.values, and clamps/reassigns
        // widget.value ONLY if the current value fell out of range. After a
        // workflow load the Primitive's value is usually still valid, so it never
        // re-assigns .value -- and a bare options.values mutation is invisible to
        // Vue (Nodes 2.0). The dropdown keeps showing the stale stub options with a
        // red "value not in list" outline until the value flows through the
        // reactive path (e.g. on Run). Force that reactive path here.
        sourceNode.refreshComboInNode();
        forceWidgetReactiveUpdate(sourceNode, sourceNode.widgets?.[0]);
    }
}

/**
 * Push a combo widget's current value back onto the Primitive node connected to
 * its input slot, so the Primitive's dropdown reflects a value the node changed
 * itself (the value sync is normally one-way: Primitive -> node via applyToGraph).
 *
 * Deliberately does NOT invoke the Primitive's `callback` (which would run
 * applyToGraph and push the value back into the node, causing a ping-pong); it
 * only updates the value and forces a re-render. A value-difference guard makes
 * it a no-op when already in sync.
 *
 * @param {LGraphNode} node - The node owning the combo widget.
 * @param {string} widgetName - The combo widget / input name.
 */
export function syncValueToConnectedPrimitive(node, widgetName) {
    const input = node.inputs?.find((i) => i.widget?.name === widgetName);
    if (!input || input.link == null) return;

    const graph = node.graph;
    const link = graph?.links?.[input.link];
    if (!link) return;

    const sourceNode = graph.getNodeById?.(link.origin_id);
    const primitiveWidget = sourceNode?.widgets?.[0];
    if (!primitiveWidget) return;

    const comboValue = node.widgets?.find((w) => w.name === widgetName)?.value;
    if (primitiveWidget.value === comboValue) return;

    primitiveWidget.value = comboValue;
    forceWidgetReactiveUpdate(sourceNode, primitiveWidget);
}

/**
 * Force a Vue (Nodes 2.0) re-render and error re-evaluation for a widget whose
 * options.values were mutated directly from JS.
 *
 * Re-assigning `widget.value` routes through the widget's reactive setter
 * (BaseWidget writes its backing reactive store entry), which invalidates the
 * computed that drives the rendered dropdown. Firing `node.onWidgetChanged`
 * clears the backend `value_not_in_list` execution error so the red outline goes
 * away. Both are no-ops on the legacy canvas, so this is safe in either mode.
 *
 * @param {LGraphNode} node - The node owning the widget.
 * @param {Object} widget - The widget whose options were changed.
 */
export function forceWidgetReactiveUpdate(node, widget) {
    if (!widget) return;
    const value = widget.value;

    // Re-assigning the SAME value is a no-op: Vue's reactive setter short-circuits
    // on Object.is(old, new), so processedWidgets never recomputes and the dropdown
    // keeps its stale options. Write a transient sentinel first to defeat the
    // equality check, then restore -- this forces the recompute that re-reads the
    // updated options.values. (Mirrors triggerComboReactivity for our own widgets.)
    if (typeof value === "string") {
        widget.value = value + "\x00";
        widget.value = value;
    } else {
        widget.value = value;
    }

    // Clear the backend `value_not_in_list` execution error (the red outline).
    node?.onWidgetChanged?.(widget.name, value, value, widget);
}

/**
 * Walk a graph and its subgraphs recursively, invoking the callback for each
 * node.
 *
 * @param {LGraph} graph - A LiteGraph graph object.
 * @param {(node: LGraphNode) => void} callback - Called with each node.
 */
export function walkGraph(graph, callback) {
    for (const node of graph?.nodes ?? []) {
        callback(node);
        if (node.subgraph) walkGraph(node.subgraph, callback);
    }
}

/**
 * Check if a node matches a potentially-prefixed UNIQUE_ID from the backend.
 * Handles subgraph paths like "54:73" or "54:62:174".
 * 
 * @param {LGraphNode} node - The node to check
 * @param {string|number} uniqueId - The UNIQUE_ID from backend (e.g., "54:73" or "73")
 * @returns {boolean}
 */
export function nodeMatchesUniqueId(node, uniqueId) {
    const parts = String(uniqueId).split(':').map(Number);
    const localId = parts.pop();
    
    // Quick exit: local ID must match
    if (localId !== node.id) return false;
    
    // No prefix means node should be in root graph
    if (parts.length === 0) {
        return node.graph?.isRootGraph ?? true;
    }
    
    // Walk the path from root to find the target subgraph's UUID
    let current = node.graph?.rootGraph;
    if (!current) return false;
    
    for (const subgraphNodeId of parts) {
        const subgraphNode = current.getNodeById(subgraphNodeId);
        if (!subgraphNode?.subgraph) return false;
        current = subgraphNode.subgraph;
    }
    
    // current.id should now be the UUID of the subgraph containing the leaf
    return current.id === node.graph.id;
}

/**
 * Get the full UNIQUE_ID path for a node, matching backend format.
 * Returns "54:62:73" for nested subgraphs, or just "73" for root-level nodes.
 * 
 * @param {LGraphNode} node - The node to get the path for
 * @returns {string} The full UNIQUE_ID path
 */
export function getUniqueIdFromNode(node) {
    const leafId = node.id;
    
    // Easy case: node is in root graph
    if (node.graph?.isRootGraph) {
        return String(leafId);
    }
    
    const targetUUID = node.graph.id;
    const rootGraph = node.graph.rootGraph;
    
    if (!rootGraph) {
        return String(leafId); // Fallback
    }
    
    // Get the set of subgraph UUIDs for quick lookup
    const subgraphUUIDs = new Set(rootGraph.subgraphs?.keys() ?? []);
    
    // Recursive search: find the path of node IDs leading to targetUUID
    function findPathToUUID(graph, target) {
        for (const graphNode of graph.nodes ?? []) {
            // Check if this node is a subgraph container
            if (subgraphUUIDs.has(graphNode.type) && graphNode.subgraph) {
                if (graphNode.subgraph.id === target) {
                    // Found it! Return this node's ID as the path
                    return [graphNode.id];
                }
                
                // Not a direct match, search deeper
                const deeperPath = findPathToUUID(graphNode.subgraph, target);
                if (deeperPath) {
                    // Found it deeper, prepend this node's ID
                    return [graphNode.id, ...deeperPath];
                }
            }
        }
        return null; // Not found in this branch
    }
    
    const path = findPathToUUID(rootGraph, targetUUID);
    
    if (path) {
        return [...path, leafId].join(':');
    }
    
    // Fallback if we couldn't find the path (shouldn't happen)
    console.warn('getUniqueIdFromNode: Could not resolve subgraph path for node', node.id);
    return String(leafId);
}
