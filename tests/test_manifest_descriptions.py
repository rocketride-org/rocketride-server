# Copyright 2026 Aparavi Software AG. MIT License.
"""Every plugin and registry manifest opens with the same plain sentence about RocketRide."""

import json
import re
from pathlib import Path

ROOT = Path(__file__).parents[1]
BASE = "Build, check and run RocketRide data and AI pipelines, and read each run's logs and traces."
FILES = ['docs/agents/.claude-plugin/plugin.json', 'docs/agents/.codex-plugin/plugin.json', 'server.json', 'glama.json']
MARKETPLACE = '.claude-plugin/marketplace.json'
PROMOTION = re.compile(r'\b(meta-harness|enterprise-grade|best|leading|only|official|free|trial|discount)\b', re.I)


def read(name):
    return json.loads((ROOT / name).read_text(encoding='utf-8'))


def load():
    docs = {name: read(name) for name in FILES}
    texts = {
        name: [doc['description'], *doc.get('keywords', []), *doc.get('interface', {}).values()]
        for name, doc in docs.items()
    }
    return texts | {MARKETPLACE: [read(MARKETPLACE)['plugins'][0]['description']]}


def problems(texts):
    found = []
    for name, (description, *other) in texts.items():
        if not description.startswith(BASE):
            found.append(f'{name}: the description does not start with the shared sentence')
        found += [f'{name}: uses {word!r}' for word in PROMOTION.findall(' '.join([description, *other]))]
    if len(texts['server.json'][0]) > 100:  # maxLength in the registry schema that server.json names
        found.append('server.json: the description is over 100 characters')
    return found


def test_every_manifest_opens_with_the_shared_sentence():
    assert problems(load()) == []


def test_a_changed_or_promotional_description_fails():
    texts = load() | {'glama.json': ['The best AI meta-harness.'], 'server.json': [BASE + ' x' * 5]}
    assert problems(texts) == [
        'glama.json: the description does not start with the shared sentence',
        "glama.json: uses 'best'",
        "glama.json: uses 'meta-harness'",
        'server.json: the description is over 100 characters',
    ]
