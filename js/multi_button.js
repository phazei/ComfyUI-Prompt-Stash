import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "phazei.MULTI_BUTTON",
    getCustomWidgets() {
        return {
            MULTI_BUTTON: (node, name, data) => {
                // normalize options
                const opts = data?.options || (Array.isArray(data) ? (data[1] || {}) : (data && typeof data === "object" ? data : {}));
                const btns = Array.isArray(opts.buttons) && opts.buttons.length ? opts.buttons : [{ label: "Action", callback: () => { } }];
                const H = Math.max(22, opts.height ?? 28);
                const pad = Math.max(0, opts.pad ?? 6);
                const gap = Math.max(0, opts.gap ?? 6);
                const alternate = opts.alternate ?? true;
                const selectMode = opts.selectMode ?? null; // "single" | "multi" | null
                const selectedInit = Array.isArray(opts.selected) ? new Set(opts.selected) : new Set();

                // theme keys available in your build
                const T = (LiteGraph?.Themes?.current || LiteGraph);
                const colors = {
                    bg: T.WIDGET_BGCOLOR || "#2b2b2b",
                    fg: T.WIDGET_TEXT_COLOR || "#DDD",
                    border: T.WIDGET_OUTLINE_COLOR || "#666",
                    hi: T.WIDGET_ADVANCED_OUTLINE_COLOR || T.WIDGET_OUTLINE_COLOR || "#888",
                    fontSize: T.NODE_TEXT_SIZE || 12,
                };

                // tiny shade for alternating
                const hexToRgb = (hex) => {
                    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
                    if (!m) return { r: 34, g: 34, b: 34 };
                    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
                };
                const rgbToHex = (r, g, b) => `#${[r, g, b].map(v => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, "0")).join("")}`;
                const lighten = (hex, p = 0.06) => { const { r, g, b } = hexToRgb(hex); const L = c => c + (255 - c) * p; return rgbToHex(L(r), L(g), L(b)); };
                const darken = (hex, p = 0.06) => { const { r, g, b } = hexToRgb(hex); const D = c => c * (1 - p); return rgbToHex(D(r), D(g), D(b)); };
                const { r: _r, g: _g, b: _b } = hexToRgb(colors.bg);
                const lum = (0.2126 * _r + 0.7152 * _g + 0.0722 * _b) / 255;
                const bgAlt = lum < 0.5 ? lighten(colors.bg, 0.06) : darken(colors.bg, 0.06);

                const state = { regions: [], pressed: -1, selected: selectedInit };

                const rr = (ctx, x, y, w, h, r = 6) => {
                    ctx.beginPath();
                    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
                    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
                    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
                    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
                };

                // expose a few controls
                const api = {
                    setDisabled(idx, val) { if (btns[idx]) { btns[idx].disabled = !!val; node.setDirtyCanvas(true, true); } },
                    setSelected(idxOrArr, val) {
                        if (Array.isArray(idxOrArr)) { state.selected = new Set(idxOrArr); }
                        else { if (val) state.selected.add(idxOrArr); else state.selected.delete(idxOrArr); }
                        node.setDirtyCanvas(true, true);
                        opts.onSelect?.(Array.from(state.selected));
                    },
                    getSelected() { return Array.from(state.selected); },
                    setButtons(newBtns) {
                        if (!Array.isArray(newBtns) || !newBtns.length) return;
                        // mutate in place so external refs remain valid
                        btns.length = 0; for (const b of newBtns) btns.push(b);
                        // clamp selections
                        state.selected.forEach(i => { if (i < 0 || i >= btns.length) state.selected.delete(i); });
                        node.setDirtyCanvas(true, true);
                    },
                    update() { node.setDirtyCanvas(true, true); },
                    buttons: btns, // convenience reference
                };

                const widget = {
                    name,
                    type: "custom",
                    serialize: false,

                    // single row; height fixed
                    computeSize: (w) => [w, H],

                    draw(ctx, node, width, y) {
                        ctx.save();

                        const n = Math.max(1, btns.length);
                        const inner = Math.max(0, width - pad * 2);
                        const totalGaps = Math.max(0, gap * (n - 1));
                        const bw = (inner > totalGaps ? (inner - totalGaps) : inner) / n;
                        const bh = H - 6;
                        const y0 = y + 3;

                        state.regions = [];

                        ctx.font = `${colors.fontSize}px sans-serif`;
                        ctx.textAlign = "center";
                        ctx.textBaseline = "middle";

                        for (let i = 0; i < n; i++) {
                            const x = pad + i * (bw + gap);
                            state.regions.push({ x, y: y0, w: bw, h: bh });

                            const disabled = !!btns[i]?.disabled;
                            const isSel = state.selected.has(i);

                            // fill
                            rr(ctx, x, y0, bw, bh, 6);
                            ctx.save();
                            ctx.fillStyle = alternate ? (i % 2 ? bgAlt : colors.bg) : colors.bg;
                            if (disabled) ctx.globalAlpha = 0.5;
                            ctx.fill();
                            ctx.restore();

                            // selected overlay (subtle)
                            if (isSel) {
                                ctx.save();
                                ctx.globalAlpha = 0.18;
                                ctx.fillStyle = colors.hi;
                                rr(ctx, x, y0, bw, bh, 6);
                                ctx.fill();
                                ctx.restore();
                            }

                            // normal border
                            ctx.save();
                            ctx.lineWidth = 1;
                            ctx.strokeStyle = colors.border;
                            rr(ctx, x, y0, bw, bh, 6);
                            ctx.stroke();
                            ctx.restore();

                            // pressed border
                            if (state.pressed === i) {
                                ctx.save();
                                ctx.lineWidth = 2;
                                ctx.strokeStyle = colors.hi;
                                rr(ctx, x, y0, bw, bh, 6);
                                ctx.stroke();
                                ctx.restore();
                            }

                            // label
                            ctx.save();
                            ctx.fillStyle = colors.fg;
                            if (disabled) ctx.globalAlpha = 0.6;
                            ctx.beginPath(); ctx.rect(x + 4, y0, Math.max(0, bw - 8), bh); ctx.clip();
                            ctx.fillText(btns[i]?.label ?? `B${i + 1}`, x + bw / 2, y0 + bh / 2);
                            ctx.restore();
                        }

                        ctx.restore();
                    },

                    // supports (event, x, y) and (event, [x,y])
                    mouse(event, a, b) {
                        const lx = Array.isArray(a) ? a[0] : a;
                        const ly = Array.isArray(a) ? a[1] : b;
                        const hit = state.regions.findIndex(r => lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h);

                        if (event.type === "pointerdown") {
                            if (hit !== -1 && !btns[hit]?.disabled) {
                                state.pressed = hit;
                                node.setDirtyCanvas(true);
                                return true;
                            }
                        }
                        if (event.type === "pointerup") {
                            const i = state.pressed;
                            state.pressed = -1;
                            if (i !== -1 && i === hit && !btns[i]?.disabled) {

                                // confirm (optional) -> action -> selection
                                const b = btns[i];
                                let go = true;
                                if (b?.confirm && typeof window !== "undefined" && window.confirm) {
                                    const msg = typeof b.confirm === "string" ? b.confirm : "Are you sure?";
                                    go = window.confirm(msg);
                                }

                                if (go) {

                                    // action
                                    b?.callback?.(node, i);

                                    // selection behavior
                                    if (selectMode === "single") {
                                        state.selected.clear();
                                        state.selected.add(i);
                                        opts.onSelect?.(Array.from(state.selected));
                                    } else if (selectMode === "multi") {
                                        if (state.selected.has(i)) state.selected.delete(i);
                                        else state.selected.add(i);
                                        opts.onSelect?.(Array.from(state.selected));
                                    }
                                }

                                node.setDirtyCanvas(true);
                                return true;
                            }
                            node.setDirtyCanvas(true);
                        }
                        if (event.type === "pointerleave" || event.type === "pointercancel") {
                            state.pressed = -1;
                            node.setDirtyCanvas(true);
                        }
                        return false;
                    },

                    // expose control surface
                    setDisabled: (...a) => api.setDisabled(...a),
                    setSelected: (...a) => api.setSelected(...a),
                    getSelected: () => api.getSelected(),
                    setButtons: (...a) => api.setButtons(...a),
                    update: () => api.update(),
                    buttons: api.buttons,
                };

                return widget;
            },
        };
    },
});
