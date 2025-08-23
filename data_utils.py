import os
import json
import shutil
import folder_paths

file_version = "1.0"

def get_user_data_directory():
    """Get the user data directory for prompt stash files."""
    try:
        # Use ComfyUI's official get_user_directory function
        user_base = folder_paths.get_user_directory()
        user_dir = os.path.join(user_base, "prompt_stash")

        # Ensure the directory exists
        os.makedirs(user_dir, exist_ok=True)

        return user_dir
    except Exception as e:
        print(f"Warning: Could not create user directory for Prompt Stash: {e}")
        return None

def migrate_data_file_if_needed(old_base_dir, new_data_file):
    """Migrate data file from old location to new location if it exists."""
    old_data_file = os.path.join(old_base_dir, "prompt_stash_data.json")

    if os.path.exists(old_data_file) and not os.path.exists(new_data_file):
        try:
            # Copy the file to the new location
            shutil.copy2(old_data_file, new_data_file)

            # Remove the old file
            os.remove(old_data_file)

            print(f"Prompt Stash: Migrated data file from {old_data_file} to {new_data_file}")
            return True
        except Exception as e:
            print(f"Warning: Failed to migrate Prompt Stash data file: {e}")
            return False

    return False

def deep_merge_lists(existing_lists, import_lists):
    """
    Deep merge imported lists into existing lists with conflict resolution.
    If a key already exists, append (2), (3), etc. to make it unique.
    Returns the merged lists and a summary of what was merged.
    """
    merged = existing_lists.copy()
    summary = {
        "lists_added": [],
        "lists_merged": [],
        "prompts_added": 0,
        "prompts_renamed": []
    }
    
    for list_name, import_prompts in import_lists.items():
        if list_name not in merged:
            # New list - add it directly
            merged[list_name] = import_prompts.copy()
            summary["lists_added"].append(list_name)
            summary["prompts_added"] += len(import_prompts)
        else:
            # List exists - merge prompts with conflict resolution
            existing_prompts = merged[list_name]
            summary["lists_merged"].append(list_name)
            
            for prompt_key, prompt_value in import_prompts.items():
                if prompt_key not in existing_prompts:
                    # No conflict - add directly
                    existing_prompts[prompt_key] = prompt_value
                    summary["prompts_added"] += 1
                else:
                    # Conflict - find unique name
                    base_key = prompt_key
                    counter = 2
                    new_key = f"{base_key} ({counter})"
                    
                    while new_key in existing_prompts:
                        counter += 1
                        new_key = f"{base_key} ({counter})"
                    
                    existing_prompts[new_key] = prompt_value
                    summary["prompts_added"] += 1
                    summary["prompts_renamed"].append({
                        "original": prompt_key,
                        "renamed": new_key,
                        "list": list_name
                    })
    
    return merged, summary

def validate_import_data(data):
    """
    Validate imported JSON data structure.
    Returns (is_valid, error_message, cleaned_data).
    """
    if not isinstance(data, dict):
        return False, "Import data must be a JSON object", None
    
    # Check for required 'lists' key
    if "lists" not in data:
        return False, "Import data must contain a 'lists' object", None
    
    lists = data["lists"]
    if not isinstance(lists, dict):
        return False, "The 'lists' field must be an object", None
    
    # Validate each list
    cleaned_lists = {}
    for list_name, prompts in lists.items():
        if not isinstance(list_name, str) or not list_name.strip():
            continue  # Skip invalid list names
        
        if not isinstance(prompts, dict):
            continue  # Skip invalid prompt collections
        
        # Clean prompt data
        cleaned_prompts = {}
        for prompt_key, prompt_value in prompts.items():
            if isinstance(prompt_key, str) and prompt_key.strip() and isinstance(prompt_value, str):
                cleaned_prompts[prompt_key.strip()] = prompt_value
        
        if cleaned_prompts:  # Only add lists that have valid prompts
            cleaned_lists[list_name.strip()] = cleaned_prompts
    
    if not cleaned_lists:
        return False, "No valid prompt lists found in import data", None
    
    return True, None, cleaned_lists

def init_data_file(node_base_dir):
    """Initialize data file, preferring user directory with migration support."""

    # Try to get user directory first
    user_dir = get_user_data_directory()

    if user_dir:
        # Use user directory
        data_file = os.path.join(user_dir, "prompt_stash_data.json")
        default_file = os.path.join(node_base_dir, "default_prompt_stash_data.json")

        # Check if we need to migrate from old location
        migrate_data_file_if_needed(node_base_dir, data_file)

    else:
        # Fallback to node directory
        print("Prompt Stash: Using node directory as fallback for data storage")
        data_file = os.path.join(node_base_dir, "prompt_stash_data.json")
        default_file = os.path.join(node_base_dir, "default_prompt_stash_data.json")

    if not os.path.exists(data_file):
        # Create default data structure WITH VERSION
        default_data = {
            "version": file_version,
            "lists": {
                "default": {
                    "Instructions": "📝 Quick Tips:\n\n• 'Use Input' takes text from input node\n• 'Use Prompt' uses text from prompt box (input node won't run)\n\n• Prompt saves only if 'Save Name' is filled\n• Saving to an existing name overwrites it\n\n• Use 'List' dropdown to select prompt lists\n• Manage lists with the Prompt Stash Manager node\n\n• Saved prompts persist between sessions\n• All nodes share the same prompt library",
                }
            }
        }

        try:
            # If default template exists, use it instead
            if os.path.exists(default_file):
                # Load default template and ensure it has version
                with open(default_file, 'r', encoding='utf-8') as f:
                    template_data = json.load(f)

                # Add version if not present
                if "version" not in template_data:
                    template_data["version"] = file_version

                # Save to data file
                with open(data_file, 'w', encoding='utf-8') as f:
                    json.dump(template_data, f, indent=2)

                print(f"Prompt Stash: Initialized data file from template at {data_file}")
            else:
                # Otherwise use the minimal default data
                with open(data_file, 'w', encoding='utf-8') as f:
                    json.dump(default_data, f, indent=2)
                print(f"Prompt Stash: Created new data file at {data_file}")
        except Exception as e:
            print(f"Error initializing Prompt Stash data file: {e}")
            # If all else fails, create with minimal structure
            try:
                with open(data_file, 'w', encoding='utf-8') as f:
                    json.dump({"version": file_version, "lists": {"default": {}}}, f, indent=2)
            except Exception as e2:
                print(f"Critical error: Could not create Prompt Stash data file: {e2}")
                return None
    else:
        # File exists - ensure it has version info
        try:
            with open(data_file, 'r', encoding='utf-8') as f:
                data = json.load(f)

            # Add version if missing
            if "version" not in data:
                data["version"] = file_version
                with open(data_file, 'w', encoding='utf-8') as f:
                    json.dump(data, f, indent=2)
                print("Prompt Stash: Added version info to existing data file")
        except Exception as e:
            print(f"Warning: Could not update data file with version info: {e}")

    return data_file