"""Score eval results and write a Markdown report.

Usage: python3 -I score.py [RESULTS_DIR] [--no-judge]

Reads every RESULTS_DIR/<case>/<variant>/result.json (default: <repo>/.verify/evals).
For a bug case, a run counts as caught only when a reported defect matches the case's
ground truth. A small model judges the match once per run and the verdict is cached in
judge.json next to result.json; edit that file to override it. For a clean control, a
run is a false alarm when it reports a defect other than the case's known issues.
"""

import json
import statistics
import subprocess
import sys
from pathlib import Path

EVALS = Path(__file__).resolve().parent
REPO = Path(subprocess.check_output(['git', '-C', str(EVALS), 'rev-parse', '--show-toplevel'], text=True).strip())

JUDGE_PROMPT = """You grade a software QA report. Answer with JSON only: {{"match": true|false, "reason": "one sentence"}}.

{question}

Reference: {reference}

Defects the tester reported:
{defects}
"""


def judge(run_dir: Path, question: str, reference: str, defects: list, use_model: bool) -> dict:
    cache = run_dir / 'judge.json'
    if cache.exists():
        return json.loads(cache.read_text())
    if not use_model:
        return {'match': None, 'reason': 'not judged'}
    prompt = JUDGE_PROMPT.format(question=question, reference=reference, defects=json.dumps(defects, indent=1))
    proc = subprocess.run(
        ['claude', '-p', prompt, '--model', 'haiku', '--output-format', 'json', '--no-session-persistence'],
        capture_output=True,
        text=True,
        timeout=300,
    )
    try:
        text = json.loads(proc.stdout)['result']
        verdict = json.loads(text[text.index('{') : text.rindex('}') + 1])
    except (ValueError, KeyError, json.JSONDecodeError):
        verdict = {'match': None, 'reason': f'judge failed: {proc.stderr[:200]}'}
    verdict['judged_by'] = 'claude haiku'
    cache.write_text(json.dumps(verdict, indent=2))
    return verdict


def outcome(case: dict, result: dict, run_dir: Path, use_model: bool) -> tuple[str, str]:
    verdict = result.get('verdict')
    if verdict is None:
        return 'no-verdict', 'the agent did not finish with a JSON verdict'
    defects = verdict.get('defects') or []
    found = bool(verdict.get('defect_found')) and bool(defects)
    if case['expect'] == 'defect':
        if not found:
            return 'missed', 'no defect reported'
        j = judge(
            run_dir,
            'Does any reported defect describe the same product problem as the reference bug?',
            case['ground_truth'],
            defects,
            use_model,
        )
        if j.get('match') is None:
            return 'unjudged', j.get('reason', '')
        return ('caught', j['reason']) if j['match'] else ('wrong-defect', j['reason'])
    if not found:
        return 'clean', 'no defect reported'
    known = case.get('known_issues')
    if not known:
        return 'false-alarm', '; '.join(d.get('behavior', '') for d in defects)[:200]
    j = judge(
        run_dir,
        'Is every reported defect one of the known pre-existing issues in the reference? Answer match=true only if all of them are.',
        known,
        defects,
        use_model,
    )
    if j.get('match') is None:
        return 'unjudged', j.get('reason', '')
    return ('clean', 'only known issues reported') if j['match'] else ('false-alarm', j['reason'])


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    use_model = '--no-judge' not in sys.argv
    results_dir = Path(args[0]) if args else REPO / '.verify' / 'evals'
    cases = {c['id']: c for c in json.loads((EVALS / 'cases.json').read_text())['cases']}

    rows = []
    for result_file in sorted(results_dir.glob('*/*/result.json')):
        result = json.loads(result_file.read_text())
        case = cases.get(result['case'])
        if case is None:
            continue
        kind, why = outcome(case, result, result_file.parent, use_model)
        variant = f'{result["agent"]} ({result["model"]}){"" if result["skill"] else ", no skill"}'
        rows.append({'case': case, 'result': result, 'variant': variant, 'outcome': kind, 'why': why})

    lines = ['# verify-rocketride eval results', '']
    lines += [
        '## By variant',
        '',
        '| Variant | Bugs caught | False alarms | Median minutes | Median tokens |',
        '|---|---|---|---|---|',
    ]
    for variant in sorted({r['variant'] for r in rows}):
        mine = [r for r in rows if r['variant'] == variant]
        bugs = [r for r in mine if r['case']['expect'] == 'defect']
        clean = [r for r in mine if r['case']['expect'] == 'no-defect']
        caught = sum(r['outcome'] == 'caught' for r in bugs)
        alarms = sum(r['outcome'] == 'false-alarm' for r in clean)
        minutes = statistics.median([r['result']['seconds'] / 60 for r in mine]) if mine else 0
        tokens = [
            (r['result']['usage'].get('input_tokens') or 0) + (r['result']['usage'].get('output_tokens') or 0)
            for r in mine
            if r['result'].get('usage')
        ]
        median_tokens = f'{statistics.median(tokens):,.0f}' if tokens else 'n/a'
        lines.append(
            f'| {variant} | {caught} of {len(bugs)} | {alarms} of {len(clean)} | {minutes:.1f} | {median_tokens} |'
        )

    lines += [
        '',
        '## By case',
        '',
        '| Case | Kind | Area | Variant | Outcome | Minutes | Why |',
        '|---|---|---|---|---|---|---|',
    ]
    for r in sorted(rows, key=lambda r: (r['case']['id'], r['variant'])):
        c = r['case']
        lines.append(
            f'| {c["id"]} | {c["kind"]} | {c["area"]} | {r["variant"]} | {r["outcome"]} | '
            f'{r["result"]["seconds"] / 60:.1f} | {r["why"].replace("|", "/")} |'
        )
    report = '\n'.join(lines) + '\n'
    (results_dir / 'report.md').write_text(report)
    print(report)


if __name__ == '__main__':
    main()
