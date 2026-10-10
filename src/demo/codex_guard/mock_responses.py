"""A scripted stand-in for the OpenAI Responses API, for a real Codex CLI session.

Codex sends the whole conversation with every request. The mock counts the
prompts the user typed to pick the scripted turn, and the tool results since
the last prompt to pick the call within it; once a turn's calls are done it
answers with a short message. So a resumed session continues with the next
scripted turn.
"""

from __future__ import annotations

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# Paced like a real model, so the daemon has read the previous result before
# the next call's check.
_REPLY_DELAY_S = int(os.environ.get("SASY_DEMO_MOCK_DELAY_MS", "800")) / 1000.0

_OUTPUT_TYPES = ("function_call_output", "custom_tool_call_output")


def _sse(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


def _is_prompt(item: Any) -> bool:
    """A message the user typed (not Codex's own instructions or context)."""
    if not isinstance(item, dict) or item.get("role") != "user":
        return False
    parts = item.get("content") or []
    text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
    return not text.lstrip().startswith("<")


def position(items: list[Any]) -> tuple[int, int]:
    """The scripted turn and step a request is at.

    Args:
        items: The request's ``input`` list.

    Returns:
        ``(turn, step)``: the prompts typed so far minus one, and the tool
        results since the last prompt.
    """
    turn = -1
    step = 0
    for item in items:
        if _is_prompt(item):
            turn += 1
            step = 0
        elif isinstance(item, dict) and item.get("type") in _OUTPUT_TYPES:
            step += 1
    return max(turn, 0), step


def _reply(item: dict[str, Any], n: int) -> bytes:
    resp = {
        "id": f"resp_{n}",
        "object": "response",
        "status": "completed",
        "output": [item],
        "usage": {
            "input_tokens": 1,
            "output_tokens": 1,
            "total_tokens": 2,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens_details": {"reasoning_tokens": 0},
        },
    }
    started = {**resp, "status": "in_progress", "output": []}
    return b"".join([
        _sse("response.created", {"type": "response.created", "response": started}),
        _sse("response.output_item.added",
             {"type": "response.output_item.added", "output_index": 0, "item": item}),
        _sse("response.output_item.done",
             {"type": "response.output_item.done", "output_index": 0, "item": item}),
        _sse("response.completed", {"type": "response.completed", "response": resp}),
    ])


class _Handler(BaseHTTPRequestHandler):
    """Serves ``POST /v1/responses`` from the owning mock's script."""

    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        """Silence the default per-request logging."""
        return

    def _send(self, body: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        """Answers Codex's model listing with the one scripted model."""
        models = {"data": [{"id": "sasy-mock", "object": "model"}], "models": []}
        self._send(json.dumps(models).encode(), "application/json")

    def do_POST(self) -> None:
        """Answers one model request with the next scripted call or a message."""
        mock: MockResponses = self.server.mock  # type: ignore[attr-defined]
        length = int(self.headers.get("Content-Length", 0))
        try:
            req = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self.send_error(400, "bad json")
            return
        if self.path.split("?", 1)[0].rstrip("/") != "/v1/responses":
            self.send_error(404, "not found")
            return
        turn, step = position(req.get("input") or [])
        mock.requests += 1
        time.sleep(_REPLY_DELAY_S)
        calls = mock.turns[turn] if turn < len(mock.turns) else []
        if step < len(calls):
            name, args = calls[step]
            item = {
                "type": "function_call",
                "id": f"fc_{turn}_{step}",
                "call_id": f"call_{turn}_{step}",
                "name": name,
                "arguments": json.dumps(args),
                "status": "completed",
            }
        else:
            item = {
                "type": "message",
                "id": f"msg_{mock.requests}",
                "role": "assistant",
                "status": "completed",
                "content": [
                    {"type": "output_text", "text": "Done.", "annotations": []}
                ],
            }
        self._send(_reply(item, mock.requests), "text/event-stream")


class MockResponses:
    """A scripted mock of the Responses API that Codex CLI calls.

    Attributes:
        turns: Per prompt, the ``(tool name, arguments)`` calls to make.
        port: The local port it listens on.
        requests: How many model requests it has answered.
    """

    def __init__(self, turns: list[list[tuple[str, dict[str, Any]]]]) -> None:
        """Binds a free local port.

        Args:
            turns: Per prompt, the calls to make, in order.
        """
        self.turns = turns
        self.requests = 0
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.port = self._server.server_address[1]
        self._server.mock = self  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        """The provider ``base_url`` for Codex's config."""
        return f"http://127.0.0.1:{self.port}/v1"

    def start(self) -> None:
        """Starts serving in a background thread."""
        self._thread.start()

    def stop(self) -> None:
        """Stops serving and releases the port."""
        self._server.shutdown()
        self._server.server_close()
