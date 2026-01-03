import os
import json
from server import PromptServer
import hashlib
from .data_utils import init_data_file

class PromptStashSaver:
    def __init__(self):
        self.base_dir = os.path.dirname(os.path.realpath(__file__))
        self.data_file = init_data_file(self.base_dir)
        self.data = self.load_data()

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
            },
            "optional": {
                "use_input_text": ("BOOLEAN", {"default": False, "label_on": "Use Input", "label_off": "Use Prompt"}),
                "text": ("STRING", {"default": "", "forceInput": True, "tooltip": "Optional input text", "lazy": True}),
                "prompt_text": ("STRING", {"multiline": True, "default": "", "placeholder": "Enter prompt text"}),
                "save_as_key": ("STRING", {"default": "", "placeholder": "Enter key to save as"}),
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
    def IS_CHANGED(cls, use_input_text=False, text="", prompt_text="", save_as_key="", unique_id=None, extra_pnginfo=None, prompt=None):
        m = hashlib.sha256()
        
        # Always include these parameters as they affect the output
        m.update(str(use_input_text).encode())
        m.update(str(prompt_text).encode())
        m.update(str(unique_id).encode())
        
        # Only include the text input if use_input_text is True
        if use_input_text and text is not None:
            m.update(str(text).encode())
        
        return m.hexdigest()
        
    def check_lazy_status(self, use_input_text=False, text="", prompt_text="", save_as_key="", unique_id=None, extra_pnginfo=None, prompt=None):
        # Only need the text input if use_input_text is True
        needed = []
        if use_input_text:
            needed.append("text")
        return needed

    def load_data(self):
        if os.path.exists(self.data_file):
            try:
                with open(self.data_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    # Broadcast initial data to all nodes
                    PromptServer.instance.send_sync("prompt-stash-update-all", {
                        "lists": data.get("lists", {"default": {}})
                    })
                    return data
            except Exception as e:
                print(f"Error loading prompts: {e}")
        return {"lists": {"default": {}}}

    def save_data(self):
        try:
            os.makedirs(os.path.dirname(self.data_file), exist_ok=True)
            with open(self.data_file, 'w', encoding='utf-8') as f:
                json.dump(self.data, f, indent=2)
            return True
        except Exception as e:
            print(f"Error saving data: {e}")
            return False

    def save_prompt(self, save_as_key, prompt, list_name, unique_id):
        save_as_key = save_as_key.strip()
        if not save_as_key or not prompt:
            return False
            
        if list_name not in self.data["lists"]:
            list_name = "default"
            
        self.data["lists"][list_name][save_as_key] = prompt
        success = self.save_data()
        
        if success:
            # Notify all nodes of the update
            PromptServer.instance.send_sync("prompt-stash-update-all", {
                "lists": self.data["lists"]
            })
        return success

    def delete_prompt(self, save_as_key, list_name, unique_id):
        if list_name not in self.data["lists"]:
            return False
            
        if save_as_key in self.data["lists"][list_name]:
            del self.data["lists"][list_name][save_as_key]
            success = self.save_data()
            
            if success:
                # Notify all nodes of the update
                PromptServer.instance.send_sync("prompt-stash-update-all", {
                    "lists": self.data["lists"]
                })
            return success
        return False

    def process(self, use_input_text=False, text="", prompt_text="", save_as_key="", unique_id=None, extra_pnginfo=None, prompt=None):
        # Update the prompt text based on use_input_text toggle
        output_text = prompt_text
        if use_input_text and text is not None:
            output_text = text
            # Send update to frontend to update prompt widget
            PromptServer.instance.send_sync("prompt-stash-update-prompt", {
                "node_id": unique_id,
                "prompt": text
            })

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
                    # Set use_input_text to False in metadata (index 0 based on INPUT_TYPES order)
                    use_input_text_index = 0  # First widget in optional inputs
                    prompt_text_index = 1     # Second non-forceInput widget in optional inputs

                    # Update the values in metadata
                    node["widgets_values"][use_input_text_index] = False  # Force use_input_text to False in metadata
                    node["widgets_values"][prompt_text_index] = output_text  # Update the prompt text


            if prompt and unique_id is not None:
                node_id_str = str(unique_id)
                if node_id_str in prompt:
                    prompt[node_id_str]['inputs']['use_input_text'] = False
                    prompt[node_id_str]['inputs']['prompt_text'] = output_text

        return (output_text,)