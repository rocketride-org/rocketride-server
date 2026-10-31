"""Run a command, print its output, and save it as evidence.

Usage (through rr-verify, which sets RR_VERIFY_DIR): record.py LABEL [--] COMMAND [ARGS...]

Saves .verify/<run-id>/<LABEL>/<time>-cmd.json with the command, exit code, stdout,
stderr, duration, and whether the engine runs with mocks. Exits with the command's code.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 3:
        print('usage: record.py LABEL [--] COMMAND [ARGS...]', file=sys.stderr)
        return 2
    label, command = sys.argv[1], sys.argv[2:]
    if command[0] == '--':
        command = command[1:]
    started = time.time()
    try:
        proc = subprocess.run(command, capture_output=True, text=True)
        code, stdout, stderr = proc.returncode, proc.stdout, proc.stderr
    except OSError as exc:
        code, stdout, stderr = 127, '', f'{type(exc).__name__}: {exc}\n'
    sys.stdout.write(stdout)
    sys.stderr.write(stderr)
    out_dir = Path(os.environ['RR_VERIFY_DIR']) / label
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime('%H%M%S', time.localtime(started)) + f'.{int(started * 1000) % 1000:03d}'
    path = out_dir / f'{stamp}-cmd.json'
    record = {
        'feature': label,
        'command': command,
        'exit_code': code,
        'stdout': stdout,
        'stderr': stderr,
        'mock': os.environ.get('ENGINE_MOCK') == '1',
        'seconds': round(time.time() - started, 2),
    }
    path.write_text(json.dumps(record, indent=2))
    print(f'saved: {path}', file=sys.stderr)
    return code


if __name__ == '__main__':
    sys.exit(main())
