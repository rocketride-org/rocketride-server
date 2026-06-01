# Nebius Agentic Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Nebius Agentic Search" capability — a Nebius-hosted LLM that reasons and calls Tavily web search in a loop — by composing the engine's existing agent pattern with two new provider/tool nodes plus a pipeline template.

**Architecture:** Reuse the existing `agent_deepagent` loop. Add a new `tool_tavily_search` node (Tavily web search exposed as an agent tool, cloned from `tool_exa_search`) on the tool channel, and a new `llm_nebius` node (Nebius Token Factory LLM, cloned from `llm_gmi_cloud` with a fixed base URL) on the llm channel. Ship a `.pipe` template wiring them together.

**Tech Stack:** Python pipeline nodes; `requests` (Tavily HTTP), `langchain-openai` (Nebius, OpenAI-compatible). Synchronous. Tests via the RocketRide node test framework (`builder nodes:test` contract tests + `services.json` `test` blocks + `ROCKETRIDE_MOCK`).

**Conventions:**
- Code and comments in English.
- Every new `.py`/`.json` file begins with the standard MIT license header used by sibling nodes — copy it verbatim from `nodes/src/nodes/tool_exa_search/__init__.py` (lines 1–24).
- Branch: `feat/nebius-agentic-search-node` (already created off `develop`).

**Spec:** `docs/superpowers/specs/2026-06-01-nebius-agentic-search-node-design.md`

**Open items to confirm during implementation:**
1. Exact Token Factory model slug for the default (plan assumes `meta-llama/Llama-3.3-70B-Instruct`) and that the deepagent JSON-envelope loop works against it.
2. Tavily API key env var name — plan uses `TAVILY_API_KEY` (mirrors `tool_exa_search` using `EXA_API_KEY`).

---

## Task 1: Scaffold `tool_tavily_search` node (config + lifecycle)

Creates the node skeleton so the engine discovers it. Tool logic is added in Task 2.

**Files:**
- Create: `nodes/src/nodes/tool_tavily_search/__init__.py`
- Create: `nodes/src/nodes/tool_tavily_search/IGlobal.py`
- Create: `nodes/src/nodes/tool_tavily_search/IInstance.py` (stub tool in Task 2)
- Create: `nodes/src/nodes/tool_tavily_search/services.json`
- Create: `nodes/src/nodes/tool_tavily_search/requirements.txt`
- Create: `nodes/src/nodes/tool_tavily_search/tavily.svg`
- Create: `nodes/src/nodes/tool_tavily_search/README.md`

- [ ] **Step 1: Create `__init__.py`**

```python
# <standard MIT header — copy from tool_exa_search/__init__.py lines 1–24>

from .IGlobal import IGlobal
from .IInstance import IInstance

__all__ = ['IGlobal', 'IInstance']
```

- [ ] **Step 2: Create `requirements.txt`**

```
requests
```

- [ ] **Step 3: Create `IGlobal.py`** (clone of `tool_exa_search/IGlobal.py`, Exa→Tavily, env `TAVILY_API_KEY`)

```python
# <standard MIT header>

"""
Tavily Search tool node - global (shared) state.

Reads the Tavily API key and search configuration from the node config.
Tool logic lives on IInstance via @tool_function.
"""

from __future__ import annotations

import os

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, error, warning


class IGlobal(IGlobalBase):
    """Global state for tool_tavily_search."""

    apikey: str = ''
    max_results: int = 5
    search_depth: str = 'advanced'
    topic: str = 'general'

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        apikey = str(cfg.get('apikey') or os.environ.get('TAVILY_API_KEY', '')).strip()

        if not apikey:
            error('tool_tavily_search: apikey is required — set it in node config or TAVILY_API_KEY env var')
            raise ValueError('tool_tavily_search: apikey is required')

        self.apikey = apikey
        raw_max = cfg.get('maxResults', 5)
        if raw_max is None:
            raw_max = 5
        self.max_results = max(1, min(20, int(raw_max)))
        self.search_depth = str(cfg.get('searchDepth') or 'advanced').strip()
        self.topic = str(cfg.get('topic') or 'general').strip()

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = str(cfg.get('apikey') or os.environ.get('TAVILY_API_KEY', '')).strip()
            if not apikey:
                warning('apikey is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.apikey = ''
```

- [ ] **Step 4: Create stub `IInstance.py`** (real tool added in Task 2; stub keeps the module importable)

