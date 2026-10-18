class PromptStashEveryNthQueue:
    """
    Outputs True once every N queued runs, False otherwise.

    The countdown lives entirely in the frontend (saved in the workflow's node
    properties) and is never sent to the backend. At queue time the JS resolves
    it into the hidden `value` widget, so the backend only ever sees a constant
    boolean:

      * every off run has an identical cache key, so nothing downstream re-runs;
      * Prompt Stash nodes can read `value` straight from the queued prompt and
        drop their unused `text` link (see stripUnusedTextLinks in the JS).

    Without the frontend (e.g. API use), this behaves like a plain Boolean node.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "every": ("INT", {
                    "default": 3, "min": 1, "max": 100000, "step": 1,
                    "tooltip": "Output True once every this many queued runs.",
                }),
            },
            "optional": {
                # Set by the frontend at queue time from its countdown. Hidden on
                # the node; it is the only per-run value the backend sees.
                "value": ("BOOLEAN", {"default": False, "hidden": True}),
            },
        }

    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("boolean",)
    OUTPUT_TOOLTIPS = ("True on every Nth queued run, False otherwise.",)
    FUNCTION = "process"
    CATEGORY = "utils"
    DESCRIPTION = (
        "Outputs True once every N queued runs. The countdown is kept in the "
        "workflow and resolved when you queue, so off runs stay fully cached."
    )

    def process(self, every=3, value=False):
        return (bool(value),)
