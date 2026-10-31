/**
 * Mock LiteGraph objects for testing the pure JS modules under Node, plus a
 * loader that builds them from a serialized ComfyUI workflow (UI format 0.4,
 * root graph + `definitions.subgraphs`).
 *
 * The mocks reproduce only what the modules read: graph `nodes`, `links`
 * (Map), `getLink`, `getNodeById`, `rootGraph`, subgraph `inputs` (name +
 * `linkIds`) and `events`; node `id` (string), `type`, `title`, `inputs`
 * (`link`, `widget`), `widgets` (`name`, `value`, `options`, `callback`),
 * `graph`, `subgraph` and `isSubgraphNode`.
 *
 * Widgets are built from `widgets_values_named` (written by current
 * frontends). A container's widgets are its promoted inputs (inputs with a
 * `widget`), valued from its own `widgets_values_named`, like the frontend's
 * store-backed outer widgets.
 *
 * Adapted from ComfyUI-Enhancement-Utils `tests/workflowLoader.mjs`.
 */

// ── Mock Classes ──────────────────────────────────────────────────────────

/** Minimal LGraphNode stand-in. */
export class MockNode {
    /**
     * @param {*} id - Node id (stored as a string, like frontend >= 1.46).
     * @param {Object} [opts] - Options.
     * @param {string} [opts.type] - Node type.
     * @param {string} [opts.title] - Node title.
     * @param {Array<Object>} [opts.inputs] - Input slots (`name`, `type`, `link`, `widget`).
     * @param {Array<Object>} [opts.outputs] - Output slots.
     * @param {Object} [opts.widgets] - Widget name -> value.
     */
    constructor(id, opts = {}) {
        this.id = String(id);
        this.type = opts.type;
        this.title = opts.title;
        this.inputs = (opts.inputs || []).map((i) => ({ link: null, ...i }));
        this.outputs = (opts.outputs || []).map((o) => ({ ...o }));
        this.widgets = Object.entries(opts.widgets || {}).map(([name, value]) => mockWidget(name, value));
    }

    /**
     * @param {string} name - Widget name.
     * @returns {Object|undefined} The widget.
     */
    widget(name) {
        return this.widgets.find((w) => w.name === name);
    }
}

/**
 * A plain widget object.
 *
 * @param {string} name - Widget name.
 * @param {*} value - Initial value.
 * @returns {Object} Widget with `name`, `value`, `options.values`.
 */
export function mockWidget(name, value) {
    return { name, value, options: { values: [] } };
}

/** Minimal LGraph / Subgraph stand-in. */
export class MockGraph {
    /**
     * @param {string} id - Graph id (subgraph definition id for subgraphs).
     * @param {MockGraph} [root] - Root graph (omit for the root itself).
     */
    constructor(id, root = null) {
        this.id = id;
        this.rootGraph = root ?? this;
        this.isRootGraph = !root;
        this._nodes = [];
        this._byId = new Map();
        this.links = new Map();
        this.inputs = [];
        this.events = new EventTarget();
        this.nextLink = 1;
    }

    /** @returns {Array<MockNode>} Nodes. */
    get nodes() {
        return this._nodes;
    }

    /**
     * Add nodes to the graph.
     * @param {...MockNode} nodes - Nodes to add.
     * @returns {MockNode} The first node added.
     */
    add(...nodes) {
        for (const n of nodes) {
            n.graph = this;
            this._nodes.push(n);
            this._byId.set(String(n.id), n);
        }
        return nodes[0];
    }

    /**
     * @param {*} id - Node id.
     * @returns {MockNode|null} The node, or null.
     */
    getNodeById(id) {
        return this._byId.get(String(id)) ?? null;
    }

    /**
     * @param {*} id - Link id.
     * @returns {Object|undefined} The link.
     */
    getLink(id) {
        return this.links.get(id);
    }

    /**
     * Add a subgraph input slot.
     * @param {string} name - Input name.
     * @returns {Object} The slot (`name`, `linkIds`).
     */
    addInput(name) {
        const slot = { name, linkIds: [] };
        this.inputs.push(slot);
        return slot;
    }

    /**
     * Connect two slots with a new link. `from` may be "-10" (this subgraph's
     * input node; `fromSlot` is then the subgraph input index).
     * @param {MockNode|string} from - Origin node or "-10".
     * @param {number} fromSlot - Origin slot.
     * @param {MockNode} to - Target node.
     * @param {number} toSlot - Target input slot.
     * @returns {Object} The link.
     */
    connect(from, fromSlot, to, toSlot) {
        const id = this.nextLink++;
        const link = {
            id,
            origin_id: typeof from === "string" ? from : from.id,
            origin_slot: fromSlot,
            target_id: to.id,
            target_slot: toSlot,
        };
        this.links.set(id, link);
        to.inputs[toSlot].link = id;
        if (link.origin_id === "-10") this.inputs[fromSlot].linkIds.push(id);
        return link;
    }
}

