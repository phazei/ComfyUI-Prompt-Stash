import os
import datetime
import json

from .prompt_stash_passthrough_node import PromptStashPassthrough
from .prompt_stash_saver_node import PromptStashSaver
from .prompt_stash_manager_node import PromptStashManager
from aiohttp import web
from server import PromptServer
from .data_utils import get_user_data_directory, validate_import_data, deep_merge_lists

@PromptServer.instance.routes.post("/prompt_stash_saver/save")
async def save_prompt(request):
    json_data = await request.json()
    node = PromptStashSaver()
    success = node.save_prompt(json_data["title"], json_data["prompt"], json_data["list_name"], json_data["node_id"])
    return web.json_response({"success": success})

@PromptServer.instance.routes.post("/prompt_stash_saver/delete")
async def delete_prompt(request):
    json_data = await request.json()
    node = PromptStashSaver()
    success = node.delete_prompt(json_data["title"], json_data["list_name"], json_data["node_id"])
    return web.json_response({"success": success})

@PromptServer.instance.routes.post("/prompt_stash_saver/init")
async def init_node(request):
    json_data = await request.json()
    node = PromptStashSaver()
    data = {
        "lists": node.data["lists"]
    }
    return web.json_response(data)

@PromptServer.instance.routes.post("/prompt_stash_saver/get_prompt")
async def get_prompt(request):
    json_data = await request.json()
    node = PromptStashSaver()
    list_name = json_data["list_name"]
    if list_name not in node.data["lists"]:
        list_name = "default"
    prompt = node.data["lists"][list_name].get(json_data["title"], "")
    return web.json_response({"prompt": prompt})

@PromptServer.instance.routes.post("/prompt_stash_saver/add_list")
async def add_list(request):
    json_data = await request.json()
    node = PromptStashManager()
    success = node.add_list(json_data["list_name"])
    return web.json_response({"success": success})

@PromptServer.instance.routes.post("/prompt_stash_saver/delete_list")
async def delete_list(request):
    json_data = await request.json()
    node = PromptStashManager()
    success = node.delete_list(json_data["list_name"])
    return web.json_response({"success": success})

@PromptServer.instance.routes.get("/prompt_stash_manager/export")
async def export_data(request):
    """Export prompt stash data as downloadable file."""
    try:
        # Get the data file path
        user_dir = get_user_data_directory()
        if user_dir:
            data_file = os.path.join(user_dir, "prompt_stash_data.json")
        else:
            # Fallback to node directory method
            node = PromptStashSaver()
            data_file = node.data_file

        # Check if file exists
        if not os.path.exists(data_file):
            return web.json_response({"error": "Data file not found"}, status=404)

        # Generate timestamp for filename
        now = datetime.datetime.now()
        timestamp = now.strftime("%Y-%m-%d_%H-%M")
        filename = f"prompt_stash_export_{timestamp}.json"

        # Read and return file
        with open(data_file, 'rb') as f:
            file_data = f.read()

        # Set headers for download
        headers = {
            'Content-Type': 'application/json',
            'Content-Disposition': f'attachment; filename="{filename}"',
            'Content-Length': str(len(file_data))
        }

        return web.Response(
            body=file_data,
            headers=headers
        )

    except Exception as e:
        print(f"Export error: {e}")
        return web.json_response({"error": str(e)}, status=500)

@PromptServer.instance.routes.post("/prompt_stash_manager/import")
async def import_data(request):
    """Import and merge prompt stash data from uploaded file."""
    try:
        # Parse multipart form data
        reader = await request.multipart()
        file_field = await reader.next()
        
        if not file_field or file_field.name != 'file':
            return web.json_response({"error": "No file uploaded"}, status=400)
        
        # Read file content
        file_content = await file_field.read()
        
        # Parse JSON
        try:
            import_data = json.loads(file_content.decode('utf-8'))
        except json.JSONDecodeError as e:
            return web.json_response({"error": f"Invalid JSON format: {str(e)}"}, status=400)
        except UnicodeDecodeError:
            return web.json_response({"error": "File must be UTF-8 encoded"}, status=400)
        
        # Validate import data structure
        is_valid, error_msg, cleaned_lists = validate_import_data(import_data)
        if not is_valid:
            return web.json_response({"error": error_msg}, status=400)
        
        # Get current data file
        user_dir = get_user_data_directory()
        if user_dir:
            data_file = os.path.join(user_dir, "prompt_stash_data.json")
        else:
            # Fallback to node directory method
            node = PromptStashSaver()
            data_file = node.data_file
        
        # Read current data
        if os.path.exists(data_file):
            with open(data_file, 'r', encoding='utf-8') as f:
                current_data = json.load(f)
        else:
            current_data = {"version": "1.0", "lists": {"default": {}}}
        
        # Perform deep merge
        current_lists = current_data.get("lists", {})
        merged_lists, merge_summary = deep_merge_lists(current_lists, cleaned_lists)
        
        # Update and save data
        current_data["lists"] = merged_lists
        with open(data_file, 'w', encoding='utf-8') as f:
            json.dump(current_data, f, indent=2)
        
        # Notify all nodes of the update
        PromptServer.instance.send_sync("prompt-stash-update-all", {
            "lists": merged_lists
        })
        
        print(f"Prompt Stash: Import successful - {merge_summary}")
        
        return web.json_response({
            "success": True,
            "summary": merge_summary
        })
        
    except Exception as e:
        print(f"Import error: {e}")
        return web.json_response({"error": f"Import failed: {str(e)}"}, status=500)

NODE_CLASS_MAPPINGS = {
    "PromptStashPassthrough": PromptStashPassthrough,
    "PromptStashSaver": PromptStashSaver,
    "PromptStashManager": PromptStashManager
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptStashPassthrough": "Prompt Stash Passthrough",
    "PromptStashSaver": "Prompt Stash Saver",
    "PromptStashManager": "Prompt Stash Manager"
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]