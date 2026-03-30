# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Bland AI HTTP client.

Handles authenticated requests to the Bland AI API (https://api.bland.ai/v1).
"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

import requests

BLAND_BASE_URL = "https://api.bland.ai/v1"


def make_call(
    api_key: str,
    *,
    phone_number: str,
    task: str,
    voice: str = "June",
    first_sentence: str = "",
    max_duration: int = 5,
    record: bool = True,
    language: str = "en",
    webhook: str = "",
    request_data: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Initiate an outbound phone call via Bland AI.

    Returns {"status": "success", "call_id": "...", "message": "..."} on success.
    """
    payload: Dict[str, Any] = {
        "phone_number": phone_number,
        "task": task,
        "voice": voice,
        "model": "base",
        "language": language,
        "max_duration": max_duration,
        "record": record,
        "wait_for_greeting": True,
        "temperature": 0.7,
    }

    if first_sentence:
        payload["first_sentence"] = first_sentence
    if webhook and webhook.startswith("https://"):
        payload["webhook"] = webhook
    if request_data:
        payload["request_data"] = request_data

    resp = requests.post(
        f"{BLAND_BASE_URL}/calls",
        headers={"authorization": api_key, "Content-Type": "application/json"},
        json=payload,
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def get_call(api_key: str, call_id: str) -> Dict[str, Any]:
    """Get full details for a call including transcript, recording, and analysis."""
    resp = requests.get(
        f"{BLAND_BASE_URL}/calls/{call_id}",
        headers={"authorization": api_key},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def analyze_call(
    api_key: str,
    call_id: str,
    goal: str = "Analyze the phone call",
    questions: Optional[list] = None,
) -> Dict[str, Any]:
    """Run post-call AI analysis on a completed call."""
    if questions is None:
        questions = [
            ["What was the caller's mood?", "string"],
            ["What key information was discussed?", "string"],
            ["Were there any action items?", "string"],
        ]

    resp = requests.post(
        f"{BLAND_BASE_URL}/calls/{call_id}/analyze",
        headers={"authorization": api_key, "Content-Type": "application/json"},
        json={"goal": goal, "questions": questions},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def stop_call(api_key: str, call_id: str) -> Dict[str, Any]:
    """Stop an ongoing call."""
    resp = requests.post(
        f"{BLAND_BASE_URL}/calls/{call_id}/stop",
        headers={"authorization": api_key},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def list_calls(api_key: str, limit: int = 20) -> Dict[str, Any]:
    """List recent calls."""
    resp = requests.get(
        f"{BLAND_BASE_URL}/calls?limit={limit}",
        headers={"authorization": api_key},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()
