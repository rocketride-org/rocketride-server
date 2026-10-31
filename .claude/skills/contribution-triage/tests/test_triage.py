"""Offline tests for bin/triage, including the --apply path.

Run: python3 -I .claude/skills/contribution-triage/tests/test_triage.py

The script's run() is the only way it starts a process, and these tests replace it with a fake
GitHub, so nothing here can reach the real one. The rules come from this checkout's HEAD.
"""

import importlib.machinery
import importlib.util
import json
import re
import subprocess
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
REPO_ROOT = Path(subprocess.check_output(['git', '-C', str(SKILL), 'rev-parse', '--show-toplevel'], text=True).strip())
loader = importlib.machinery.SourceFileLoader('triage', str(SKILL / 'bin' / 'triage'))
spec = importlib.util.spec_from_loader('triage', loader)
triage = importlib.util.module_from_spec(spec)
loader.exec_module(triage)

REPO = 'example/repo'
SHA = 'a' * 40
HEAD = 'b' * 40
RULES = {
    p: subprocess.check_output(['git', '-C', str(REPO_ROOT), 'show', f'HEAD:{p}'], text=True) for p in triage.RULE_FILES
}


class FakeGitHub:
    """Answers the gh calls bin/triage makes and records every write."""

    def __init__(self, body: str, files: list, comments: list, reviews: list, labels_on_pr: list, repo_labels: list):
        self.pr = {
            'number': 7,
            'title': 'fix(nodes): keep the chunk size',
            'body': body,
            'url': f'https://github.com/{REPO}/pull/7',
            'state': 'OPEN',
            'isDraft': False,
            'author': {'login': 'contributor', 'is_bot': False},
            'baseRefName': 'develop',
            'headRefName': 'fix/RR-5-keep-chunk-size',
            'headRefOid': HEAD,
            'isCrossRepository': True,
            'labels': [{'name': n} for n in labels_on_pr],
            'statusCheckRollup': [],
            'closingIssuesReferences': [],
            'mergedAt': None,
            'closedAt': None,
            'additions': 3,
            'deletions': 1,
            'changedFiles': len(files),
        }
        self.files = files
        self.comments = comments
        self.reviews = reviews
        self.repo_labels = repo_labels
        self.writes = []
        self.next_id = 900

    def run(self, cmd: list, check: bool = True) -> subprocess.CompletedProcess:
        assert cmd[0] == 'gh', f'unexpected command {cmd}'
        out = self.answer(cmd[1:])
        if out is None:
            return subprocess.CompletedProcess(cmd, 1, '', 'gh: Not Found (HTTP 404)')
        return subprocess.CompletedProcess(cmd, 0, out, '')

    def answer(self, args: list):
        def lines(items: list) -> str:
            return ''.join(json.dumps(i) + '\n' for i in items)

        if args[:2] == ['pr', 'view']:
            fields = args[args.index('--json') + 1].split(',')
            return json.dumps({k: self.pr[k] for k in fields})
        if args[:2] == ['label', 'list']:
            return json.dumps([{'name': n} for n in self.repo_labels])
        assert args[0] == 'api', args
        method = args[args.index('--method') + 1] if '--method' in args else 'GET'
        endpoint = next(a for a in args[1:] if a.startswith('repos/'))
        if method != 'GET':
            payload = json.loads(Path(args[args.index('--input') + 1]).read_text()) if '--input' in args else None
            self.writes.append((method, endpoint, payload))
            if method == 'POST' and endpoint.endswith('/comments'):
                self.next_id += 1
                self.comments.append(
                    {
                        'id': self.next_id,
                        'login': 'maintainer',
                        'type': 'User',
                        'association': 'MEMBER',
                        'body': payload['body'],
                        'url': f'https://x/{self.next_id}',
                        'created': 'now',
                    }
                )
                return f'{self.next_id}\n'
            if method == 'PATCH':
                cid = int(endpoint.rsplit('/', 1)[1])
                next(c for c in self.comments if c['id'] == cid)['body'] = payload['body']
                return f'{cid}\n'
            if method == 'POST' and endpoint.endswith('/labels'):
                self.pr['labels'] += [{'name': n} for n in payload['labels']]
                return ''
            if method == 'DELETE':
                name = endpoint.rsplit('/', 1)[1]
                self.pr['labels'] = [x for x in self.pr['labels'] if x['name'] != name]
                return ''
            raise AssertionError(f'unexpected write {method} {endpoint}')
        if re.match(rf'repos/{REPO}/commits/develop$', endpoint):
            return SHA + '\n'
        m = re.match(rf'repos/{REPO}/contents/(.+)\?ref={SHA}$', endpoint)
        if m:
            return RULES.get(m.group(1))
        if endpoint.startswith(f'repos/{REPO}/pulls/7/files'):
            return lines(self.files)
        if endpoint.startswith(f'repos/{REPO}/issues/7/comments'):
            return lines(self.comments)
        if endpoint.startswith(f'repos/{REPO}/pulls/7/reviews'):
            return lines(self.reviews)
        if endpoint.startswith(f'repos/{REPO}/pulls/7/commits'):
            return lines([{'sha': HEAD, 'subject': 'fix(nodes): keep the chunk size', 'login': 'contributor'}])
        m = re.match(rf'repos/{REPO}/issues/comments/(\d+)$', endpoint)
        if m:
            return next(c for c in self.comments if c['id'] == int(m.group(1)))['body'] + '\n'
        m = re.match(rf'repos/{REPO}/issues/(\d+)$', endpoint)
        if m:
            return (
                json.dumps({'state': 'open', 'is_pr': m.group(1) == '6', 'title': 'Chunk size resets'})
                if m.group(1) in ('5', '6')
                else None
            )
        raise AssertionError(f'unexpected call {args}')