```python
# <standard MIT header>

"""Tavily Search tool node instance. Exposes tavily_search as a @tool_function."""

from __future__ import annotations

from rocketlib import IInstanceBase

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Node instance exposing Tavily web search as an agent tool."""

    IGlobal: IGlobal
```

- [ ] **Step 5: Create `services.json`** (clone of `tool_exa_search/services.json`, Tavily fields)

```json
{
	"title": "Tavily Search",
	"protocol": "tool_tavily_search://",
	"classType": ["tool"],
	"capabilities": ["invoke", "experimental"],
	"register": "filter",
	"node": "python",
	"path": "nodes.tool_tavily_search",
	"prefix": "tavily",
	"icon": "tavily.svg",
	"description": ["Exposes Tavily real-time web search as an agent tool.", "Performs live web searches via the Tavily API and returns structured results with titles, URLs, content snippets, and relevance scores."],
	"tile": [],
	"lanes": {},
	"preconfig": {
		"default": "default",
		"profiles": {
			"default": {
				"title": "Tavily Search",
				"apikey": "",
				"maxResults": 5,
				"searchDepth": "advanced",
				"topic": "general"
			}
		}
	},
	"fields": {
		"tool_tavily_search.apikey": {
			"type": "string",
			"title": "API Key",
			"description": "Tavily API key (from https://tavily.com)",
			"default": "",
			"secure": true,
			"ui": { "ui:widget": "ApiKeyWidget" }
		},
		"tool_tavily_search.maxResults": {
			"type": "integer",
			"title": "Max Results",
			"description": "Maximum number of search results to return (1-20)",
			"default": 5,
			"minimum": 1,
			"maximum": 20
		},
		"tool_tavily_search.searchDepth": {
			"type": "string",
			"title": "Search Depth",
			"description": "Tavily search depth",
			"default": "advanced",
			"enum": [["basic", "Basic"], ["advanced", "Advanced"]]
		},
		"tool_tavily_search.topic": {
			"type": "string",
			"title": "Topic",
			"description": "Search topic category",
			"default": "general",
			"enum": [["general", "General"], ["news", "News"], ["finance", "Finance"]]
		}
	},
	"test": {
		"profiles": ["default"],
		"outputs": [],
		"cases": [
			{ "name": "Config validation with placeholder key", "text": "test query" }
		]
	},
	"shape": [
		{
			"section": "Pipe",
			"title": "Tavily Search",
			"properties": ["type", "tool_tavily_search.apikey", "tool_tavily_search.maxResults", "tool_tavily_search.searchDepth", "tool_tavily_search.topic"]
		}
	]
}
```

- [ ] **Step 6: Create `tavily.svg`** — author a simple single-color placeholder icon (monochrome `#000`; the build auto-tints it). Minimal valid SVG:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
```

- [ ] **Step 7: Create `README.md`** — short usage doc modeled on `nodes/src/nodes/tool_exa_search`'s sibling docs: what the node does, the `TAVILY_API_KEY` env var, config fields, and that it is consumed by agents via the tool invoke channel.

- [ ] **Step 8: Run contract test to verify the node is valid and imports**

Run: `pytest nodes/test/test_contracts.py -k tavily -v`
Expected: PASS (services.json structure valid, `nodes.tool_tavily_search` imports).

- [ ] **Step 9: Commit**

```bash
git add nodes/src/nodes/tool_tavily_search
git commit -m "feat(tool_tavily_search): scaffold Tavily web-search tool node"
```

---

## Task 2: Implement the `tavily_search` tool (HTTP + retry + SSRF)

**Files:**
- Modify: `nodes/src/nodes/tool_tavily_search/IInstance.py`
- Create: `nodes/test/test_tool_tavily_search.py`

- [ ] **Step 1: Write failing unit tests for the pure helpers**

Create `nodes/test/test_tool_tavily_search.py`:

```python
# <standard MIT header>

"""Unit tests for tool_tavily_search pure helpers (no network)."""

import importlib

mod = importlib.import_module('nodes.tool_tavily_search.IInstance')


def test_shape_results_maps_tavily_fields():
    body = {
        'results': [
            {'title': 'T', 'url': 'https://example.com', 'content': 'snippet', 'score': 0.9}
        ]
    }
    shaped = mod._shape_results('q', body)
    assert shaped['success'] is True
    assert shaped['query'] == 'q'
    assert shaped['num_results'] == 1
    assert shaped['results'][0]['url'] == 'https://example.com'
    assert shaped['results'][0]['score'] == 0.9


