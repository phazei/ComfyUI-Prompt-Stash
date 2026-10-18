import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { getUniqueIdFromNode, nodeMatchesUniqueId, walkGraph } from "./utils.js";

// ── Carry input text forward across runs and tabs ───────────────────────
//
// Frontend half of stash_sync.py. Each Saver / Passthrough node sends two
// hidden inputs with every queued prompt:
//
//   stash_tab   - the path of the workflow tab it was queued from. Tabs never
//                 share a path (unlike the workflow id, which survives
//                 re-opening a workflow from an image or saving it).
//   stash_token - the token of the input text its prompt_text widget last took
//                 in (node.properties.prompt_stash_token, saved with the workflow).
//
// The backend uses them to (a) carry text from a True run into later off runs
// that were queued before the widget had it, and (b) address its pushes to
// the right tab. Pushes for another tab are ignored -- previously they were
// matched on node id alone and could overwrite a node in a different workflow.
// When a workflow is loaded or its tab re-activated, nodes fetch any text they
// missed while in the background.

const TOKEN_PROPERTY = "prompt_stash_token";
const HIDDEN_INPUTS = ["stash_tab", "stash_token"];

/** Path of the active workflow tab, or "" if unavailable. */
export function getActiveTabPath() {
    return app.extensionManager?.workflow?.activeWorkflow?.path ?? "";
}

/**
 * Whether a pushed "prompt-stash-update-prompt" event is meant for the open
 * tab. Events without a tab (older backend) keep the old node-id-only match.
 */
export function isUpdateForActiveTab(detail) {
    if (!detail?.tab) return true;
    return detail.tab === getActiveTabPath();
}

/** Record that the node's widget now holds the text for `token`. */
export function setNodeToken(node, token) {
    node.properties ??= {};
    node.properties[TOKEN_PROPERTY] = token ?? "";
}

function removeHiddenInputSockets(node) {
    for (const name of HIDDEN_INPUTS) {
        const idx = node.inputs?.findIndex((i) => i.name === name) ?? -1;
        if (idx >= 0) node.removeInput(idx);
    }
}

/**
 * A widget that is invisible and not saved in widgets_values, but whose value
 * is written into the API prompt as `inputs[name]` when the prompt is built.
 */
function addPromptOnlyWidget(node, name, getValue) {
    const widget = node.addCustomWidget({
        name,
        type: "prompt_stash_hidden",
        value: "",
        serialize: false,             // not stored in the workflow's widgets_values
        options: {},                  // options.serialize unset -> sent in the prompt
        hidden: true,
        computeSize: () => [0, -4],   // fallback for renderers that ignore `hidden`
        draw() {},
        serializeValue: () => getValue(),
    });
    if (widget) widget.hidden = true;
    return widget;
}

/**
 * Set up carry-forward on a Saver / Passthrough node. Call from onNodeCreated.
 *
 * @param {LGraphNode} node
 * @param {(text: string, token: string) => void} applyText - writes text into
 *   the node's prompt_text widget (plus any node-specific side effects). The
 *   token bookkeeping is done here.
 */
export function installStashSync(node, applyText) {
    node.properties ??= {};

    addPromptOnlyWidget(node, "stash_tab", () => getActiveTabPath());
    addPromptOnlyWidget(node, "stash_token", () => node.properties?.[TOKEN_PROPERTY] ?? "");

    // The backend declares these as forceInput (so it receives them); the
    // frontend would draw sockets for them -- they are never meant to be linked.
    removeHiddenInputSockets(node);
    const origOnConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
        const r = origOnConfigure?.apply(this, args);
        removeHiddenInputSockets(this);
        return r;
    };

    node._applyStashText = (text, token) => {
        applyText(text, token);
        setNodeToken(node, token);
        node.setDirtyCanvas?.(true, true);
    };
}

/**
 * Handle a pushed "prompt-stash-update-prompt" event for `node`. Returns true
 * if it was applied.
 */
export function handlePushedUpdate(node, detail) {
    if (!nodeMatchesUniqueId(node, detail?.node_id)) return false;
    if (!isUpdateForActiveTab(detail)) return false;
    node._applyStashText?.(detail.prompt, detail.token ?? "");
    return true;
}

/**
 * Ask the backend for text this tab's stash nodes missed (e.g. while the tab
 * was in the background) and apply anything newer than what they hold.
 */
async function catchUpActiveTab() {
    const tab = getActiveTabPath();
    if (!tab || !app.graph) return;

    const nodesById = new Map();
    walkGraph(app.graph, (node) => {
        if (typeof node._applyStashText === "function") {
            nodesById.set(String(getUniqueIdFromNode(node)), node);
        }
    });
    if (nodesById.size === 0) return;

    let entries;
    try {
        const res = await api.fetchApi("/prompt_stash_saver/latest_input", {
            method: "POST",
            body: JSON.stringify({ tab, node_ids: [...nodesById.keys()] }),
        });
        if (!res.ok) return;
        entries = (await res.json())?.entries ?? {};
    } catch (error) {
        console.error("Prompt Stash: failed to fetch latest text", error);
        return;
    }

    // The user may have switched tabs while the request was in flight.
    if (getActiveTabPath() !== tab) return;

    for (const [nodeId, entry] of Object.entries(entries)) {
        const node = nodesById.get(nodeId);
        if (!node || !entry?.token) continue;
        if ((node.properties?.[TOKEN_PROPERTY] ?? "") === entry.token) continue;
        node._applyStashText(entry.text, entry.token);
    }
}

app.registerExtension({
    name: "phazei.PromptStashSync",
    // Runs after a workflow is loaded, including when switching back to its tab.
    async afterLoadGraph() {
        await catchUpActiveTab();
    },
});
