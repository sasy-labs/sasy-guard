"""A deterministic mock Anthropic ``/v1/messages`` endpoint.

Speaks just enough of the streaming Messages SSE protocol for a real
``claude`` (Claude Code) session to drive it. It is **scripted**: each turn
replays a fixed list of tool calls (real Claude refuses the dangerous ones
on its own, so a mock is the only way to make the demo deterministic).

The endpoint advances its script by counting ``role:"assistant"`` messages
in the incoming request — Claude Code resends the full message history on
every ``/v1/messages`` call within a turn, so the count tells us which step
to emit next. Once the script is exhausted (including after a tool the hook
blocked), it emits a final ``end_turn`` text and the turn ends.
"""

from __future__ import annotations

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import TYPE_CHECKING, Any

from demo.cc_guard.util import free_port

# A real model takes seconds to answer; this mock answers in <1 ms, which races
# the daemon's transcript tailer — the next tool's PreToolUse check can fire
# before the *previous* tool's result has been ingested into the session graph,
# so context-dependent rules (taint, gitleaks-clean, hidden-unicode) miss it.
# Pace each reply to let the tailer catch up, the way a real model naturally
# would. Override with SASY_DEMO_MOCK_DELAY_MS.
_REPLY_DELAY_S = int(os.environ.get("SASY_DEMO_MOCK_DELAY_MS", "1500")) / 1000.0

if TYPE_CHECKING:
    from demo.cc_guard.scenarios import Step


def _sse(event: str, data: dict[str, Any]) -> bytes:
    """Encode one Server-Sent Event in Anthropic's wire format."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


def _tool_use_events(index: int, step: Step) -> list[bytes]:
    """SSE events for an assistant turn that emits one ``tool_use`` block."""
    tool_id = f"toolu_mock_{index}"
    return [
        _sse("message_start", {
            "type": "message_start",
            "message": {
                "id": f"msg_mock_{index}", "type": "message",
                "role": "assistant", "model": "claude-mock",
                "content": [], "stop_reason": None, "stop_sequence": None,
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
        }),
        _sse("content_block_start", {
            "type": "content_block_start", "index": 0,
            "content_block": {
                "type": "tool_use", "id": tool_id,
                "name": step.tool, "input": {},
            },
        }),
        _sse("content_block_delta", {
            "type": "content_block_delta", "index": 0,
            "delta": {
                "type": "input_json_delta",
                "partial_json": json.dumps(step.input),
            },
        }),
        _sse("content_block_stop", {"type": "content_block_stop", "index": 0}),
        _sse("message_delta", {
            "type": "message_delta",
            "delta": {"stop_reason": "tool_use", "stop_sequence": None},
            "usage": {"output_tokens": 1},
        }),
        _sse("message_stop", {"type": "message_stop"}),
    ]


def _end_turn_events(text: str) -> list[bytes]:
    """SSE events for a final assistant turn that emits a short text block."""
    return [
        _sse("message_start", {
            "type": "message_start",
            "message": {
                "id": "msg_mock_done", "type": "message",
                "role": "assistant", "model": "claude-mock",
                "content": [], "stop_reason": None, "stop_sequence": None,
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
        }),
        _sse("content_block_start", {
            "type": "content_block_start", "index": 0,
            "content_block": {"type": "text", "text": ""},
        }),
        _sse("content_block_delta", {
            "type": "content_block_delta", "index": 0,
            "delta": {"type": "text_delta", "text": text},
        }),
        _sse("content_block_stop", {"type": "content_block_stop", "index": 0}),
        _sse("message_delta", {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": 1},
        }),
        _sse("message_stop", {"type": "message_stop"}),
    ]


class _Handler(BaseHTTPRequestHandler):
    """Serves ``POST /v1/messages`` from the owning server's script."""

    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        """Silence the default per-request stderr logging."""
        return

    def _emit(self, events: list[bytes]) -> None:
        body = b"".join(events)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        mock: MockAnthropic = self.server.mock  # type: ignore[attr-defined]
        mock.hits.append(("GET", self.path))
        self.send_error(404, "not found")

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        mock: MockAnthropic = self.server.mock  # type: ignore[attr-defined]
        mock.hits.append(("POST", self.path))
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        path = self.path.split("?", 1)[0].rstrip("/")
        if path != "/v1/messages":
            self.send_error(404, "not found")
            return
        try:
            req = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self.send_error(400, "bad json")
            return

        mock.requests.append(req)
        messages = req.get("messages", [])
        n_assistant = sum(1 for m in messages if m.get("role") == "assistant")
        script = mock.script
        # Pace the reply like a real model so the daemon's transcript tailer has
        # ingested the previous tool's result into the session graph before the
        # next tool's PreToolUse check fires (see _REPLY_DELAY_S).
        time.sleep(_REPLY_DELAY_S)
        if n_assistant < len(script):
            self._emit(_tool_use_events(n_assistant, script[n_assistant]))
        else:
            self._emit(_end_turn_events("Done."))


class MockAnthropic:
    """A scripted, deterministic mock of the Anthropic Messages API.

    Bind a script with :meth:`set_script`, point a ``claude`` session at
    :attr:`base_url` (via ``ANTHROPIC_BASE_URL``), and each assistant turn
    replays the next scripted tool call.
    """

    def __init__(self) -> None:
        self.port = free_port()
        self.script: list[Step] = []
        self.requests: list[dict[str, Any]] = []
        self.hits: list[tuple[str, str]] = []
        self._server = ThreadingHTTPServer(("127.0.0.1", self.port), _Handler)
        self._server.mock = self  # type: ignore[attr-defined]
        self._thread = threading.Thread(
            target=self._server.serve_forever, daemon=True
        )

    @property
    def base_url(self) -> str:
        """The ``ANTHROPIC_BASE_URL`` to point ``claude`` at."""
        return f"http://127.0.0.1:{self.port}"

    def set_script(self, steps: list[Step]) -> None:
        """Install the tool-call script for the next turn and reset logs."""
        self.script = list(steps)
        self.requests = []
        self.hits = []

    def start(self) -> None:
        """Start serving in a background thread."""
        self._thread.start()

    def stop(self) -> None:
        """Stop serving and release the port."""
        self._server.shutdown()
        self._server.server_close()