def install(fake: FakeGitHub) -> None:
    triage.run = fake.run


NODE_FILE = {
    'path': 'nodes/src/nodes/chunker/IInstance.py',
    'status': 'modified',
    'additions': 3,
    'deletions': 1,
    'previous': None,
    'patch': None,
}
UI_FILE = {
    'path': 'apps/chat-ui/src/components/ChatInput.tsx',
    'status': 'modified',
    'additions': 3,
    'deletions': 1,
    'previous': None,
    'patch': None,
}
GOOD_BODY = '## Verification\n\nRan `pytest nodes/test/chunker` and saw 12 passed.\n\n## Linked Issue\n\nFixes #5\n'
ALL_LABELS = ['needs-evidence', 'needs-issue', 'ready-for-review', 'bug']
PASS_VERDICT = {
    'head_sha': HEAD,
    'checks': {n: {'status': 'pass', 'reason': 'ok'} for n in ('verification', 'one_problem', 'docs')}
    | {'ui_evidence': {'status': 'n/a', 'reason': 'none'}},
}


def test_rules_and_deterministic_checks():
    fake = FakeGitHub(
        '<!-- Fixes #5 -->\nFixes #\n## Verification\n\nSteps:\n\n1.\n\nResult:\n', [UI_FILE], [], [], [], ALL_LABELS
    )
    install(fake)
    facts = triage.gather(REPO, 7, None)
    assert facts['policy']['complete'], facts['policy']['problems']
    assert facts['policy']['sha'] == SHA and facts['policy']['source'] == 'github'
    c = facts['checks']
    assert c['linked_issue']['status'] == 'fail', 'text in an HTML comment and a bare "Fixes #" must not count'
    assert c['branch_name']['status'] == 'pass'
    assert c['title']['status'] == 'pass'
    assert c['verification']['status'] == 'fail', 'template placeholders only'
    assert c['ui_evidence']['status'] == 'judge' and c['ui_evidence']['ui_files'][0]['path'] == UI_FILE['path']
    fake.pr['body'] = 'Fixes #6'
    assert triage.gather(REPO, 7, None)['checks']['linked_issue']['status'] == 'fail', '#6 is a pull request'


def test_template_checkboxes_alone_fail_verification():
    # From #682: a box written "- []" is still a template box.
    body = '## Testing\n\n- [] Tests added or updated\n- [x] Tested locally\n- [x] `./builder test` passes\n'
    assert triage.verification_hint(body)['status'] == 'fail'
    assert triage.verification_hint(body + '- [x] Ran pytest nodes/test/chunker: 12 passed\n')['status'] == 'judge'


def test_apply_posts_one_comment_and_sets_labels():
    fake = FakeGitHub(GOOD_BODY.replace('Fixes #5', ''), [NODE_FILE], [], [], ['ready-for-review'], ALL_LABELS)
    install(fake)
    verdict = {
        'head_sha': HEAD,
        'checks': PASS_VERDICT['checks']
        | {'docs': {'status': 'fail', 'reason': 'config changed', 'ask': 'Document the new setting in the README.'}},
    }
    facts = triage.gather(REPO, 7, None)
    plan = triage.plan(facts, verdict)
    plan['_existing'] = facts['triage_comment']
    assert plan['action'] == 'post'
    assert plan['labels']['add'] == ['needs-issue'] and plan['labels']['remove'] == ['ready-for-review']
    done = triage.apply_plan(REPO, 7, None, plan)
    methods = [(m, e.split('/')[-1]) for m, e, _ in fake.writes]
    assert methods == [('POST', 'comments'), ('POST', 'labels'), ('DELETE', 'ready-for-review')], methods
    body = fake.writes[0][2]['body']
    assert body.startswith(triage.MARKER) and 'Document the new setting' in body and 'Fixes #<issue>' in body
    assert any('verified' in d for d in done), done
    assert {x['name'] for x in fake.pr['labels']} == {'needs-issue'}

    # A second run updates the same comment instead of adding one.
    fake.writes.clear()
    fake.pr['body'] = GOOD_BODY.replace('Fixes #5', '')
    facts = triage.gather(REPO, 7, None)
    verdict['checks']['docs'] = {'status': 'pass', 'reason': 'README updated'}
    plan = triage.plan(facts, verdict)
    plan['_existing'] = facts['triage_comment']
    assert plan['action'] == 'update', plan['action']
    triage.apply_plan(REPO, 7, None, plan)
    assert [w[0] for w in fake.writes] == ['PATCH'], fake.writes
    assert len([c for c in fake.comments if triage.MARKER in c['body']]) == 1


