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
                return [230, 180];
            };

            // Grab widgets
            const newListNameWidget = this.widgets.find(w => w.name === "new_list_name");
            const existingListsWidget = this.widgets.find(w => w.name === "existing_lists");

            // Labels
            if (newListNameWidget) newListNameWidget.label = "New List Name";
            if (existingListsWidget) existingListsWidget.label = "Existing Lists";

            // Ensure combo init
            if (existingListsWidget) {
                existingListsWidget.type = "combo";
                existingListsWidget.options = existingListsWidget.options || {};
                existingListsWidget.options.values = ["default"];
                existingListsWidget.value = "default";
            }

            // Node-local state/handles
            this.data = { lists: ["default"] };
            this._listActionsWidget = null;
            this._refreshListButtons = () => { };

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

            }

            // Clear all paused
            this.addWidget("button", "(Clear All Paused)", null, () => {
                api.fetchApi("/prompt_stash_passthrough/clear_all", { method: "POST" });
            });

            // Server push: update lists then refresh buttons
            api.addEventListener("prompt-stash-update-all", (event) => {
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
            });

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
        };
    }
});
