import { app } from "../../scripts/app.js";

// ── Every Nth Queue ──────────────────────────────────────────────────────
//
// Outputs True once every N queued runs. The countdown is kept ONLY in the
// frontend (node.properties.countdown, saved with the workflow) and is never
// sent to the backend. Just before each prompt is built, the frontend calls
// widget.beforeQueued() on every node (once per batch item, including nodes
// inside subgraphs). We use that hook to resolve the countdown into the hidden
// `value` widget, so the queued prompt only ever carries a constant boolean:
//
//   * every off run has an identical cache key -> nothing downstream re-runs;
//   * Prompt Stash nodes read `value` straight from the queued prompt and drop
//     their unused `text` link (see resolveConstantBool in utils.js).
//
// countdown semantics: number of queued runs until the next True, counting
// that run. countdown === 1 means "True next run".

const NODE_CLASS = "PromptStashEveryNthQueue";

// LGraphEventMode: 2 = NEVER (muted), 4 = BYPASS. Such nodes are left out of
// the prompt, so they shouldn't consume a run.
const MODE_NEVER = 2;
const MODE_BYPASS = 4;

function toPositiveInt(v, fallback) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 ? n : fallback;
}

app.registerExtension({
    name: "phazei.PromptStashEveryNthQueue",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            const node = this;

            node.properties ??= {};
            // Fire on the very first queue: a fresh node has nothing stashed yet.
            if (node.properties.countdown === undefined) node.properties.countdown = 1;

            const everyWidget = node.widgets?.find((w) => w.name === "every");
            const valueWidget = node.widgets?.find((w) => w.name === "value");

            const getEvery = () => toPositiveInt(everyWidget?.value, 1);
            const getCountdown = () => toPositiveInt(node.properties.countdown, 1);
            const setCountdown = (n) => {
                node.properties.countdown = toPositiveInt(n, 1);
                redraw();
            };

            // addCustomWidget wraps our plain object in a new widget instance;
            // Nodes 2.0 attaches triggerDraw to that instance, so keep it.
            let statusInstance = null;
            const redraw = () => {
                node.setDirtyCanvas?.(true, true);
                statusInstance?.triggerDraw?.();
            };

            // ── Hidden value widget ──────────────────────────────────────
            node._hideValueInput = () => {
                if (valueWidget) {
                    valueWidget.hidden = true;
                    // Fallback for renderers that ignore `hidden`.
                    valueWidget.computeSize = () => [0, -4];
                }
                // The value is driven by the countdown; a socket for it would
                // only invite confusing links.
                const idx = node.inputs?.findIndex((i) => i.widget?.name === "value") ?? -1;
                if (idx >= 0) node.removeInput(idx);
            };
            node._hideValueInput();

            // Keep the countdown within range when the period shrinks.
            if (everyWidget) {
                const origCallback = everyWidget.callback;
                everyWidget.callback = function (...args) {
                    const res = origCallback?.apply(this, args);
                    if (getCountdown() > getEvery()) setCountdown(getEvery());
                    else redraw();
                    return res;
                };
            }

            // ── Status line ──────────────────────────────────────────────
            const statusText = () => {
                const cd = getCountdown();
                return cd <= 1 ? "True next run" : `True in ${cd} runs`;
            };

            const statusWidget = {
                name: "status",
                type: "custom",
                serialize: false,              // not stored in widgets_values
                options: { serialize: false }, // not sent in the API prompt
                computeSize: (w) => [w, 24],
                draw(ctx, _node, width, y) {
                    const T = (globalThis.LiteGraph?.Themes?.current || globalThis.LiteGraph || {});
                    const fire = getCountdown() <= 1;
                    ctx.save();
                    ctx.font = `${T.NODE_TEXT_SIZE || 12}px sans-serif`;
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillStyle = fire ? "#7fd17f" : (T.WIDGET_TEXT_COLOR || "#DDD");
                    ctx.fillText(statusText(), width / 2, y + 12);
                    ctx.restore();
                },
                // Resolve the countdown into `value` right before each prompt is
                // built. Called once per queued prompt (each batch item).
                beforeQueued(options) {
                    if (node.mode === MODE_NEVER || node.mode === MODE_BYPASS) return;

                    const cd = getCountdown();
                    const fire = cd <= 1;
                    if (valueWidget) valueWidget.value = fire;

                    // Partial runs ("run" on a single output) don't advance the
                    // countdown, matching control_after_generate's behaviour.
                    if (!options?.isPartialExecution) {
                        setCountdown(fire ? getEvery() : cd - 1);
                    }
                },
            };
            statusInstance = node.addCustomWidget(statusWidget) ?? statusWidget;

            // ── Buttons: one compact row ─────────────────────────────────
            if (typeof app.widgets?.MULTI_BUTTON === "function") {
                const row = app.widgets.MULTI_BUTTON(node, "countdown_actions", {
                    options: {
                        buttons: [
                            { label: "Next", callback: () => setCountdown(1) },
                            { label: "Delay +1", callback: () => setCountdown(getCountdown() + 1) },
                            { label: "Reset", callback: () => setCountdown(getEvery()) },
                        ],
                        height: 26, gap: 6, pad: 10,
                        alternate: false,
                    },
                }, app);
                row.options = { ...(row.options || {}), serialize: false };
                node.addCustomWidget(row);
            }

            node.setSize?.(node.computeSize());
            return r;
        };

        // Saved workflows restore properties.countdown via configure(); make
        // sure the value socket stays hidden if anything re-added it.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            this._hideValueInput?.();
            return r;
        };
    },
});