def test_validate_public_url_rejects_loopback():
    import pytest
    with pytest.raises(ValueError):
        mod._validate_public_url('http://127.0.0.1/secret')


def test_validate_public_url_allows_public_https():
    assert mod._validate_public_url('https://example.com/page') == 'https://example.com/page'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest nodes/test/test_tool_tavily_search.py -v`
Expected: FAIL (`_shape_results` / `_validate_public_url` not defined).

- [ ] **Step 3: Implement the full `IInstance.py`** (tool + helpers; HTTP/retry cloned from `tool_exa_search/IInstance.py:210-257`, SSRF from `search_exa/exa_search.py:146-168`)

```python
# <standard MIT header>

"""
Tavily Search tool node instance.

Exposes ``tavily_search`` as a @tool_function for real-time web search via the Tavily API.
"""

from __future__ import annotations

import ipaddress
import socket
import time
from typing import Any, Dict
from urllib.parse import urlparse

import requests

from rocketlib import IInstanceBase, tool_function, debug

from ai.common.utils import normalize_tool_input

from .IGlobal import IGlobal

TAVILY_SEARCH_URL = 'https://api.tavily.com/search'
VALID_SEARCH_DEPTHS = {'basic', 'advanced'}
VALID_TOPICS = {'general', 'news', 'finance'}


class IInstance(IInstanceBase):
    """Node instance exposing Tavily web search as an agent tool."""

    IGlobal: IGlobal

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['query'],
            'properties': {
                'query': {'type': 'string', 'description': 'The search query — a natural language question or keyword phrase.'},
                'max_results': {'type': 'integer', 'description': 'Number of results to return (1-20). Defaults to the node config value.'},
                'search_depth': {'type': 'string', 'enum': sorted(VALID_SEARCH_DEPTHS), 'description': '"basic" (fast) or "advanced" (deeper). Defaults to node config.'},
                'topic': {'type': 'string', 'enum': sorted(VALID_TOPICS), 'description': 'Search category: "general", "news", or "finance".'},
                'time_range': {'type': 'string', 'enum': ['day', 'week', 'month', 'year'], 'description': 'Restrict results to a recent time window.'},
                'include_domains': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Only return results from these domains.'},
                'exclude_domains': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Exclude results from these domains.'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'query': {'type': 'string'},
                'num_results': {'type': 'integer'},
                'results': {'type': 'array', 'items': {'type': 'object'}},
                'error': {'type': 'string'},
            },
        },
        description='Search the web in real time using Tavily. Provide a natural language query to find relevant, current web pages. Returns structured results with title, URL, content snippet, and relevance score.',
    )
    def tavily_search(self, args):
        """Search the web using the Tavily API."""
        args = normalize_tool_input(args, tool_name='tavily_search')

        query = (args.get('query') or '').strip()
        if not query:
            return {'success': False, 'query': '', 'num_results': 0, 'results': [], 'error': 'query is required and must be a non-empty string'}

        cfg = self.IGlobal

        max_results = args.get('max_results', cfg.max_results)
        if isinstance(max_results, bool) or not isinstance(max_results, int):
            max_results = cfg.max_results
        search_depth = args.get('search_depth', cfg.search_depth)
        if search_depth not in VALID_SEARCH_DEPTHS:
            search_depth = cfg.search_depth
        topic = args.get('topic', cfg.topic)
        if topic not in VALID_TOPICS:
            topic = cfg.topic

        payload: Dict[str, Any] = {
            'query': query,
            'max_results': max(1, min(20, max_results)),
            'search_depth': search_depth,
            'topic': topic,
        }
        time_range = args.get('time_range')
        if time_range:
            payload['time_range'] = str(time_range)
        include_domains = args.get('include_domains')
        if include_domains and isinstance(include_domains, list):
            payload['include_domains'] = include_domains
        exclude_domains = args.get('exclude_domains')
        if exclude_domains and isinstance(exclude_domains, list):
            payload['exclude_domains'] = exclude_domains

        headers = {
            'accept': 'application/json',
            'content-type': 'application/json',
            'authorization': f'Bearer {cfg.apikey}',
        }

        try:
            body = _request_with_retry(url=TAVILY_SEARCH_URL, headers=headers, payload=payload)
        except RuntimeError as exc:
            return {'success': False, 'query': query, 'num_results': 0, 'results': [], 'error': str(exc)}

        return _shape_results(query, body)


