import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "phazei.PromptStashManager",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PromptStashManager") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);

            // Size
            this.computeSize = function () {
                return [230, 180]; // Increased height for new buttons
            };

            // Grab widgets
            const newListNameWidget = this.widgets.find(w => w.name === "new_list_name");

            // Create combo widget in JavaScript
            const existingListsWidget = this.addWidget(
                "combo",
                "existing_lists",
                "default",
                () => {},
                { values: ["default"] }
            );

            // Labels
            if (newListNameWidget) newListNameWidget.label = "New List Name";
            if (existingListsWidget) existingListsWidget.label = "Existing Lists";

            // Node-local state/handles
            this.data = { lists: ["default"] };
            this._listActionsWidget = null;
            this._refreshListButtons = () => { };

            // Helper to handle file imports
            const handleFileImport = (file) => {
                if (!file) return;

                // Validate file type
                if (!file.name.toLowerCase().endsWith('.json')) {
                    if (app.extensionManager?.toast) {
                        app.extensionManager.toast.add({
                            severity: "error",
                            summary: "Invalid File",
                            detail: "Please select a JSON file",
                            life: 5000
                        });
                    }
                    return;
                }

                // Create form data for upload
                const formData = new FormData();
                formData.append('file', file);

                // Show loading toast
                if (app.extensionManager?.toast) {
                    app.extensionManager.toast.add({
                        severity: "info",
                        summary: "Importing...",
                        detail: "Processing prompt data",
                        life: 3000
                    });
                }

                // Upload and import
                fetch('/prompt_stash_manager/import', {
                    method: 'POST',
                    body: formData
                })
                .then(response => {
                    if (!response.ok) {
                        return response.json().then(data => {
                            throw new Error(data.error || `HTTP ${response.status}`);
                        });
                    }
                    return response.json();
                })
                .then(data => {
                    if (data.success && data.summary) {
                        // Create detailed success message
                        let detail = [];
                        const s = data.summary;
                        
                        if (s.lists_added.length > 0) {
                            detail.push(`Added ${s.lists_added.length} new list(s): ${s.lists_added.join(', ')}`);
                        }
                        
                        if (s.lists_merged.length > 0) {
                            detail.push(`Merged into ${s.lists_merged.length} existing list(s): ${s.lists_merged.join(', ')}`);
                        }
                        
                        detail.push(`Total prompts added: ${s.prompts_added}`);
                        
                        if (s.prompts_renamed.length > 0) {
                            detail.push(`${s.prompts_renamed.length} prompts renamed due to conflicts`);
                        }

                        if (app.extensionManager?.toast) {
                            app.extensionManager.toast.add({
                                severity: "success",
                                summary: "Import Successful",
                                detail: detail.join('. '),
                                life: 8000
                            });
                        }
                    } else {
                        throw new Error("Import completed but no summary received");
                    }
                })
                .catch(error => {
                    console.error("Import failed:", error);
                    if (app.extensionManager?.toast) {
                        app.extensionManager.toast.add({
                            severity: "error",
                            summary: "Import Failed",
                            detail: String(error.message || error),
                            life: 5000
                        });
                    }
                });
            };

            // Helpers
            const canAdd = () => (newListNameWidget?.value || "").trim().length > 0;
            const canDelete = () => {
                const lists = existingListsWidget?.options?.values || [];
                const sel = existingListsWidget?.value;
                return lists.length > 1 && !!sel; // change to `&& sel !== "default"` if you want to lock default
            };

            // Two-button row (Add / Delete) via MULTI_BUTTON
            if (typeof app.widgets?.MULTI_BUTTON === "function") {
                const w = app.widgets.MULTI_BUTTON(this, "list_actions", {
                    options: {
                        buttons: [
                            {
                                label: "Add",
                                callback: () => {
                                    const listName = (newListNameWidget?.value || "").trim();
                                    if (!listName) return;

                                    api.fetchApi("/prompt_stash_saver/add_list", {
                                        method: "POST",
                                        body: JSON.stringify({ list_name: listName }),
                                    })
                                        .then(r => r.json())
                                        .then(data => {
                                            if (!data?.success) return;
                                            newListNameWidget.value = "";
                                            existingListsWidget.value = listName;
                                            this.serialize_widgets = true;
                                            app.graph.setDirtyCanvas(true, true);
                                            this._refreshListButtons();
                                        });
                                },
                            },
                            {
                                label: "Delete",
                                confirm: "Delete the selected list?",
                                callback: () => {
                                    const lists = existingListsWidget?.options?.values || [];
                                    const selectedList = existingListsWidget?.value;
                                    if (!canDelete()) return;

                                    const deletedIndex = lists.indexOf(selectedList);

                                    api.fetchApi("/prompt_stash_saver/delete_list", {
                                        method: "POST",
                                        body: JSON.stringify({ list_name: selectedList }),
                                    })
                                        .then(r => r.json())
                                        .then(data => {
                                            if (!data?.success) return;

                                            // choose next selection deterministically
                                            const remaining = lists.filter(v => v !== selectedList);
                                            let next = "default";
                                            if (remaining.length > 0) {
                                                next = deletedIndex >= remaining.length
                                                    ? remaining[remaining.length - 1]
                                                    : remaining[deletedIndex];
                                            }
                                            existingListsWidget.value = next;

                                            this.serialize_widgets = true;
                                            app.graph.setDirtyCanvas(true, true);
                                            this._refreshListButtons();
                                        });
                                },
                            },
                        ],
                        height: 28, gap: 10, pad: 16,
                        alternate: false,
                    },
                }, app);

                this.addCustomWidget(w);
                this._listActionsWidget = w;

                // Hoisted refresher (safe to call anytime)
                this._refreshListButtons = () => {
                    if (!this._listActionsWidget) return;
                    this._listActionsWidget.setDisabled(0, !canAdd());
                    this._listActionsWidget.setDisabled(1, !canDelete());
                    this._listActionsWidget.update();
                };

                // Initial state
                this._refreshListButtons();

                // Live updates on text/selection changes
                const prevTextCb = newListNameWidget?.callback;
                if (newListNameWidget) {
                    newListNameWidget.callback = (v) => {
                        prevTextCb?.(v);
                        this._refreshListButtons();
                    };
                }

                const prevComboCb = existingListsWidget?.callback;
                if (existingListsWidget) {
                    existingListsWidget.callback = (v) => {
                        prevComboCb?.(v);
                        this._refreshListButtons();
                    };
                }

                // (Optional fun row)
                const x = app.widgets.MULTI_BUTTON(this, "actions", {
                    options: {
                        buttons: [
                            { label: "!", callback: () => console.log("yay") },
                            { label: "!", callback: () => console.log("yay") },
                            { label: "!", callback: () => console.log("yay") },
                            { label: "!", callback: () => alert("Now I have your crypto keys") },
                            { label: "!", callback: () => alert("J/k J/K :\"D") },
                            { label: "!", callback: () => { x.buttons[1].label = "ᕦ(˘ω˘)ᕤ"; x.update(); } },
                            { label: "!", callback: () => { x.buttons[1].label = "!"; x.update(); } },
                            { label: "!", callback: () => console.log("yay") },
                            { label: "!", callback: () => console.log("yay") },
                            { label: "!", callback: () => console.log("yay") },
                            { label: "!", callback: () => console.log("yay") },
                            {
                                label: "!", confirm: "Are you sure?",
                                callback: () => {
                                    x.setDisabled(1, !x.buttons[1].disabled);
                                    x.setDisabled(3, !x.buttons[3].disabled);
                                    x.setDisabled(6, !x.buttons[6].disabled);
                                    x.setDisabled(9, !x.buttons[9].disabled);
                                }
                            },
                        ],
                        height: 28, gap: 10, pad: 16,
                        selectMode: "multi",      // "single" | "multi" | null
                        selected: [0, 2, 4, 6, 8, 10, 12],
                        // alternate: false,       // set to false for uniform fills
                        onSelect: (sel) => console.log("Selected:", sel),
                    },
                }, app);
                this.addCustomWidget(x);

                // Export/Import buttons
                const exportImportWidget = app.widgets.MULTI_BUTTON(this, "export_import", {
                    options: {
                        buttons: [
                            {
                                label: "Export",
                                callback: () => {
                                    try {
                                        // Create hidden link for download
                                        const link = document.createElement('a');
                                        link.href = '/prompt_stash_manager/export';
                                        link.download = '_blank';
                                        link.style.display = 'none';
                                        document.body.appendChild(link);

                                        // Trigger download
                                        link.click();

                                        // Clean up
                                        document.body.removeChild(link);

                                    } catch (error) {
                                        // Show error toast
                                        if (app.extensionManager?.toast) {
                                            app.extensionManager.toast.add({
                                                severity: "error",
                                                summary: "Export Failed",
                                                detail: `Could not export prompt data. ${String(error)}`,
                                                life: 5000
                                            });
                                        } else {
                                            console.error("Export failed:", error);
                                        }
                                    }
                                },
                            },
                            {
                                label: "Import",
                                callback: () => {
                                    try {
                                        // Create hidden file input
                                        const fileInput = document.createElement('input');
                                        fileInput.type = 'file';
                                        fileInput.accept = '.json';
                                        fileInput.style.display = 'none';
                                        
                                        // Handle file selection
                                        fileInput.addEventListener('change', (event) => {
                                            const file = event.target.files[0];
                                            if (file) {
                                                handleFileImport(file);
                                            }
                                            // Clean up
                                            document.body.removeChild(fileInput);
                                        });
                                        
                                        // Add to DOM and trigger click
                                        document.body.appendChild(fileInput);
                                        fileInput.click();
                                        
                                    } catch (error) {
                                        console.error("Import dialog failed:", error);
                                        if (app.extensionManager?.toast) {
                                            app.extensionManager.toast.add({
                                                severity: "error",
                                                summary: "Import Failed",
                                                detail: `Could not open file dialog. ${String(error)}`,
                                                life: 5000
                                            });
                                        }
                                    }
                                },
                            },
                        ],
                        height: 28, gap: 10, pad: 16,
                        alternate: false,
                    },
                }, app);

                this.addCustomWidget(exportImportWidget);
            }

            // Clear all paused
            this.addWidget("button", "(Clear All Paused)", null, () => {
                api.fetchApi("/prompt_stash_passthrough/clear_all", { method: "POST" });
            });

            // Create bound event handler method
            this.handlePromptStashUpdateAll = (event) => {
                // Skip if node is in invalid state
                if (this.id === -1) {
                    this.onRemoved?.();
                    return;
                }
                
                this.data = event.detail;
                if (existingListsWidget && event.detail?.lists) {
                    // Update lists dropdown
                    const listNames = Object.keys(event.detail.lists);
                    existingListsWidget.options.values = listNames;

                    // If current selected value is no longer in the list, reset to "default"
                    if (!listNames.includes(existingListsWidget.value)) {
                        existingListsWidget.value = "default";
                    }

                    this._refreshListButtons?.();

                    this.serialize_widgets = true;
                    app.graph.setDirtyCanvas(true, true);
                }
            };

            // Server push: update lists then refresh buttons
            api.addEventListener("prompt-stash-update-all", this.handlePromptStashUpdateAll);

            // Initial state fetch
            api.fetchApi("/prompt_stash_saver/init", {
                method: "POST",
                body: JSON.stringify({ node_id: this.id }),
            })
                .then(r => r.json())
                .then(data => {
                    this.data = data;
                    if (existingListsWidget && data?.lists) {
                        // Update lists dropdown
                        const listNames = Object.keys(data.lists);
                        existingListsWidget.options.values = listNames;

                        // If current selected value is no longer in the list, reset to "default"
                        if (!listNames.includes(existingListsWidget.value)) {
                            existingListsWidget.value = "default";
                        }

                        this._refreshListButtons?.();

                        this.serialize_widgets = true;
                        app.graph.setDirtyCanvas(true, true);
                    }
                });

            // Clean up event listeners when node is removed
            const origOnRemoved = this.onRemoved;
            this.onRemoved = function() {
                api.removeEventListener("prompt-stash-update-all", this.handlePromptStashUpdateAll);
                if (origOnRemoved) {
                    origOnRemoved.call(this);
                }
            };
        };
    }
});