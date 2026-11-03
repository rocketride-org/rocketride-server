"""Collect one eval run's verdict, timing, and token use into result.json.

Called by evals/run: collect.py OUT CASE AGENT MODEL NO_SKILL RUN_ID EXIT_CODE SECONDS
"""

import json
import re
import sys
from pathlib import Path


def last_json_block(text: str):
    blocks = re.findall(r'```json\s*(\{.*?\})\s*```', text, re.S)
    for block in reversed(blocks):
        try:
            return json.loads(block)
        except json.JSONDecodeError:
            continue
    return None


def claude_usage(out: Path) -> dict:
    try:
        data = json.loads((out / 'agent.json').read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    usage = data.get('usage') or {}
    return {
        'turns': data.get('num_turns'),
        'input_tokens': (usage.get('input_tokens') or 0)
        + (usage.get('cache_read_input_tokens') or 0)
        + (usage.get('cache_creation_input_tokens') or 0),
        'output_tokens': usage.get('output_tokens'),
        'cost_usd_if_billed': data.get('total_cost_usd'),
    }


def codex_usage(out: Path) -> dict:
    totals = {'input_tokens': 0, 'output_tokens': 0, 'turns': 0}
    try:
        lines = (out / 'agent.jsonl').read_text().splitlines()
    except OSError:
        return {}
    for line in lines:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get('type') == 'turn.completed':
            usage = event.get('usage') or {}
            totals['input_tokens'] += usage.get('input_tokens') or 0
            totals['output_tokens'] += usage.get('output_tokens') or 0
            totals['turns'] += 1
        elif event.get('type') == 'item.completed' and (event.get('item') or {}).get('type') == 'command_execution':
            totals['commands'] = totals.get('commands', 0) + 1
    return totals


def main() -> None:
    out, case, agent, model, no_skill, run_id, code, seconds = sys.argv[1:9]
    out = Path(out)
    final = (out / 'final.md').read_text() if (out / 'final.md').exists() else ''
    verdict = last_json_block(final)
    result = {
        'case': case,
        'agent': agent,
        'model': model,
        'skill': no_skill != '1',
        'run_id': run_id,
        'exit_code': int(code),
        'seconds': int(seconds),
        'verdict': verdict,
        'usage': claude_usage(out) if agent == 'claude' else codex_usage(out),
    }
    (out / 'result.json').write_text(json.dumps(result, indent=2))
    found = None if verdict is None else verdict.get('defect_found')
    print(f'{case} {agent}{"" if result["skill"] else " (no skill)"}: defect_found={found} in {seconds}s -> {out}')


if __name__ == '__main__':
    main()
