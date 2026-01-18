import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { nodeMatchesUniqueId } from "./utils.js";

app.registerExtension({
    name: "phazei.PromptStashSaver",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "PromptStashSaver") {
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

                // Create combo widgets in JavaScript
                const loadSavedWidget = this.addWidget(
                    "combo",
                    "load_saved",
                    "None",
                    () => {},
                    { values: ["None"] }
                );

                const promptListsWidget = this.addWidget(
                    "combo",
                    "prompt_lists",
                    "default",
                    () => {},
                    { values: ["default"] }
                );

                // State tracking
                this.isLoadingPrompt = false;
                this.currentSaveOperation = null;

                // Update widget names/labels - do not change ".name", will break synch with py
                saveKeyWidget.label = "Save Name";
                loadSavedWidget.label = "Load Saved";
                useInputWidget.label = "Use ____";
                promptListsWidget.label = "List";

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
    }
});
