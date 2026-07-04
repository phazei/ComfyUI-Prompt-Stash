import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    nodeMatchesUniqueId,
    getUniqueIdFromNode,
    installComboGetConfig,
    refreshConnectedPrimitives,
    syncValueToConnectedPrimitive,
    walkGraph,
} from "./utils.js";

// ── Cache-Invalidation Workaround ────────────────────────────────────────
//
// ComfyUI's output cache key for a node folds in the FULL signature of every
// upstream node it is *linked* to -- including inputs declared "lazy": True --
// because the signature is computed from the raw prompt graph before execution
// (comfy_execution/caching.py: get_ordered_ancestry_internal). check_lazy_status
// runs much later, so a lazy input we never actually use still invalidates this
// node (and everything downstream) whenever its upstream value changes. See
// https://github.com/Comfy-Org/ComfyUI/issues/11744
//
// When "use_input_text" is false this node ignores its "text" input entirely
// (check_lazy_status returns []), so the link is dead weight in the cache key.
// We strip that link from the API prompt at queue time -- the same moment and
// shape that core itself uses to drop orphaned links in graphToPrompt -- so the
// changing upstream value no longer pollutes our signature. The link is left
// untouched when "use_input_text" is true, preserving correct invalidation.
let _graphToPromptPatched = false;

/**
 * Wrap app.graphToPrompt once so that, for every Prompt Stash Saver node whose
 * use_input_text widget is false, the "text" input link is removed from the
 * generated API prompt. graphToPrompt runs synchronously when the user queues a
 * run, snapshotting the currently open graph; already-queued prompts are
 * unaffected by later workflow switches.
 */
function patchGraphToPromptOnce() {
    if (_graphToPromptPatched) return;
    if (typeof app.graphToPrompt !== "function") return;
    _graphToPromptPatched = true;

    const origGraphToPrompt = app.graphToPrompt.bind(app);

    app.graphToPrompt = async function(...args) {
        const result = await origGraphToPrompt(...args);
        try {
            stripUnusedTextLinks(result?.output);
        } catch (error) {
            console.error("PromptStashSaver: failed to strip unused text link", error);
        }
        return result;
    };
}

/**
 * For each Prompt Stash Saver node in the open graph (including those nested in
 * subgraphs) with use_input_text === false, delete the "text" entry from that
 * node's inputs in the API prompt output dict.
 *
 * @param {Object|undefined} output - The API prompt map (node_id -> {inputs,...}).
 */
function stripUnusedTextLinks(output) {
    if (!output || typeof output !== "object") return;
    const rootGraph = app.graph;
    if (!rootGraph) return;

    walkGraph(rootGraph, (node) => {
        const nodeClass = node?.comfyClass ?? node?.constructor?.comfyClass;
        if (nodeClass !== "PromptStashSaver") return;

        const useInputWidget = node.widgets?.find((w) => w.name === "use_input_text");
        if (!useInputWidget || useInputWidget.value === true) return;

        const promptId = getUniqueIdFromNode(node);
        const entry = output[promptId];
        const link = entry?.inputs?.text;

        // Only remove an actual upstream connection ([node_id, slot]); leave any
        // literal/widget value untouched.
        if (Array.isArray(link) && link.length === 2) {
            delete entry.inputs.text;
        }
    });
}

// ── Vue Reactivity Helpers ───────────────────────────────────────────────

/**
 * Force Vue (Nodes 2.0) to re-render combo widgets after their
 * options.values have been mutated from plain JS.
 * See prompt_stash_manager.js for full explanation.
 *
 * @param {Object} widget - The combo widget whose options changed.
 */
function triggerComboReactivity(widget) {
    const cur = widget.value;
    widget.value = cur + "\x00";
    widget.value = cur;
}

