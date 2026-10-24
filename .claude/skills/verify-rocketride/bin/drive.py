"""Drive a RocketRide pipeline through the Python SDK and save the evidence.

Run through `rr-verify chat` or `rr-verify send`, which set ROCKETRIDE_URI,
ROCKETRIDE_APIKEY, and RR_VERIFY_DIR for the active run.

Exit codes: 0 = the expectation held, 1 = it did not, 2 = the run itself failed.
"""

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

from rocketride import RocketRideClient
from rocketride.schema import Question

SKILL_DIR = Path(__file__).resolve().parent.parent
DEFAULT_CHAT_PIPE = SKILL_DIR / 'fixtures' / 'quickstart-chat.pipe'


def evidence_path(label: str, kind: str) -> Path:
    run_dir = Path(os.environ['RR_VERIFY_DIR'])
    out_dir = run_dir / label
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir / f'{time.strftime("%H%M%S")}-{kind}.json'


async def run_chat(args) -> tuple[dict, bool, str]:
    async with RocketRideClient(uri=os.environ['ROCKETRIDE_URI'], auth=os.environ['ROCKETRIDE_APIKEY']) as client:
        token = (await client.use(filepath=str(args.pipe)))['token']
        try:
            question = Question()
            question.addQuestion(args.text)
            result = await client.chat(token=token, question=question)
        finally:
            await client.terminate(token)
    answers = result.get('answers') or []
    if args.expect == 'answers':
        ok = bool(answers)
        verdict = f'{len(answers)} answer(s) returned' if ok else 'expected answers, got none'
    else:
        ok = not answers
        verdict = 'no answers returned, as expected' if ok else f'expected no answers, got {len(answers)}'
    return result, ok, verdict


async def run_send(args) -> tuple[dict, bool, str]:
    async with RocketRideClient(uri=os.environ['ROCKETRIDE_URI'], auth=os.environ['ROCKETRIDE_APIKEY']) as client:
        token = (await client.use(filepath=str(args.pipe)))['token']
        try:
            result = await client.send(token, args.text, objinfo={'name': 'input.txt'}, mimetype='text/plain')
        finally:
            await client.terminate(token)
    if args.expect_text is None:
        return result, True, 'no expectation set; inspect the result'
    texts = result.get('text') or []
    ok = any(args.expect_text in t for t in texts)
    verdict = (
        f'result text contains {args.expect_text!r}' if ok else f'result text does not contain {args.expect_text!r}'
    )
    return result, ok, verdict


def main() -> int:
    parser = argparse.ArgumentParser(prog='drive.py')
    sub = parser.add_subparsers(dest='mode', required=True)

    chat = sub.add_parser('chat', help='run a chat-source pipeline')
    chat.add_argument('--pipe', type=Path, default=DEFAULT_CHAT_PIPE)
    chat.add_argument('--expect', choices=['answers', 'none'], default='answers')
    chat.add_argument('--label', default='chat-pipeline')
    chat.add_argument('text')

    send = sub.add_parser('send', help='run a webhook-source pipeline')
    send.add_argument('--pipe', type=Path, required=True)
    send.add_argument('--expect-text')
    send.add_argument('--label', default='webhook-pipeline')
    send.add_argument('text')

    args = parser.parse_args()
    started = time.time()
    record = {'mode': args.mode, 'pipe': str(args.pipe), 'input': args.text, 'engine': os.environ['ROCKETRIDE_URI']}
    try:
        record['pipeline'] = json.loads(args.pipe.read_text())
        runner = run_chat if args.mode == 'chat' else run_send
        result, ok, verdict = asyncio.run(runner(args))
        record.update(result=result, ok=ok, verdict=verdict)
        code = 0 if ok else 1
    except Exception as exc:  # noqa: BLE001 - every failure is reported as evidence
        record.update(ok=False, verdict=f'run failed: {type(exc).__name__}: {exc}')
        code = 2
    record['seconds'] = round(time.time() - started, 2)
    path = evidence_path(args.label, args.mode)
    path.write_text(json.dumps(record, indent=2, default=str))
    print(json.dumps(record.get('result'), indent=2, default=str))
    print(f'{"PASS" if code == 0 else "FAIL"}: {record["verdict"]}')
    print(f'saved: {path}')
    return code


if __name__ == '__main__':
    sys.exit(main())