def _shape_results(query: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Map a Tavily response body into the tool's output schema, dropping unsafe URLs."""
    results = []
    for item in body.get('results', []) or []:
        url = item.get('url', '')
        try:
            url = _validate_public_url(url) if url else ''
        except ValueError:
            continue
        results.append({
            'title': item.get('title', ''),
            'url': url,
            'content': item.get('content', ''),
            'score': item.get('score'),
            'published_date': item.get('published_date'),
        })
    return {'success': True, 'query': query, 'num_results': len(results), 'results': results}


def _validate_public_url(raw_url: str) -> str:
    """Reject private/loopback/reserved hosts to prevent SSRF (clone of search_exa)."""
    parsed = urlparse(raw_url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        raise ValueError(f'Tavily returned an invalid URL: {raw_url}')
    try:
        addrinfo = socket.getaddrinfo(parsed.hostname, None, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise ValueError(f'Tavily returned an unresolved URL host: {parsed.hostname}') from e
    for _, _, _, _, sockaddr in addrinfo:
        ip = ipaddress.ip_address(sockaddr[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise ValueError(f'Tavily returned a blocked URL host: {parsed.hostname}')
    return raw_url


def _request_with_retry(*, url: str, headers: Dict[str, str], payload: Dict[str, Any], max_retries: int = 3, base_delay: float = 2.0) -> Dict[str, Any]:
    """POST to the Tavily API with exponential-backoff retry on 429/5xx (clone of tool_exa_search)."""
    for attempt in range(max_retries + 1):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=30)
            if resp.status_code == 429 or 500 <= resp.status_code < 600:
                if attempt < max_retries:
                    delay = base_delay * (2 ** attempt)
                    debug(f'Tavily transient error ({resp.status_code}), retrying in {delay}s ({attempt + 1}/{max_retries})')
                    time.sleep(delay)
                    continue
                resp.raise_for_status()
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.Timeout:
            if attempt < max_retries:
                time.sleep(base_delay * (2 ** attempt))
                continue
            raise RuntimeError('Tavily search: request timed out after all retries') from None
        except requests.RequestException as exc:
            status = getattr(getattr(exc, 'response', None), 'status_code', None)
            detail = f' (HTTP {status})' if status else ''
            raise RuntimeError(f'Tavily search request failed{detail}: {type(exc).__name__}') from None
    raise RuntimeError('Tavily search: max retries exceeded')
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `pytest nodes/test/test_tool_tavily_search.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the contract test again**

Run: `pytest nodes/test/test_contracts.py -k tavily -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add nodes/src/nodes/tool_tavily_search/IInstance.py nodes/test/test_tool_tavily_search.py
git commit -m "feat(tool_tavily_search): implement Tavily search tool with retry + SSRF guard"
```

---

## Task 3: Scaffold `llm_nebius` node (Nebius Token Factory LLM)

Clone of `llm_gmi_cloud`, simplified to a fixed Token Factory base URL.

**Files:**
- Create: `nodes/src/nodes/llm_nebius/__init__.py`
- Create: `nodes/src/nodes/llm_nebius/IInstance.py`
- Create: `nodes/src/nodes/llm_nebius/nebius.py`
- Create: `nodes/src/nodes/llm_nebius/IGlobal.py`
- Create: `nodes/src/nodes/llm_nebius/services.json`
- Create: `nodes/src/nodes/llm_nebius/requirements.txt`
- Create: `nodes/src/nodes/llm_nebius/nebius.svg`
- Create: `nodes/src/nodes/llm_nebius/README.md`

- [ ] **Step 1: Create `requirements.txt`**

```
langchain-openai
openai
```

- [ ] **Step 2: Create `IInstance.py`** (identical to `llm_gmi_cloud/IInstance.py`)

```python
# <standard MIT header>

from ai.common.llm_base import LLMBase


class IInstance(LLMBase):
    pass
```

- [ ] **Step 3: Create `__init__.py`** (exports `getChat`, like `llm_gmi_cloud/__init__.py`)

```python
# <standard MIT header>

from .IGlobal import IGlobal
from .IInstance import IInstance


def getChat():
    """Get the Chat class from the module."""
    from .nebius import Chat

    return Chat


__all__ = ['IGlobal', 'IInstance', 'getChat']
```

- [ ] **Step 4: Create `nebius.py`** (clone of `llm_gmi_cloud/gmi_cloud.py`, fixed Token Factory base URL)

```python
# <standard MIT header>

"""Nebius Token Factory binding for the ChatLLM (OpenAI-compatible)."""

from typing import Any, Dict
from openai import AuthenticationError, APIError, RateLimitError, APIConnectionError
from ai.common.chat import ChatBase
from ai.common.config import Config
from langchain_openai import ChatOpenAI

NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1/'


class Chat(ChatBase):
    """Creates a Nebius Token Factory chat bot."""

    _llm: ChatOpenAI

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        super().__init__(provider, connConfig, bag)

        config = Config.getNodeConfig(provider, connConfig)

        # Dummy placeholder so the client initialises before a key is saved.
        apikey = config.get('apikey') or 'sk-dummy'

        self._llm = ChatOpenAI(
            model=self._model,
            base_url=NEBIUS_BASE_URL,
            api_key=apikey,
            temperature=0,
            max_tokens=self._modelOutputTokens,
        )

        bag['chat'] = self

    def is_retryable_error(self, error):
        return isinstance(error, (RateLimitError, APIConnectionError))

    def map_exception(self, error):
        if isinstance(error, AuthenticationError):
            return ValueError('Invalid Nebius API key.')
        elif isinstance(error, RateLimitError):
            return ValueError(f'Nebius rate limit: {error}')
        elif isinstance(error, APIConnectionError):
            return ValueError('Failed to connect to the Nebius Token Factory API.')
        elif isinstance(error, APIError):
            return ValueError(f'Nebius API error: {error}')
        else:
            return super().map_exception(error)
```

- [ ] **Step 5: Create `IGlobal.py`** (simplified clone of `llm_gmi_cloud/IGlobal.py`; base URL is fixed, so no serverbase/SSRF handling)

```python
# <standard MIT header>

import os
from typing import Optional
from rocketlib import IGlobalBase, warning
from ai.common.config import Config
from ai.common.chat import ChatBase


class IGlobal(IGlobalBase):
    """Global handler for the Nebius Token Factory LLM node."""

    _chat: Optional[ChatBase] = None

    _VALIDATION_PROMPT = 'Hi'
    _BASE_URL = 'https://api.tokenfactory.nebius.com/v1/'

    def _resolve_apikey(self, config) -> str:
        return str(config.get('apikey') or os.environ.get('NEBIUS_API_KEY', '')).strip()

    def validateConfig(self):
        """Probe the model with a 1-token request to validate key + model at save time."""
        from depends import depends  # type: ignore

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        try:
            from openai import OpenAI, APIStatusError, OpenAIError, AuthenticationError, RateLimitError, APIConnectionError

            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = self._resolve_apikey(config)
            model = config.get('model')
            if not model or not apikey:
                return
            try:
                client = OpenAI(api_key=apikey, base_url=self._BASE_URL)
                client.chat.completions.create(
                    model=model,
                    messages=[{'role': 'user', 'content': self._VALIDATION_PROMPT}],
                    max_tokens=1,
                )
            except RateLimitError:
                return
            except APIStatusError as e:
                status = getattr(e, 'status_code', None) or getattr(e, 'status', None)
                if status == 429:
                    return
                warning(f'Nebius validation error {status}: {e}')
                return
            except (AuthenticationError, APIConnectionError, OpenAIError) as e:
                warning(str(e))
                return
        except Exception as e:
            warning(str(e))

    def beginGlobal(self):
        """Initialize the Nebius chat client."""
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        from .nebius import Chat

        bag = self.IEndpoint.endpoint.bag
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        if not self._resolve_apikey(config):
            raise ValueError('Nebius API key is required.')
        self._chat = Chat(self.glb.logicalType, config, bag)

    def endGlobal(self):
        self._chat = None
```

- [ ] **Step 6: Create `services.json`** (curated Token Factory profiles; default = Llama 3.3 70B)

```json
{
	"title": "Nebius",
	"protocol": "llm_nebius://",
	"classType": ["llm"],
	"capabilities": ["invoke"],
	"register": "filter",
	"node": "python",
	"path": "nodes.llm_nebius",
	"prefix": "llm",
	"icon": "nebius.svg",
	"documentation": "https://docs.rocketride.org",
	"description": ["Connects to Nebius Token Factory's OpenAI-compatible inference API.", "Hosts open models (Llama, Qwen, DeepSeek) for reasoning, generation, and tool-calling. Used as an `llm` invoke connection by agents, including Nebius Agentic Search."],
	"tile": ["Model: ${parameters.llm_nebius.profile}"],
	"lanes": { "questions": ["answers"] },
	"preconfig": {
		"default": "llama-3-3-70b",
		"profiles": {
			"llama-3-3-70b": {
				"title": "Llama 3.3 70B Instruct",
				"model": "meta-llama/Llama-3.3-70B-Instruct",
				"apikey": "",
				"modelTotalTokens": 131072
			},
			"qwen3-235b": {
				"title": "Qwen3 235B",
				"model": "Qwen/Qwen3-235B-A22B",
				"apikey": "",
				"modelTotalTokens": 131072
			},
			"deepseek-v3": {
				"title": "DeepSeek V3",
				"model": "deepseek-ai/DeepSeek-V3",
				"apikey": "",
				"modelTotalTokens": 131072
			},
			"custom": {
				"model": "",
				"apikey": "",
				"modelTotalTokens": 131072
			}
		}
	},
	"fields": {
		"model": {
			"type": "string",
			"title": "Model",
			"description": "Nebius Token Factory model id (e.g. meta-llama/Llama-3.3-70B-Instruct). Full list: https://tokenfactory.nebius.com/models"
		},
		"modelTotalTokens": { "type": "number", "title": "Tokens", "description": "Total Tokens" },
		"llm_nebius.llama-3-3-70b": { "object": "llama-3-3-70b", "properties": ["llm.cloud.apikey"] },
		"llm_nebius.qwen3-235b": { "object": "qwen3-235b", "properties": ["llm.cloud.apikey"] },
		"llm_nebius.deepseek-v3": { "object": "deepseek-v3", "properties": ["llm.cloud.apikey"] },
		"llm_nebius.custom": { "object": "custom", "properties": ["model", "modelTotalTokens", "llm.cloud.apikey"] },
		"llm_nebius.profile": {
			"title": "Model",
			"description": "Nebius Token Factory model",
			"type": "string",
			"default": "llama-3-3-70b",
			"enum": ["*>preconfig.profiles.*.title"],
			"conditional": [
				{ "value": "llama-3-3-70b", "properties": ["llm_nebius.llama-3-3-70b"] },
				{ "value": "qwen3-235b", "properties": ["llm_nebius.qwen3-235b"] },
				{ "value": "deepseek-v3", "properties": ["llm_nebius.deepseek-v3"] },
				{ "value": "custom", "properties": ["llm_nebius.custom"] }
			]
		}
	},
	"shape": [
		{ "section": "Pipe", "title": "Nebius", "properties": ["llm_nebius.profile"] }
	],
	"test": {
		"profiles": ["llama-3-3-70b"],
		"outputs": ["answers"],
		"cases": [
			{ "name": "LLM returns mock response", "text": "What is 2+2?", "expect": { "answers": { "contains": "Mock LLM response" } } }
		]
	}
}
```

- [ ] **Step 7: Create `nebius.svg`** — monochrome placeholder icon (`#000`), same approach as Step 6 of Task 1.

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#000"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>
```

- [ ] **Step 8: Create `README.md`** — short doc modeled on `llm_gmi_cloud`'s description: Token Factory base URL, `NEBIUS_API_KEY` env var, model profiles, and that it is used as an `llm` channel for agents (Nebius Agentic Search).

- [ ] **Step 9: Run contract test**

Run: `pytest nodes/test/test_contracts.py -k nebius -v`
Expected: PASS (services.json valid, `nodes.llm_nebius` imports, `getChat` present).

- [ ] **Step 10: Commit**

```bash
git add nodes/src/nodes/llm_nebius
git commit -m "feat(llm_nebius): add Nebius Token Factory LLM provider node"
```

---

## Task 4: Verify `llm_nebius` integration test (mock-backed)

The `services.json` `test` block added in Task 3 uses the existing `langchain_openai` mock (`nodes/test/mocks/langchain_openai`) which returns "Mock LLM response" — same path as `llm_gmi_cloud`.

- [ ] **Step 1: Run the full node test for `llm_nebius` under mock**

Run: `builder nodes:test-full --pattern="llm_nebius"`
Expected: PASS — the `llama-3-3-70b` profile returns an answer containing "Mock LLM response".

- [ ] **Step 2: If the mock does not auto-apply** (the node uses `ChatOpenAI` exactly like `llm_gmi_cloud`, so it should), confirm no new mock is needed by diffing the import surface against `llm_gmi_cloud`. No code change expected.

- [ ] **Step 3: Commit (only if any adjustment was required)**

```bash
git add -A && git commit -m "test(llm_nebius): confirm mock-backed integration test passes"
```

---

## Task 5: Pipeline template "Nebius Agentic Search"

Wire the two new nodes into the existing `agent_deepagent` and ship a `.pipe` example.

**Files:**
- Create: `examples/nebius-agentic-search.pipe`
- (Optional) Modify: `packages/shared-ui/src/components/canvas/templates/templates.json`

**Reference:** `pipelines/git_agent_example.pipe` — the same chat→agent←llm+tool wiring (it uses `agent_langchain` + `llm_gemini` + `tool_git`). Mirror its `components[]` + `input[]` lane/channel structure.

- [ ] **Step 1: Author `examples/nebius-agentic-search.pipe`** with four components:
  - `chat` trigger (Source) — copy the `chat_1` component from `git_agent_example.pipe`.
  - `agent_deepagent` — name "Nebius Agentic Search"; `config.instructions`: "You are an agentic web-research assistant. Use the tavily_search tool to find current information, refine queries when results are weak, cite sources, and answer concisely."; receives the chat trigger on the `questions` lane.
  - `llm_nebius` — connected to the agent's `llm` invoke channel (default profile `llama-3-3-70b`).
  - `tool_tavily_search` — connected to the agent's `tool` invoke channel.

  Match `git_agent_example.pipe`'s JSON shape exactly (component `id`/`provider`/`config`/`ui.position`, and `input[]` entries declaring the lane/channel connections). Easiest reliable path: open the canvas, drag these four nodes, wire chat→questions→agent, llm_nebius→agent (llm channel), tool_tavily_search→agent (tool channel), then **Export** the pipeline and save the exported JSON to `examples/nebius-agentic-search.pipe`.

- [ ] **Step 2: Validate the template imports**

Import `examples/nebius-agentic-search.pipe` into the canvas (or run any existing pipeline-import validation in `packages/server/test/pipelines`). Expected: loads with all four nodes wired, no validation errors.

- [ ] **Step 3: (Optional) Register the template** in `packages/shared-ui/src/components/canvas/templates/templates.json` so it appears as a one-click "Nebius Agentic Search" card. Follow the existing entries' shape in that file.

- [ ] **Step 4: Commit**

```bash
git add examples/nebius-agentic-search.pipe packages/shared-ui/src/components/canvas/templates/templates.json
git commit -m "feat(examples): add Nebius Agentic Search pipeline template"
```

---

## Task 6: Docs + final verification

**Files:**
- Modify: `docs/README-nodes.md`

- [ ] **Step 1: Add the two nodes to `docs/README-nodes.md`** — add `tool_tavily_search` near the AI/search section and `llm_nebius` to the "LLM Providers" table, each with a one-line description.

- [ ] **Step 2: Run the full contract test suite**

Run: `builder nodes:test`
Expected: PASS for all nodes (including the two new ones).

- [ ] **Step 3: Run the focused integration tests**

Run: `builder nodes:test-full --pattern="tavily" && builder nodes:test-full --pattern="llm_nebius"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/README-nodes.md
git commit -m "docs(nodes): document tool_tavily_search and llm_nebius"
```

---

## Verification checklist (whole feature)

- [ ] `pytest nodes/test/test_contracts.py -k "tavily or nebius" -v` passes.
- [ ] `pytest nodes/test/test_tool_tavily_search.py -v` passes.
- [ ] `builder nodes:test-full --pattern="llm_nebius"` returns "Mock LLM response".
- [ ] The `.pipe` template imports cleanly with all four nodes wired.
- [ ] With real `NEBIUS_API_KEY` + `TAVILY_API_KEY`, a question to the template produces a cited answer and at least one Tavily call (manual smoke test).