/**
 * Turn a node into a subgraph container for `subgraph`. Its widgets become
 * one outer widget per promoted input (input with a `widget`), valued from
 * `values` (name -> value), each with a store-like callback that only sets
 * the value.
 *
 * @param {MockNode} node - Node to decorate.
 * @param {MockGraph} subgraph - Subgraph definition graph.
 * @param {Object} [values] - Outer widget values by name.
 * @returns {MockNode} The same node.
 */
export function makeContainer(node, subgraph, values = {}) {
    node.subgraph = subgraph;
    node.isSubgraphNode = () => true;
    node.widgets = node.inputs
        .filter((i) => i.widget)
        .map((i) => {
            const w = mockWidget(i.widget.name, values[i.widget.name]);
            w.callback = function (next) {
                w.value = next;
            };
            return w;
        });
    return node;
}

// ═══════════════════════════════════════════════════════════════════════════
// Workflow Loader
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalise a serialized link (array or object form) into a link object.
 *
 * @param {Array|Object} raw - `[id, origin_id, origin_slot, target_id, target_slot, type]` or object.
 * @returns {Object|null} Link with string node ids, or null.
 */
function normaliseLink(raw) {
    if (!raw) return null;
    const l = Array.isArray(raw)
        ? { id: raw[0], origin_id: raw[1], origin_slot: raw[2], target_id: raw[3], target_slot: raw[4], type: raw[5] }
        : { ...raw };
    l.origin_id = String(l.origin_id);
    l.target_id = String(l.target_id);
    return l;
}

/**
 * Widget name -> value for a serialized node.
 *
 * @param {Object} raw - Serialized node.
 * @returns {Object} Named widget values (empty when not recorded).
 */
function namedValues(raw) {
    return raw.widgets_values_named && typeof raw.widgets_values_named === "object" ? raw.widgets_values_named : {};
}

/**
 * Build mock graphs from a serialized workflow.
 *
 * @param {Object} workflow - Serialized workflow (UI format 0.4).
 * @returns {{root: MockGraph, subgraphs: Map<string, MockGraph>}} Root graph and subgraphs by id.
 */
export function loadWorkflow(workflow) {
    const root = new MockGraph(workflow.id ?? "root");
    const subgraphs = new Map();
    root.subgraphs = subgraphs;

    const defs = workflow?.definitions?.subgraphs || [];
    for (const def of defs) {
        const sg = new MockGraph(def.id, root);
        sg.name = def.name;
        sg.inputs = (def.inputs || []).map((i) => ({ name: i.name, linkIds: [...(i.linkIds || [])] }));
        subgraphs.set(def.id, sg);
    }

    /**
     * Instantiate one serialized node into a graph.
     * @param {MockGraph} graph - Target graph.
     * @param {Object} raw - Serialized node.
     * @returns {void}
     */
    const addNode = (graph, raw) => {
        const sub = subgraphs.get(raw.type);
        const node = new MockNode(raw.id, {
            type: raw.type,
            title: raw.title,
            inputs: (raw.inputs || []).map((i) => ({
                name: i.name,
                type: i.type,
                link: i.link ?? null,
                ...(i.widget ? { widget: { ...i.widget } } : {}),
            })),
            outputs: raw.outputs || [],
            widgets: sub ? {} : namedValues(raw),
        });
        if (sub) makeContainer(node, sub, namedValues(raw));
        graph.add(node);
    };

    /**
     * Fill a graph's nodes and links.
     * @param {MockGraph} graph - Target graph.
     * @param {Array<Object>} nodes - Serialized nodes.
     * @param {Array<Array|Object>} links - Serialized links.
     * @returns {void}
     */
    const fill = (graph, nodes, links) => {
        for (const raw of nodes || []) addNode(graph, raw);
        for (const raw of links || []) {
            const link = normaliseLink(raw);
            if (link) graph.links.set(link.id, link);
        }
    };

    fill(root, workflow.nodes, workflow.links);
    for (const def of defs) fill(subgraphs.get(def.id), def.nodes, def.links);
    return { root, subgraphs };
}

/**
 * Find a node by title anywhere in the loaded graphs.
 *
 * @param {MockGraph} root - Root graph.
 * @param {string} title - Node title.
 * @returns {MockNode|null} The node, or null.
 */
export function findByTitle(root, title) {
    for (const g of [root, ...(root.subgraphs?.values() ?? [])]) {
        const node = g.nodes.find((n) => n.title === title);
        if (node) return node;
    }
    return null;
}
