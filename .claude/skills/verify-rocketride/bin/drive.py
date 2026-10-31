"""Drive a RocketRide pipeline through the Python SDK and save the evidence.

Run through `rr-verify chat` or `rr-verify send`, which set ROCKETRIDE_URI,
ROCKETRIDE_APIKEY, RR_VERIFY_DIR, and ENGINE_MOCK for the active run.

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
LLM_ERROR_PREFIXES = ('**LLM error**', 'LLM error:')


def evidence_path(label: str, kind: str, started: float) -> Path:
    out_dir = Path(os.environ['RR_VERIFY_DIR']) / label
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime('%H%M%S', time.localtime(started)) + f'.{int(started * 1000) % 1000:03d}'
    return out_dir / f'{stamp}-{kind}.json'


async def run_pipeline(args, record: dict, call) -> dict:
    """Start the pipeline, run `call` against its token, and always terminate it."""
    async with RocketRideClient(uri=os.environ['ROCKETRIDE_URI'], auth=os.environ['ROCKETRIDE_APIKEY']) as client:
        token = (await client.use(filepath=str(args.pipe)))['token']
        record['token'] = token
        try:
            return await call(client, token)
        finally:
            await client.terminate(token)
            record['terminated'] = True


async def run_chat(args, record: dict) -> tuple[dict, bool, str]:
    async def ask(client, token):
        question = Question()
        question.addQuestion(args.text)
        return await client.chat(token=token, question=question)

    result = await run_pipeline(args, record, ask)
    answers = result.get('answers') or []
    # The engine returns an LLM failure as an answer (`**LLM error** — <Exception>: ...`),
    # so an answer list is not proof that the model answered.
    errors = [a for a in answers if isinstance(a, str) and a.lstrip().startswith(LLM_ERROR_PREFIXES)]
    if args.expect == 'answers':
        ok = bool(answers) and not errors
        if errors:
            verdict = f'the answer is an LLM error: {errors[0][:300]}'
        else:
            verdict = f'{len(answers)} answer(s) returned' if ok else 'expected answers, got none'
    else:
        ok = not answers
        verdict = 'no answers returned, as expected' if ok else f'expected no answers, got {len(answers)}'
    return result, ok, verdict


async def run_send(args, record: dict) -> tuple[dict, bool, str]:
    async def send(client, token):
        return await client.send(token, args.text, objinfo={'name': 'input.txt'}, mimetype='text/plain')

    result = await run_pipeline(args, record, send)
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
    record = {
        'feature': args.label,
        'mode': args.mode,
        'mock': os.environ.get('ENGINE_MOCK') == '1',
        'pipe': str(args.pipe),
        'input': args.text,
        'engine': os.environ['ROCKETRIDE_URI'],
        'token': None,
        'terminated': False,
    }
    try:
        record['pipeline'] = json.loads(args.pipe.read_text())
        runner = run_chat if args.mode == 'chat' else run_send
        result, ok, verdict = asyncio.run(runner(args, record))
        record.update(result=result, ok=ok, verdict=verdict)
        code = 0 if ok else 1
    except Exception as exc:  # noqa: BLE001 - every failure is reported as evidence
        record.update(ok=False, verdict=f'run failed: {type(exc).__name__}: {exc}')
        code = 2
    record['seconds'] = round(time.time() - started, 2)
    path = evidence_path(args.label, args.mode, started)
    path.write_text(json.dumps(record, indent=2, default=str))
    print(json.dumps(record.get('result'), indent=2, default=str))
    print(f'token: {record["token"]}  terminated: {record["terminated"]}  mock: {record["mock"]}')
    print(f'{"PASS" if code == 0 else "FAIL"}: {record["verdict"]}')
    print(f'saved: {path}')
    return code


if __name__ == '__main__':
    sys.exit(main())