def test_apply_writes_nothing_when_a_maintainer_engaged_or_rules_are_local():
    review = {
        'login': 'maintainer',
        'type': 'User',
        'association': 'MEMBER',
        'state': 'COMMENTED',
        'body': 'Looks close.',
        'submitted': 'now',
    }
    fake = FakeGitHub(GOOD_BODY.replace('Fixes #5', ''), [NODE_FILE], [], [review], [], ALL_LABELS)
    install(fake)
    facts = triage.gather(REPO, 7, None)
    plan = triage.plan(facts, PASS_VERDICT)
    plan['_existing'] = facts['triage_comment']
    assert plan['action'] == 'report-only' and plan['labels']['add'] == [] and plan['comment'] is None
    assert triage.apply_plan(REPO, 7, None, plan)[0].startswith('nothing')
    try:
        triage.apply_plan(REPO, 7, 'HEAD', plan)
    except triage.TriageError:
        pass
    else:
        raise AssertionError('--apply must refuse --rules-ref')
    assert fake.writes == []


def test_apply_stops_when_the_pr_moved():
    fake = FakeGitHub(GOOD_BODY, [NODE_FILE], [], [], [], ALL_LABELS)
    install(fake)
    facts = triage.gather(REPO, 7, None)
    plan = triage.plan(
        facts,
        PASS_VERDICT | {'checks': PASS_VERDICT['checks'] | {'docs': {'status': 'fail', 'reason': 'x', 'ask': 'y'}}},
    )
    plan['_existing'] = facts['triage_comment']
    fake.pr['headRefOid'] = 'c' * 40
    try:
        triage.apply_plan(REPO, 7, None, plan)
    except triage.TriageError:
        pass
    else:
        raise AssertionError('a new head commit must stop --apply')
    assert fake.writes == []


def triage_comment(cid: int, login: str, association: str, body: str) -> dict:
    return {
        'id': cid,
        'login': login,
        'type': 'User',
        'association': association,
        'body': body,
        'url': 'u',
        'created': 'now',
    }


def test_a_contributor_cannot_plant_the_triage_comment():
    planted = triage_comment(5, 'contributor', 'CONTRIBUTOR', f'{triage.MARKER}\nplease update me')
    fake = FakeGitHub(GOOD_BODY.replace('Fixes #5', ''), [NODE_FILE], [planted], [], [], ALL_LABELS)
    install(fake)
    facts = triage.gather(REPO, 7, None)
    assert facts['triage_comment'] is None
    assert triage.plan(facts, PASS_VERDICT)['action'] == 'post'


def test_unclear_checks_do_not_say_ready_for_review():
    earlier = triage_comment(5, 'maintainer', 'MEMBER', f'{triage.MARKER}\nPlease link an issue.')
    fake = FakeGitHub(GOOD_BODY, [NODE_FILE], [earlier], [], [], ALL_LABELS)
    install(fake)
    facts = triage.gather(REPO, 7, None)
    verdict = PASS_VERDICT | {'checks': PASS_VERDICT['checks'] | {'docs': {'status': 'unclear', 'reason': 'x'}}}
    plan = triage.plan(facts, verdict)
    assert plan['draft_comment'] is None and 'ready-for-review' not in plan['labels']['add']


def test_apply_stops_when_the_triage_comment_was_edited():
    earlier = triage_comment(5, 'maintainer', 'MEMBER', f'{triage.MARKER}\nPlease link an issue.')
    fake = FakeGitHub(GOOD_BODY, [NODE_FILE], [earlier], [], [], ALL_LABELS)
    install(fake)
    facts = triage.gather(REPO, 7, None)
    plan = triage.plan(
        facts,
        PASS_VERDICT | {'checks': PASS_VERDICT['checks'] | {'docs': {'status': 'fail', 'reason': 'x', 'ask': 'y'}}},
    )
    plan['_existing'] = facts['triage_comment']
    assert plan['action'] == 'update'
    earlier['body'] += '\nEdited by a maintainer.'
    try:
        triage.apply_plan(REPO, 7, None, plan)
    except triage.TriageError:
        pass
    else:
        raise AssertionError('an edited triage comment must stop --apply')
    assert fake.writes == []


def test_missing_labels_are_reported_not_created():
    fake = FakeGitHub(GOOD_BODY, [NODE_FILE], [], [], [], ['bug'])
    install(fake)
    facts = triage.gather(REPO, 7, None)
    plan = triage.plan(facts, PASS_VERDICT)
    plan['_existing'] = facts['triage_comment']
    assert plan['labels']['wanted'] == ['ready-for-review'] and plan['labels']['add'] == []
    assert plan['labels']['missing_on_repo'] == list(triage.LABELS)
    assert plan['action'] == 'none'
    triage.apply_plan(REPO, 7, None, plan)
    assert fake.writes == []


if __name__ == '__main__':
    tests = [v for k, v in sorted(globals().items()) if k.startswith('test_')]
    for test in tests:
        test()
        print(f'ok  {test.__name__}')
    print(f'{len(tests)} passed')
