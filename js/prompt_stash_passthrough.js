import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { nodeMatchesUniqueId, getUniqueIdFromNode, isUnassignedNode, resolveConstantBool, setDefaultLabel } from "./utils.js";
import { handlePushedUpdate, installStashSync } from "./stash_sync.js";

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
 * Wrap app.graphToPrompt once so that, for every Prompt Stash Passthrough node
 * whose use_input_text widget is false, the "text" input link is removed from
 * the generated API prompt. graphToPrompt runs synchronously when the user
 * queues a run, snapshotting the currently open graph; already-queued prompts
 * are unaffected by later workflow switches.
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
            console.error("PromptStashPassthrough: failed to strip unused text link", error);
        }
        return result;
    };
}

/**
 * For each Prompt Stash Passthrough entry in the API prompt whose
 * use_input_text is the literal value false, delete the "text" link from its
 * inputs.
 *
 * The decision is made from the API prompt itself -- exactly what the backend
 * will see -- rather than from the canvas widget, which can be stale (e.g.
 * use_input_text promoted to a subgraph input, or driven by a link). See the
 * matching comment in prompt_stash_saver.js.
 *
 * @param {Object|undefined} output - The API prompt map (node_id -> {inputs,...}).
 */
function stripUnusedTextLinks(output) {
    if (!output || typeof output !== "object") return;

    for (const entry of Object.values(output)) {
        if (entry?.class_type !== "PromptStashPassthrough") continue;
        const inputs = entry.inputs;
        if (!inputs) continue;

        // Only strip when use_input_text is definitively false: a literal, or a
        // link to a constant boolean source (Every Nth Queue, core Boolean). Any
        // other link is only known at runtime -- keep text.
        if (resolveConstantBool(output, inputs.use_input_text) !== false) continue;

        // Only remove an actual upstream connection ([node_id, slot]); leave any
        // literal/widget value untouched.
        const link = inputs.text;
        if (Array.isArray(link) && link.length === 2) {
            delete inputs.text;
        }
    }
}

// ── Vue Renderer Detection ───────────────────────────────────────────────

/**
 * Detect whether the Vue (Nodes 2.0) renderer is active.
 * @returns {boolean}
 */
function isVueRenderer() {
    return document.querySelector("[data-node-id]") !== null;
}

// ── DOM Continue Button (Nodes 2.0) ──────────────────────────────────────

/**
 * Show or hide a DOM-based Continue button on a node in the Vue renderer.
 * The button is absolutely positioned in the title bar area, matching
 * the canvas-drawn button's placement in LiteGraph mode.
 *
 * @param {Object} node - The LiteGraph node instance.
 * @param {boolean} show - Whether to show or hide the button.
 * @param {Function} onClick - Callback when the button is clicked.
 */
function updateDomContinueButton(node, show, onClick) {
    const nodeEl = document.querySelector(`[data-node-id="${node.id}"]`);
    if (!nodeEl) return;

    const BUTTON_CLASS = "prompt-stash-continue-btn";
    let btn = nodeEl.querySelector(`.${BUTTON_CLASS}`);

    if (!show) {
        if (btn) btn.remove();
        return;
    }

    if (!btn) {
        btn = document.createElement("button");
        btn.className = BUTTON_CLASS;
        btn.textContent = "Continue";
        btn.style.cssText = [
            "position: absolute",
            "top: 4px",
            "right: 6px",
            "background: #3A6B3A",
            "color: #FFFFFF",
            "border: 1px solid #2A5B2A",
            "border-radius: 10px",
            "font-size: 11px",
            "font-family: Arial, sans-serif",
            "padding: 2px 12px",
            "cursor: pointer",
            "z-index: 20",
            "line-height: 1.4",
        ].join(";");

        btn.addEventListener("mouseenter", () => {
            btn.style.background = "#4A7C4A";
            btn.style.borderColor = "#5A8C5A";
        });
        btn.addEventListener("mouseleave", () => {
            btn.style.background = "#3A6B3A";
            btn.style.borderColor = "#2A5B2A";
        });
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            onClick();
        });

        nodeEl.appendChild(btn);
    }
}

