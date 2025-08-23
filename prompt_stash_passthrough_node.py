import comfy
from server import PromptServer
from aiohttp import web
import time
import hashlib
from comfy.model_management import InterruptProcessingException

class PromptStashPassthrough:
    status_by_id = {}  # Track pause status for each node instance
    edited_text_by_id = {}  # Store edited text during pause

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
            },
            "optional": {
                "use_input_text": ("BOOLEAN", {"default": False, "label_on": "Use Input", "label_off": "Use Prompt"}),
                "text": ("STRING", {"default": "", "forceInput": True, "tooltip": "Optional input text", "lazy": True}),
                "prompt_text": ("STRING", {"multiline": True, "default": "", "placeholder": "Enter prompt text"}),
                "pause_to_edit": ("BOOLEAN", {"default": False, "label_on": "Yes", "label_off": "No"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "prompt": "PROMPT",
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "process"
    CATEGORY = "utils"
    

    @classmethod
    def IS_CHANGED(cls, use_input_text=False, text="", prompt_text="", pause_to_edit=False, unique_id=None, extra_pnginfo=None, prompt=None):
        m = hashlib.sha256()
        
        # Always include these parameters as they affect the output
        m.update(str(use_input_text).encode())
        m.update(str(prompt_text).encode())
        m.update(str(pause_to_edit).encode())
        m.update(str(unique_id).encode())
        
        # Only include the text input if use_input_text is True
        if use_input_text and text is not None:
            m.update(str(text).encode())
        
        return m.hexdigest()

    def check_lazy_status(self, use_input_text=False, text="", prompt_text="", pause_to_edit=False, unique_id=None, extra_pnginfo=None, prompt=None):
        needed = []
        if use_input_text:
            needed.append("text")
        return needed

    def process(self, use_input_text=False, text="", prompt_text="", pause_to_edit=False, unique_id=None, extra_pnginfo=None, prompt=None):
        # Update the prompt text based on use_input_text toggle
        output_text = prompt_text
        if use_input_text and text is not None:
            output_text = text
            # Send update to frontend to update prompt widget
            PromptServer.instance.send_sync("prompt-stash-update-prompt", {
                "node_id": unique_id,
                "prompt": text
            })

        # Handle pausing if pause_to_edit is enabled
        if pause_to_edit:
            # Set status to paused and notify frontend
            self.status_by_id[unique_id] = "paused"
            PromptServer.instance.send_sync("prompt-stash-enable-continue", {
                "node_id": unique_id
            })

            # Wait in loop until continued
            while self.status_by_id.get(unique_id) == "paused":
                time.sleep(0.1)

            # Get the edited text that was sent with the continue signal
            if unique_id in self.edited_text_by_id:
                output_text = self.edited_text_by_id[unique_id]
                del self.edited_text_by_id[unique_id]

            # Clean up status
            if unique_id in self.status_by_id:
                del self.status_by_id[unique_id]

        if (use_input_text and text is not None) or (pause_to_edit):

            # Handle both list and dict formats of extra_pnginfo
            workflow = None
            if isinstance(extra_pnginfo, list) and len(extra_pnginfo) > 0:
                workflow = extra_pnginfo[0].get("workflow")
            elif isinstance(extra_pnginfo, dict):
                workflow = extra_pnginfo.get("workflow")

            if workflow:
                node = next(
                    (x for x in workflow["nodes"] if str(x["id"]) == str(unique_id)),
                    None
                )
                if node and "widgets_values" in node:
                    # Note: forceInput fields (like 'text') don't count in the widget_values indexing
                    use_input_text_index = 0  # First widget in optional inputs
                    prompt_text_index = 1     # Second widget (excluding forceInput)
                    pause_to_edit_index = 2   # Third widget

                    # Update the values in metadata
                    node["widgets_values"][use_input_text_index] = False  # Force use_input_text to False
                    node["widgets_values"][prompt_text_index] = output_text  # Update the prompt text
                    node["widgets_values"][pause_to_edit_index] = False  # Force pause_to_edit to False

            if prompt and unique_id is not None:
                node_id_str = str(unique_id)
                if node_id_str in prompt:
                    prompt[node_id_str]['inputs']['use_input_text'] = False
                    prompt[node_id_str]['inputs']['prompt_text'] = output_text

        return (output_text,)

# Add route for continue button
@PromptServer.instance.routes.post("/prompt_stash_passthrough/continue/{node_id}")
async def continue_node(request):
    node_id = request.match_info["node_id"].strip()
    data = await request.json()
    edited_text = data.get("text", "")
    
    if node_id in PromptStashPassthrough.status_by_id:
        PromptStashPassthrough.edited_text_by_id[node_id] = edited_text
        PromptStashPassthrough.status_by_id[node_id] = "continue"
    return web.json_response({"status": "ok"})

@PromptServer.instance.routes.post("/prompt_stash_passthrough/clear_all")
async def clear_all_paused(request):
    PromptStashPassthrough.status_by_id.clear()
    PromptStashPassthrough.edited_text_by_id.clear()
    return web.json_response({"status": "ok"})
