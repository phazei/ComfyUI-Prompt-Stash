import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { nodeMatchesUniqueId, getUniqueIdFromNode } from "./utils.js";

app.registerExtension({
    name: "phazei.PromptStashPassthrough",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "PromptStashPassthrough") {
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

                // Update widget labels - do not change ".name", will break synch with py
                useInputWidget.label = "Use ____";
                pauseToEditWidget.label = "Pause to Edit";

                // Button state tracking
                this.showContinueButton = false;
                this.buttonArea = null;
                this.mouseOverButton = false;

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

                            // Get current text value
                            const currentText = promptWidget ? promptWidget.value : "";

                            // Get the full unique ID path for subgraph support
                            const uniqueId = getUniqueIdFromNode(this);
                            
                            // Handle the button click
                            api.fetchApi(`/prompt_stash_passthrough/continue/${uniqueId}`, {
                                method: "POST",
                                body: JSON.stringify({ text: currentText })
                            }).then(response => {
                                if (response.ok) {
                                    this.showContinueButton = false;  // Hide button
                                    this.mouseOverButton = false;    // Reset hover state
                                    graphcanvas.canvas.style.cursor = "default"; // Reset cursor
                                    app.graph.setDirtyCanvas(true, true);
                                    console.log("Workflow continued successfully");
                                } else {
                                    console.error("Failed to continue workflow, status:", response.status);
                                }
                            }).catch(error => {
                                console.error("Error continuing workflow:", error);
                                // Could add toast notification here if available
                                if (app.extensionManager?.toast) {
                                    app.extensionManager.toast.add({
                                        severity: "error",
                                        summary: "Continue Failed",
                                        detail: "Could not continue workflow execution",
                                        life: 5000
                                    });
                                }
                            });

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
                    if (this.id === -1) {
                        this.onRemoved?.();
                        return;
                    }
                    
                    if (nodeMatchesUniqueId(this, event.detail.node_id)) {
                        const shouldShow = event.detail.show !== false; // Default to true for backwards compatibility
                        console.log(`${shouldShow ? 'Showing' : 'Hiding'} continue button for node ${this.id}`);
                        this.showContinueButton = shouldShow;
                        this.mouseOverButton = false;    // Reset hover state
                        app.graph.setDirtyCanvas(true, true);
                        
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

                this.handlePromptStashUpdatePrompt = (event) => {
                    // Skip if node is in invalid state
                    if (this.id === -1) {
                        this.onRemoved?.();
                        return;
                    }

                    if (nodeMatchesUniqueId(this, event.detail.node_id)) {
                        if (promptWidget) {
                            promptWidget.value = event.detail.prompt;
                            this.serialize_widgets = true;
                            app.graph.setDirtyCanvas(true, true);
                        }
                    }
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

                // Clean up interval and event listeners when node is removed
                const origOnRemoved = this.onRemoved;
                this.onRemoved = function() {
                    if (this.stateCheckInterval) {
                        clearInterval(this.stateCheckInterval);
                    }
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