app.registerExtension({
    name: "phazei.PromptStashPassthrough",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "PromptStashPassthrough") {
            // Install the queue-time cache-invalidation workaround once.
            patchGraphToPromptOnce();

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function() {
                onNodeCreated?.apply(this, arguments);

                // Set node size (simplified since button is in title)
                this.computeSize = function() {
                    return [210, 110];
                };

                // Find our widgets
                const promptWidget = this.widgets.find(w => w.name === "prompt_text");
                const useInputWidget = this.widgets.find(w => w.name === "use_input_text");
                const pauseToEditWidget = this.widgets.find(w => w.name === "pause_to_edit");

                // Default widget labels (respecting any user rename) - do not
                // change ".name", will break synch with py
                setDefaultLabel(this, useInputWidget, "Use ____");
                setDefaultLabel(this, pauseToEditWidget, "Pause to Edit");

                // Button state tracking
                this.showContinueButton = false;
                this.buttonArea = null;
                this.mouseOverButton = false;

                // ── Shared Continue Handler ──────────────────────────
                // Used by both the canvas button click and the DOM button click.
                const handleContinueClick = () => {
                    const currentText = promptWidget ? promptWidget.value : "";
                    const uniqueId = getUniqueIdFromNode(this);

                    api.fetchApi(`/prompt_stash_passthrough/continue/${uniqueId}`, {
                        method: "POST",
                        body: JSON.stringify({ text: currentText })
                    }).then(response => {
                        if (response.ok) {
                            this.showContinueButton = false;
                            this.mouseOverButton = false;
                            updateDomContinueButton(this, false);
                            app.graph.setDirtyCanvas(true, true);
                            console.log("Workflow continued successfully");
                        } else {
                            console.error("Failed to continue workflow, status:", response.status);
                        }
                    }).catch(error => {
                        console.error("Error continuing workflow:", error);
                        if (app.extensionManager?.toast) {
                            app.extensionManager.toast.add({
                                severity: "error",
                                summary: "Continue Failed",
                                detail: "Could not continue workflow execution",
                                life: 5000
                            });
                        }
                    });
                };

                // Store handleContinueClick on the node for DOM button access
                this._handleContinueClick = handleContinueClick;

                // Store the original onDrawForeground method
                const origDrawForeground = this.onDrawForeground;

                // Override the onDrawForeground method to draw our button in title bar
                this.onDrawForeground = function(ctx, graphcanvas) {
                    // Call the original method if it exists
                    if (origDrawForeground) {
                        origDrawForeground.call(this, ctx, graphcanvas);
                    }

                    // Only draw the button if we should show it
                    if (this.showContinueButton) {

                        ctx.save(); // Save the context state before drawing button

                        const titleHeight = LiteGraph.NODE_TITLE_HEIGHT;
                        const buttonWidth = 80;
                        const buttonHeight = titleHeight - 8; // Make it shorter
                        
                        // Position button in title bar (right side)
                        const x = this.size[0] - buttonWidth - 6;
                        const y = 3 - titleHeight; // Adjust Y position for centered look

                        // Button background - more subtle colors
                        if (this.mouseOverButton) {
                            ctx.fillStyle = "#4A7C4A"; // Darker muted green on hover
                        } else {
                            ctx.fillStyle = "#3A6B3A"; // Muted dark green default
                        }
                        
                        ctx.beginPath();
                        ctx.roundRect(x, y, buttonWidth, buttonHeight, 10); // Increased border radius
                        ctx.fill();

                        // Button border for better definition
                        ctx.strokeStyle = this.mouseOverButton ? "#5A8C5A" : "#2A5B2A";
                        ctx.lineWidth = 1;
                        ctx.stroke();

                        // Button text - with better contrast
                        ctx.fillStyle = "#FFFFFF";
                        ctx.textAlign = "center";
                        ctx.textBaseline = "middle";
                        ctx.font = "11px Arial";
                        ctx.fillText("Continue", x + buttonWidth/2, y + buttonHeight/2);

                        // Store button coordinates for click detection
                        this.buttonArea = {x, y, width: buttonWidth, height: buttonHeight};

                        ctx.restore(); // Restore the context state after drawing button

                    }
                };

                // Store the original onMouseMove method
                const origMouseMove = this.onMouseMove;

                // Override onMouseMove to detect hover over button
                this.onMouseMove = function(event, pos, graphcanvas) {
                    let needsRedraw = false;
                    
                    // Check if hovering over button
                    if (this.showContinueButton && this.buttonArea) {
                        const {x, y, width, height} = this.buttonArea;
                        const wasHovering = this.mouseOverButton;
                        
                        this.mouseOverButton = (
                            pos[0] >= x && pos[0] <= x + width &&
                            pos[1] >= y && pos[1] <= y + height
                        );
                        
                        // If hover state changed, trigger redraw
                        if (wasHovering !== this.mouseOverButton) {
                            needsRedraw = true;
                        }
                        
                        // Change cursor when hovering over button
                        if (this.mouseOverButton) {
                            graphcanvas.canvas.style.cursor = "pointer";
                        } else if (wasHovering) {
                            graphcanvas.canvas.style.cursor = "default";
                        }
                    }

                    // Call original handler
                    if (origMouseMove) {
                        origMouseMove.call(this, event, pos, graphcanvas);
                    }

                    // Trigger redraw if needed
                    if (needsRedraw) {
                        app.graph.setDirtyCanvas(true, true);
                    }

                    return false;
                };

                // Store the original onMouseDown method
                const origMouseDown = this.onMouseDown;

                // Override the onMouseDown method to detect button clicks
                this.onMouseDown = function(event, pos, graphcanvas) {
                    // Check if clicking on our button
                    if (this.showContinueButton && this.buttonArea) {
                        const {x, y, width, height} = this.buttonArea;

                        // Check if click is inside the button area
                        if (pos[0] >= x && pos[0] <= x + width &&
                            pos[1] >= y && pos[1] <= y + height) {

                            graphcanvas.canvas.style.cursor = "default";
                            handleContinueClick();
                            return true; // Handled the event
                        }
                    }

                    // Otherwise, use the original handler
                    if (origMouseDown) {
                        return origMouseDown.call(this, event, pos, graphcanvas);
                    }
                    return false;
                };

                // Store the original onMouseLeave method (if exists)
                const origMouseLeave = this.onMouseLeave;

                // Override onMouseLeave to reset hover state
                this.onMouseLeave = function(event) {
                    if (this.mouseOverButton) {
                        this.mouseOverButton = false;
                        app.graph.setDirtyCanvas(true, true);
                    }
                    
                    if (origMouseLeave) {
                        return origMouseLeave.call(this, event);
                    }
                };

                // Create bound event handler methods
                this.handlePromptStashSetContinue = (event) => {
                    // Skip if node is in invalid state
                    if (isUnassignedNode(this)) {
                        this.onRemoved?.();
                        return;
                    }
                    
                    if (nodeMatchesUniqueId(this, event.detail.node_id)) {
                        const shouldShow = event.detail.show !== false; // Default to true for backwards compatibility
                        console.log(`${shouldShow ? 'Showing' : 'Hiding'} continue button for node ${this.id}`);
                        this.showContinueButton = shouldShow;
                        this.mouseOverButton = false;    // Reset hover state
                        app.graph.setDirtyCanvas(true, true);
                        
                        // Vue renderer: show/hide DOM button.
                        // Defer slightly so the DOM element exists after Vue renders.
                        if (isVueRenderer()) {
                            setTimeout(() => {
                                updateDomContinueButton(this, shouldShow, handleContinueClick);
                            }, 50);
                        }

                        // Force a redraw after a small delay to ensure visibility when showing
                        if (shouldShow) {
                            setTimeout(() => {
                                if (this.showContinueButton) {
                                    app.graph.setDirtyCanvas(true, true);
                                }
                            }, 100);
                        }
                    }
                };

                // Carry input text forward across runs/tabs (see stash_sync.js).
                installStashSync(this, (text) => {
                    if (!promptWidget) return;
                    promptWidget.value = text;
                    this.serialize_widgets = true;
                    app.graph.setDirtyCanvas(true, true);
                });

                this.handlePromptStashUpdatePrompt = (event) => {
                    // Skip if node is in invalid state
                    if (isUnassignedNode(this)) {
                        this.onRemoved?.();
                        return;
                    }

                    // Applies only to this node in the tab the run was queued from.
                    handlePushedUpdate(this, event.detail);
                };

                // Listen for set-continue event with show/hide parameter
                api.addEventListener("prompt-stash-set-continue", this.handlePromptStashSetContinue);

                // Listen for text updates from input
                api.addEventListener("prompt-stash-update-prompt", this.handlePromptStashUpdatePrompt);

                // Add a method to manually show/hide button (for debugging)
                this.toggleContinueButton = function(show) {
                    console.log(`Manually ${show ? 'showing' : 'hiding'} continue button for node ${this.id}`);
                    this.showContinueButton = show;
                    this.mouseOverButton = false;
                    app.graph.setDirtyCanvas(true, true);
                };

                // Enhanced state checking - periodically verify button should be shown
                // This helps catch edge cases where the button might not appear
                this.stateCheckInterval = setInterval(() => {
                    // Only check if we think button should be hidden
                    if (!this.showContinueButton) {
                        // We could add server-side state verification here if needed
                        // For now, we trust the event system but this provides a hook
                    }
                }, 5000); // Check every 5 seconds

                // Clean up interval, event listeners, and DOM button when node is removed
                const origOnRemoved = this.onRemoved;
                this.onRemoved = function() {
                    if (this.stateCheckInterval) {
                        clearInterval(this.stateCheckInterval);
                    }
                    updateDomContinueButton(this, false);
                    api.removeEventListener("prompt-stash-set-continue", this.handlePromptStashSetContinue);
                    api.removeEventListener("prompt-stash-update-prompt", this.handlePromptStashUpdatePrompt);
                    if (origOnRemoved) {
                        origOnRemoved.call(this);
                    }
                };
            };
        }
    }
});