app.registerExtension({
    name: "phazei.PromptStashSaver",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "PromptStashSaver") {
            // Install the queue-time cache-invalidation workaround once.
            patchGraphToPromptOnce();

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                onNodeCreated?.apply(this, arguments);

                // this.size and this.setSize, neither worked, but this does?
                this.computeSize = function () {
                    return [210, 220];  // Slightly taller to accommodate new dropdown
                };

                // Find our widgets
                const promptWidget = this.widgets.find(w => w.name === "prompt_text");
                const saveKeyWidget = this.widgets.find(w => w.name === "save_as_key");
                const useInputWidget = this.widgets.find(w => w.name === "use_input_text");

                // The combo widgets are now declared in the Python node's
                // INPUT_TYPES (load_saved, prompt_lists) so the frontend creates
                // co-existing, Primitive-connectable input sockets. Find them
                // here instead of creating them in JS.
                const loadSavedWidget = this.widgets.find(w => w.name === "load_saved");
                const promptListsWidget = this.widgets.find(w => w.name === "prompt_lists");

                // State tracking
                this.isLoadingPrompt = false;
                this.currentSaveOperation = null;

                // Update widget names/labels - do not change ".name", will break synch with py
                saveKeyWidget.label = "Save Name";
                loadSavedWidget.label = "Load Saved";
                useInputWidget.label = "Use ____";
                promptListsWidget.label = "List";

                // Last-known-good option lists, derived from the node's surviving
                // `this.data` (set by the server broadcast). Used as the GET_CONFIG
                // fallback so a connected Primitive keeps its value across the "R"
                // refresh, which transiently resets options to the static stub.
                this._comboFallback = {
                    prompt_lists: () => Object.keys(this.data?.lists ?? {}),
                    load_saved: () => {
                        const lists = this.data?.lists;
                        if (!lists) return [];
                        const selected = promptListsWidget.value;
                        const prompts = lists[selected] || {};
                        return ["None", ...Object.keys(prompts)];
                    },
                };

                // Install the GET_CONFIG override for a combo, with its fallback.
                this._installComboInput = (widgetName) => {
                    installComboGetConfig(this, widgetName, {
                        getFallbackValues: this._comboFallback[widgetName],
                        // Single-entry lists equal to these are the static stub.
                        stubValues: ["None", "default", ""],
                    });
                };

                // Expose the combos' live options to connected Primitive nodes,
                // and notify them whenever the option lists change.
                this._syncComboInput = (widgetName) => {
                    this._installComboInput(widgetName);
                    refreshConnectedPrimitives(this, widgetName);
                };

                // Rebuild both combos' options from the surviving `this.data`
                // (used after the "R" refresh resets them to the static stub).
                this._repopulateCombos = () => {
                    const lists = this.data?.lists;
                    if (!lists) return;

                    promptListsWidget.options.values = Object.keys(lists);

                    const selected = promptListsWidget.value;
                    const prompts = lists[selected] || {};
                    loadSavedWidget.options.values = ["None", ...Object.keys(prompts)];

                    triggerComboReactivity(promptListsWidget);
                    triggerComboReactivity(loadSavedWidget);

                    this._syncComboInput("prompt_lists");
                    this._syncComboInput("load_saved");
                    this.setDirtyCanvas(true, true);
                };

                // --- Helper guards for enabling/disabling actions in the two-button row
                const canSave = () =>
                    !!(saveKeyWidget?.value && saveKeyWidget.value.trim()) &&
                    !!(promptWidget?.value && String(promptWidget.value).trim());
                const canDelete = () =>
                    loadSavedWidget?.value && loadSavedWidget.value !== "None";

                // Hoisted handles so we can refresh from any async path
                this._saveDeleteRow = null;
                this._refreshSaveDeleteRow = () => { };

                // Update prompts dropdown when list changes
                promptListsWidget.callback = (value) => {
                    // promptListsWidget.value = value; // if type COMBO not needed
                    if (this.data?.lists) {
                        const selectedList = promptListsWidget.value;
                        const prompts = this.data.lists[selectedList] || {};
                        loadSavedWidget.options.values = ["None", ...Object.keys(prompts)];
                        loadSavedWidget.value = "None";
                        this.serialize_widgets = true;
                        this._syncComboInput?.("load_saved");
                        app.graph.setDirtyCanvas(true, true);
                        // Also refresh Save/Delete enabled state when list changes
                        this._refreshSaveDeleteRow?.();
                    }
                };

                // Add watchers for both prompt and key changes
                promptWidget.callback = (value, e) => {
                    const savedPromptKey = loadSavedWidget.value;
                    if (savedPromptKey !== "None" && this.data?.lists) {
                        const selectedList = promptListsWidget.value;
                        const savedPrompt = this.data.lists[selectedList]?.[savedPromptKey];
                        // Only clear selection if the prompt text doesn't match the saved value
                        if (promptWidget.value !== savedPrompt) {
                            loadSavedWidget.value = "None";
                            this.serialize_widgets = true;
                            // Reflect the reset onto a connected load_saved Primitive.
                            syncValueToConnectedPrimitive(this, "load_saved");
                            app.graph.setDirtyCanvas(true, true);
                        }
                    }
                    // Refresh Save/Delete row whenever the prompt text changes
                    this._refreshSaveDeleteRow?.();
                };

                saveKeyWidget.callback = () => {
                    saveKeyWidget.value = saveKeyWidget.value.trim();
                    const savedPromptKey = loadSavedWidget.value;
                    if (savedPromptKey !== "None") {
                        // Only clear selection if the key doesn't match the selected value
                        if (saveKeyWidget.value !== savedPromptKey) {
                            loadSavedWidget.value = "None";
                            this.serialize_widgets = true;
                            // Reflect the reset onto a connected load_saved Primitive.
                            syncValueToConnectedPrimitive(this, "load_saved");
                            app.graph.setDirtyCanvas(true, true);
                        }
                    }
                    // Refresh Save/Delete row whenever the save key changes
                    this._refreshSaveDeleteRow?.();
                };

                // ---------------------------------------------------------------------------------
                // Add Save/Delete as a TWO-BUTTON ROW using MULTI_BUTTON (replaces the two buttons)
                // (keeps confirm on delete; dynamically enables/disables based on current state)
                // ---------------------------------------------------------------------------------
                if (typeof app.widgets?.MULTI_BUTTON === "function") {
                    const row = app.widgets.MULTI_BUTTON(this, "save_delete_actions", {
                        options: {
                            buttons: [
                                {
                                    label: "Save Prompt",
                                    callback: () => {
                                        if (!canSave()) return;
                                        const promptToSave = promptWidget.value;
                                        const keyToSave = saveKeyWidget.value.trim();
                                        const selectedList = promptListsWidget.value;

                                        api.fetchApi('/prompt_stash_saver/save', {
                                            method: 'POST',
                                            body: JSON.stringify({
                                                title: keyToSave,
                                                prompt: promptToSave,
                                                list_name: selectedList,
                                                node_id: this.id
                                            })
                                        });

                                        // Immediately set the value without waiting for server
                                        loadSavedWidget.value = keyToSave;

                                        // Ensure the just-saved key is a selectable
                                        // option now (the server broadcast that adds
                                        // it arrives later), then reflect both the
                                        // options and value onto a connected Primitive.
                                        if (!loadSavedWidget.options.values.includes(keyToSave)) {
                                            loadSavedWidget.options.values = [...loadSavedWidget.options.values, keyToSave];
                                        }
                                        this._syncComboInput?.("load_saved");
                                        syncValueToConnectedPrimitive(this, "load_saved");

                                        this.serialize_widgets = true;
                                        app.graph.setDirtyCanvas(true, true);
                                        this._refreshSaveDeleteRow?.();
                                    },
                                },
                                {
                                    label: "Delete Selected",
                                    confirm: "Delete the selected prompt?",
                                    callback: () => {
                                        if (!canDelete()) return;

                                        const deletedItemValue = loadSavedWidget.value;
                                        const selectedList = promptListsWidget.value;

                                        // Get current list and find index of deleted item
                                        const currentList = loadSavedWidget.options.values;
                                        const deletedItemIndex = currentList.indexOf(deletedItemValue);

                                        api.fetchApi('/prompt_stash_saver/delete', {
                                            method: 'POST',
                                            body: JSON.stringify({
                                                title: deletedItemValue,
                                                list_name: selectedList,
                                                node_id: this.id
                                            })
                                        }).then(() => {
                                            let newSelection = "None";
                                            const current = loadSavedWidget.options.values;

                                            // Remove the current value from the list in case listener hasn't triggered yet
                                            const availablePrompts = current.filter(v => v !== deletedItemValue);

                                            // Select next item based on position
                                            if (availablePrompts.length > 1) {  // > 1 because "None" is always present
                                                if (deletedItemIndex >= availablePrompts.length) {
                                                    // If we deleted the last item, take the new last item
                                                    newSelection = availablePrompts[availablePrompts.length - 1];
                                                } else {
                                                    // Otherwise take the item that was at this index
                                                    newSelection = availablePrompts[deletedItemIndex];
                                                }
                                            }

                                            // Drop the deleted item from the options
                                            // now (the server broadcast that removes it
                                            // arrives later) so a connected Primitive's
                                            // dropdown matches.
                                            loadSavedWidget.options.values = availablePrompts;
                                            loadSavedWidget.value = newSelection;

                                            if (newSelection === "None") {
                                                // If nothing selected, clear fields (mirror original behavior)
                                                this.isLoadingPrompt = true;
                                                promptWidget.value = "";
                                                saveKeyWidget.value = "";
                                                this.isLoadingPrompt = false;
                                            } else {
                                                // Load the newly selected prompt
                                                this.loadPrompt(newSelection, promptWidget, saveKeyWidget);
                                            }

                                            // Reflect the updated selection onto a
                                            // connected load_saved Primitive. Set the
                                            // value FIRST: _syncComboInput runs
                                            // refreshComboInNode, which clamps the
                                            // Primitive to options[0] ("None") if its
                                            // current value (still the just-deleted
                                            // item) isn't in the new options.
                                            syncValueToConnectedPrimitive(this, "load_saved");
                                            this._syncComboInput?.("load_saved");

                                            this.serialize_widgets = true;
                                            app.graph.setDirtyCanvas(true, true);
                                            this._refreshSaveDeleteRow?.();
                                        });
                                    },
                                },
                            ],
                            height: 28, gap: 10, pad: 16,
                            alternate: false, // 2 buttons: keep uniform look
                        },
                    }, app);

                    // Attach the two-button row to the node and hoist handles
                    this.addCustomWidget(row);
                    this._saveDeleteRow = row;

                    // Hoisted refresher: toggle enable/disable and repaint
                    this._refreshSaveDeleteRow = () => {
                        if (!this._saveDeleteRow) return;
                        this._saveDeleteRow.setDisabled(0, !canSave());   // Save
                        this._saveDeleteRow.setDisabled(1, !canDelete()); // Delete
                        this._saveDeleteRow.update();
                    };

                    // Initial state for the two-button row
                    this._refreshSaveDeleteRow();
                }

                // Helper function to load a prompt
                this.loadPrompt = (value, promptWidget, saveKeyWidget) => {
                    if (value === "None") {
                        this.isLoadingPrompt = true;
                        promptWidget.value = "";
                        saveKeyWidget.value = "";
                        this.isLoadingPrompt = false;
                        this.serialize_widgets = true;
                        app.graph.setDirtyCanvas(true, true);
                        // After clearing, also refresh Save/Delete states
                        this._refreshSaveDeleteRow?.();
                        return;
                    }

                    api.fetchApi('/prompt_stash_saver/get_prompt', {
                        method: 'POST',
                        body: JSON.stringify({
                            title: value,
                            list_name: promptListsWidget.value,
                            node_id: this.id
                        })
                    }).then(response => response.json())
                        .then(data => {
                            if (data.prompt) {
                                this.isLoadingPrompt = true;
                                promptWidget.value = data.prompt;
                                saveKeyWidget.value = value;
                                this.isLoadingPrompt = false;
                                this.serialize_widgets = true;
                                app.graph.setDirtyCanvas(true, true);
                                // After loading, refresh Save/Delete states (Save is now valid)
                                this._refreshSaveDeleteRow?.();
                            }
                        });
                };

                // Handle prompt selection changes
                loadSavedWidget.callback = (value) => {
                    this.loadPrompt(value, promptWidget, saveKeyWidget);
                    // Refresh Save/Delete states after any selection
                    this._refreshSaveDeleteRow?.();
                };

                // Create bound event handler methods
                this.handlePromptStashUpdateAll = (event) => {
                    // Skip if node is in invalid state
                    if (this.id === -1) {
                        this.onRemoved?.();
                        return;
                    }
                    
                    this.data = event.detail;
                    if (promptListsWidget && event.detail.lists) {
                        // Update lists dropdown
                        promptListsWidget.options.values = Object.keys(event.detail.lists);

                        // Update prompts dropdown for current list
                        const selectedList = promptListsWidget.value;
                        const prompts = event.detail.lists[selectedList] || {};
                        loadSavedWidget.options.values = ["None", ...Object.keys(prompts)];

                        triggerComboReactivity(promptListsWidget);
                        triggerComboReactivity(loadSavedWidget);

                        this._syncComboInput?.("prompt_lists");
                        this._syncComboInput?.("load_saved");

                        this.setDirtyCanvas(true, true);

                        // Re-evaluate Save/Delete enabled states after server updates
                        this._refreshSaveDeleteRow?.();
                    }
                };

                this.handlePromptStashUpdatePrompt = (event) => {
                    // Skip if node is in invalid state
                    if (this.id === -1) {
                        this.onRemoved?.();
                        return;
                    }
                    
                    if (nodeMatchesUniqueId(this, event.detail.node_id)) {
                        if (promptWidget) {
                            promptWidget.value = event.detail.prompt;
                            saveKeyWidget.value = "";
                            this.serialize_widgets = true;
                            app.graph.setDirtyCanvas(true, true);
                            // Update Save/Delete row after external prompt injection
                            this._refreshSaveDeleteRow?.();
                        }
                    }
                };

                // Listen for updates from server
                api.addEventListener("prompt-stash-update-all", this.handlePromptStashUpdateAll);

                // Listen for text updates from input
                api.addEventListener("prompt-stash-update-prompt", this.handlePromptStashUpdatePrompt);

                // Request initial state
                api.fetchApi('/prompt_stash_saver/init', {
                    method: 'POST',
                    body: JSON.stringify({
                        node_id: this.id
                    })
                });

                // Install the GET_CONFIG override on both combo inputs once the
                // framework has wired their input slots (deferred a frame).
                requestAnimationFrame(() => {
                    this._installComboInput("load_saved");
                    this._installComboInput("prompt_lists");
                });

                // Clean up event listeners when node is removed
                const origOnRemoved = this.onRemoved;
                this.onRemoved = function() {
                    api.removeEventListener("prompt-stash-update-all", this.handlePromptStashUpdateAll);
                    api.removeEventListener("prompt-stash-update-prompt", this.handlePromptStashUpdatePrompt);
                    if (origOnRemoved) {
                        origOnRemoved.call(this);
                    }
                };
            };
        }
    },

    /**
     * Re-populate the combo options after a global Refresh ("R" key /
     * refresh button). reloadNodeDefs resets every combo's options.values to
     * the static Python stub (["None"] / ["default"]), which would otherwise
     * drop the live lists and reset connected Primitives. We rebuild them from
     * each node's surviving `this.data`.
     */
    refreshComboInNodes() {
        walkGraph(app.graph, (node) => {
            if (node.comfyClass === "PromptStashSaver") {
                node._repopulateCombos?.();
            }
        });
    },
});
