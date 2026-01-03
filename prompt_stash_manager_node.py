import os
import json
from server import PromptServer
from .data_utils import init_data_file

class PromptStashManager:
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
                "new_list_name": ("STRING", {"default": "", "placeholder": "Enter new list name"}),
            }
        }

    RETURN_TYPES = ()  # No outputs
    FUNCTION = "process"
    CATEGORY = "utils"

    def load_data(self):
        if os.path.exists(self.data_file):
            try:
                with open(self.data_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
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

    def add_list(self, list_name):
        list_name = list_name.strip()
        if not list_name:
            return False
        
        if list_name not in self.data["lists"]:
            self.data["lists"][list_name] = {}
            success = self.save_data()
            
            if success:
                # Notify all nodes of the update
                PromptServer.instance.send_sync("prompt-stash-update-all", {
                    "lists": self.data["lists"]
                })
            return success
        return False

    def delete_list(self, list_name):
        # Prevent deleting default list
        # if list_name == "default":
        #     return False
        if len(self.data["lists"]) <= 1:
            return False
            
        if list_name in self.data["lists"]:
            del self.data["lists"][list_name]
            success = self.save_data()
            
            if success:
                # Notify all nodes of the update
                PromptServer.instance.send_sync("prompt-stash-update-all", {
                    "lists": self.data["lists"]
                })
            return success
        return False

    def process(self, new_list_name=""):
        return ()