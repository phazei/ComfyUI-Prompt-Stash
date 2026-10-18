"""
Backend memory of the latest input text per stash node, so it carries forward
to later runs even when the frontend never received it.

Problem: on an off run (use_input_text false) a stash node outputs its
`prompt_text` widget -- the copy captured when the prompt was queued. Text
from a True run only reaches that widget if the workflow is the active tab
when the update is pushed. Prompts queued ahead, or a tab in the background,
keep using the old text.

Fix: a True run stores its text here under (tab path, node unique_id) with a
fresh random token. Every queued prompt carries the tab path and the token of
the text its widget last took in (`stash_tab` / `stash_token`, injected by the
frontend). On an off run, if the stored token differs from the one sent, the
frontend didn't have that text yet, so the stored text is used instead.

Tokens are compared for equality, never ordered, so a server restart (which
empties this in-memory store) can never make old text look newer.

Keyed by the frontend's tab path rather than the workflow id: the id is kept
when a workflow is re-opened from an image or saved, so two open tabs can share
it; two open tabs never share a path.
"""

import threading
import uuid

from aiohttp import web
from server import PromptServer

UPDATE_EVENT = "prompt-stash-update-prompt"

_lock = threading.Lock()
_store = {}  # (tab, unique_id) -> {"text": str, "token": str}


def _key(tab, unique_id):
    return (str(tab), str(unique_id))


def store_text(tab, unique_id, text):
    """Record new input text for a node. Returns the new token, or "" when the
    tab is unknown (no frontend, e.g. API use) and nothing was stored."""
    if not tab or unique_id is None:
        return ""
    token = uuid.uuid4().hex
    with _lock:
        _store[_key(tab, unique_id)] = {"text": str(text), "token": token}
    return token


def replace_text(tab, unique_id, text):
    """Update the stored text in place, keeping its token (e.g. after the user
    edits it during a pause). No-op if nothing is stored for the node."""
    if not tab or unique_id is None:
        return
    with _lock:
        entry = _store.get(_key(tab, unique_id))
        if entry is not None:
            entry["text"] = str(text)


def get_entry(tab, unique_id):
    if not tab or unique_id is None:
        return None
    with _lock:
        entry = _store.get(_key(tab, unique_id))
        return dict(entry) if entry else None


def carried_entry(tab, unique_id, sent_token):
    """The stored entry if the frontend hadn't taken it in when this prompt was
    queued (its token differs from the one sent), else None."""
    entry = get_entry(tab, unique_id)
    if entry and entry["token"] != (sent_token or ""):
        return entry
    return None


def push_update(unique_id, text, tab="", token=""):
    """Tell the frontend about new text for a node. Only the node in the tab
    named `tab` applies it (older frontends ignore the extra fields)."""
    PromptServer.instance.send_sync(UPDATE_EVENT, {
        "node_id": unique_id,
        "prompt": text,
        "tab": tab or "",
        "token": token or "",
    })


@PromptServer.instance.routes.post("/prompt_stash_saver/latest_input")
async def latest_text(request):
    """Catch-up for a tab that was in the background: return the stored text
    and token for the given node ids in that tab."""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)
    tab = data.get("tab") or ""
    node_ids = data.get("node_ids") or []
    entries = {}
    for node_id in node_ids:
        entry = get_entry(tab, node_id)
        if entry:
            entries[str(node_id)] = entry
    return web.json_response({"entries": entries})
