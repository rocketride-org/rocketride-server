# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Generate apps/vector-ui/tests/fixtures/defaults.json from the store nodes' vx_defaults.py.

The write-switch default and the tool limits are defined once, in
``packages/ai/src/ai/common/store/vx_defaults.py``. The app's tests read them
from the generated ``tests/fixtures/defaults.json``, so a changed default is one
edit there plus a rerun of this script.

Usage (any Python 3.10+, no engine needed):

    python3 apps/vector-ui/scripts/gen_defaults.py          # write the fixture
    python3 apps/vector-ui/scripts/gen_defaults.py --check  # exit 1 when it has drifted
"""

import json
import runpy
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = APP_DIR.parents[1]
SOURCE = REPO_ROOT / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'store' / 'vx_defaults.py'
TARGET = APP_DIR / 'tests' / 'fixtures' / 'defaults.json'

# The names exported to the fixture, in this order.
NAMES = (
    'VECTOR_ALLOW_WRITES_DEFAULT',
    'VECTOR_TOOL_LIMITS',
    'VECTOR_TOOL_DEFAULTS',
    'EMBED_TOOL_LIMITS',
)


def render() -> str:
    """Return the fixture text for the current vx_defaults.py."""
    # vx_defaults.py has no imports, so running it by path needs no engine or package.
    values = runpy.run_path(str(SOURCE))
    missing = [name for name in NAMES if name not in values]
    if missing:
        raise SystemExit(f'{SOURCE.name} does not define {", ".join(missing)}')
    data = {
        '_generated': 'by apps/vector-ui/scripts/gen_defaults.py from packages/ai/src/ai/common/store/vx_defaults.py; do not edit',
        **{name: values[name] for name in NAMES},
    }
    return json.dumps(data, indent='\t') + '\n'


def main() -> int:
    """Write the fixture, or with --check compare it and report drift."""
    text = render()
    if '--check' in sys.argv[1:]:
        current = TARGET.read_text(encoding='utf-8') if TARGET.exists() else ''
        if current != text:
            print(f'{TARGET.relative_to(REPO_ROOT)} is out of date: run {Path(__file__).relative_to(REPO_ROOT)}')
            return 1
        print(f'{TARGET.relative_to(REPO_ROOT)} is up to date')
        return 0
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(text, encoding='utf-8')
    print(f'wrote {TARGET.relative_to(REPO_ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
