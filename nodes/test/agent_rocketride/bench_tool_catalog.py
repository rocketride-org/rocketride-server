# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Measure the Wave planning prompt with every tool schema and with schemas loaded on demand.

Offline and deterministic: the real driver, planner and executor run against a
scripted model (``ScriptedPlanner``) and a host that echoes each call, so every
prompt the driver builds is measured, the planner's retry and the synthesis
fallback included when a scenario reaches them. Per request it reports five
texts: the serialized descriptors, the Available Tools block, the Loaded tool
schemas block, the whole prompt and the part a provider may cache, in
characters, UTF-8 bytes and o200k_base tokens. Tokens need a tokenizer cache
already on disk (``TIKTOKEN_CACHE_DIR``); the bench never downloads one, and
the column reads unavailable without it. JSON repairs an LLM node makes are not
visible here.

Run it with the engine's Python through pytest (test_wave_tool_catalog.py's
``test_measurement_table``), or directly::

    python bench_tool_catalog.py --tools 30 200 --budget 0 --budget 1
"""

import argparse
import json
import socket
import sys
from collections import namedtuple
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple


def synthetic_catalog(
    n: int, *, desc_chars: int = 0, extra_props: int = 0, prefix: str = 'node.catalog'
) -> List[Dict[str, Any]]:
    """Return *n* tool descriptors shaped like a small MCP server's.

    Each tool reads one record by id and takes two arguments. *desc_chars* pads the
    description to that length; *extra_props* adds that many optional enum arguments.
    """
    tools = []
    for i in range(n):
        desc = f'Read item {i:03d} by id.'
        if desc_chars:
            filler = ' It returns the stored record with every field the caller may read, and reports when the id is unknown.'
            desc = (desc + filler * 6)[:desc_chars]
        props: Dict[str, Any] = {
            'id': {'type': 'string', 'description': 'Record id.'},
            'fields': {'type': 'array', 'items': {'type': 'string'}},
        }
        for p in range(extra_props):
            props[f'option_{p}'] = {
                'type': 'string',
                'description': f'Optional setting {p} that changes how the record is read.',
                'enum': ['a', 'b', 'c'],
            }
        tools.append(
            {
                'name': f'{prefix}.lookup_{i:03d}',
                'description': desc,
                'inputSchema': {
                    'type': 'object',
                    'properties': props,
                    'required': ['id'],
                    'additionalProperties': False,
                },
            }
        )
    return tools


def load_catalog(path: str, prefix: str = 'mcp.stub') -> List[Dict[str, Any]]:
    """An MCP ``tools/list`` result (or its ``tools`` list) as namespaced descriptors."""
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    tools = data.get('tools', data.get('result', {}).get('tools')) if isinstance(data, dict) else data
    return [{**td, 'name': f'{prefix}.{td["name"]}'} for td in tools or [] if isinstance(td, dict) and td.get('name')]


TOKENIZER_UNAVAILABLE = 'tokenizer unavailable (no pre-seeded cache)'
_ENCODING: List[Any] = []


def count_tokens(text: str) -> Optional[int]:
    """o200k_base tokens of *text*, or None when no tokenizer cache is on disk. Never downloads."""
    import os

    if not os.environ.get('TIKTOKEN_CACHE_DIR'):
        return None
    if not _ENCODING:
        real_getaddrinfo, real_connect = socket.getaddrinfo, socket.create_connection

        def offline(*args, **kwargs):
            raise OSError('network disabled for measurement')

        socket.getaddrinfo, socket.create_connection = offline, offline
        try:
            import tiktoken

            _ENCODING.append(tiktoken.get_encoding('o200k_base'))
        except Exception:
            _ENCODING.append(None)
        finally:
            socket.getaddrinfo, socket.create_connection = real_getaddrinfo, real_connect
    return len(_ENCODING[0].encode(text)) if _ENCODING[0] is not None else None


Sizes = namedtuple('Sizes', 'chars bytes tokens')


def sizes(text: str) -> Sizes:
    return Sizes(len(text), len(text.encode('utf-8')), count_tokens(text))


def _add(a: Sizes, b: Sizes) -> Sizes:
    tokens = None if a.tokens is None or b.tokens is None else a.tokens + b.tokens
    return Sizes(a.chars + b.chars, a.bytes + b.bytes, tokens)


_ZERO = Sizes(0, 0, 0)


@dataclass
class Measured:
    """One request the driver made."""

    kind: str  # 'plan' | 'plan-retry' | 'synthesis'
    descriptors: Sizes = _ZERO
    tools_block: Sizes = _ZERO
    loaded_block: Sizes = _ZERO
    prompt: Sizes = _ZERO
    prefix: Sizes = _ZERO


@dataclass
class RunReport:
    requests: List[Measured] = field(default_factory=list)
    planning_steps: int = 0
    stop_reason: str = ''
    host_calls: List[Tuple[str, Dict[str, Any]]] = field(default_factory=list)
    answer: str = ''
    loaded_tools: Any = None
    tool_catalog: Dict[str, Any] = field(default_factory=dict)

    def total(self) -> Measured:
        out = Measured('total')
        for r in self.requests:
            for name in ('descriptors', 'tools_block', 'loaded_block', 'prompt', 'prefix'):
                setattr(out, name, _add(getattr(out, name), getattr(r, name)))
        return out


def _full_schemas(prompt: str) -> set:
    """Names whose full descriptor line is in *prompt* (Available Tools or Loaded tool schemas)."""
    names = set()
    for line in prompt.splitlines():
        line = line.strip()
        if line.startswith('{"name": '):
            try:
                names.add(json.loads(line)['name'])
            except (ValueError, KeyError, TypeError):
                pass
    return names


class ScriptedPlanner:
    """A model stand-in that reads each prompt the way a careful model would.

    It loads, with one tools.load, every needed tool whose full schema the prompt
    does not show; then calls every needed tool; then, once each call's result is
    in the prompt, answers. With *unusable_first* its first reply is unusable once,
    so the planner's retry runs.
    """

    def __init__(self, needed: Sequence[Tuple[str, Dict[str, Any]]], answer: str, *, unusable_first: bool = False):
        self.needed = list(needed)
        self.answer = answer
        self.unusable = unusable_first

    def __call__(self, context: Any, question: Any) -> Dict[str, Any]:
        if self.unusable:
            self.unusable = False
            return {'thought': 'thinking'}
        prompt = question.getPrompt()
        if all(f'"tool": "{name}"' in prompt for name, _ in self.needed):
            return {'done': True, 'answer': self.answer}
        missing = [name for name, _ in self.needed if name not in _full_schemas(prompt)]
        if missing:
            return {'tool_calls': [{'tool': 'tools.load', 'args': {'names': missing}}]}
        return {'tool_calls': [{'tool': name, 'args': dict(args)} for name, args in self.needed]}


def _block(prompt: str, start: str, end_markers: Sequence[str]) -> str:
    i = prompt.find(start)
    if i < 0:
        return ''
    j = min([k for k in (prompt.find(m, i + len(start)) for m in end_markers) if k >= 0] or [len(prompt)])
    return prompt[i:j]


def simulate_run(
    wave: Any,
    descriptors: List[Dict[str, Any]],
    budget: int,
    *,
    needed: Sequence[Tuple[str, Dict[str, Any]]],
    answer: str,
    max_waves: int = 10,
    unusable_first: bool = False,
) -> RunReport:
    """Run the real driver once with a scripted model and measure every request it makes."""
    from ai.common.agent.tool_catalog import catalog_text
    from ai.common.chat import ChatBase
    from eager_scenarios import build_context, build_driver, question

    class _Prefix(ChatBase):
        SUPPORTS_PROMPT_CACHE_PREFIX = True

        def __init__(self):
            pass

    prefix_of = _Prefix()._prompt_cache_prefix
    report = RunReport()
    planner = ScriptedPlanner(needed, answer, unusable_first=unusable_first)
    driver = build_driver(wave, budget=budget)
    driver._max_waves = max_waves

    def call_llm_json(context, question):
        prompt = question.getPrompt()
        kind = 'plan-retry' if 'Your previous reply was not usable' in prompt else 'plan'
        report.requests.append(
            Measured(
                kind,
                descriptors=sizes(catalog_text(descriptors)),
                tools_block=sizes(_block(prompt, '**Available Tools**', ['\r\n\r\n'])),
                loaded_block=sizes(_block(prompt, 'Loaded tool schemas (call', ['\r\n\r\n'])),
                prompt=sizes(prompt),
                prefix=sizes(prefix_of(question) or ''),
            )
        )
        return planner(context, question)

    def call_llm(context, question):
        report.requests.append(Measured('synthesis', prompt=sizes(question.getPrompt())))
        return answer + ' (synthesized)'

    def invoke(tool, args):
        report.host_calls.append((tool, dict(args)))
        return {'called': tool, 'args': args}

    driver.call_llm_json = call_llm_json
    driver.call_llm = call_llm
    report.answer, trace = driver._run(context=build_context(wave, descriptors, invoke=invoke), question=question(wave))
    report.planning_steps = trace.get('planning_steps', 0)
    report.stop_reason = trace.get('stop_reason', '')
    report.loaded_tools = trace.get('loaded_tools')
    report.tool_catalog = trace.get('tool_catalog', {})
    return report


def _cell(s: Sizes) -> str:
    tokens = f'{s.tokens:,}' if s.tokens is not None else 'n/a'
    return f'{s.chars:,} / {s.bytes:,} / {tokens}'


def report(rows: Sequence[Tuple[str, int, RunReport]]) -> str:
    """A Markdown table: per catalog and budget, the first step, the second step and the whole run."""
    lines = [
        '| catalog | budget | mode | steps | request | Available Tools | Loaded schemas | prompt | cached prefix |',
        '|---|---:|---|---:|---|---:|---:|---:|---:|',
    ]
    for label, budget, run in rows:
        plans = [r for r in run.requests if r.kind != 'synthesis']
        picks = [('first step', plans[0] if plans else None), ('second step', plans[1] if len(plans) > 1 else None)]
        picks.append(('whole run', run.total()))
        for name, m in picks:
            if m is None:
                continue
            lines.append(
                f'| {label} | {budget:,} | {run.tool_catalog.get("mode", "?")} | {run.planning_steps} | {name} | '
                f'{_cell(m.tools_block)} | {_cell(m.loaded_block)} | {_cell(m.prompt)} | {_cell(m.prefix)} |'
            )
    lines.append('')
    lines.append(
        'Cells are characters / UTF-8 bytes / o200k_base tokens. "n/a" means '
        + TOKENIZER_UNAVAILABLE
        + '. Requests counted: every planning request (retries included) and the synthesis fallback. '
        'A scripted model replies; JSON repairs an LLM node makes are not visible here.'
    )
    return '\n'.join(lines)


def _shape(name: str) -> Dict[str, int]:
    return {
        'probe': {},
        'long': {'desc_chars': 300},
        'big': {'extra_props': 6},
        'both': {'desc_chars': 300, 'extra_props': 6},
    }[name]


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--tools', type=int, nargs='*', default=[30, 200])
    parser.add_argument('--catalog', help='an exported MCP tools/list JSON file')
    parser.add_argument('--budget', type=int, action='append', default=None)
    parser.add_argument('--shape', choices=['probe', 'long', 'big', 'both'], default='probe')
    args = parser.parse_args(argv)
    from _load_wave import load_wave_modules

    wave = load_wave_modules()
    catalogs = [(f'{n} tools ({args.shape})', synthetic_catalog(n, **_shape(args.shape))) for n in args.tools]
    if args.catalog:
        catalogs.append((Path(args.catalog).name, load_catalog(args.catalog)))
    rows = []
    for label, tools in catalogs:
        needed = [(td['name'], {}) for td in tools[:2]]
        for budget in args.budget or [0, 1]:
            rows.append((label, budget, simulate_run(wave, tools, budget, needed=needed, answer='Done.')))
    print(report(rows))
    return 0


if __name__ == '__main__':
    sys.exit(main())
