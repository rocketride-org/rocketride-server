"""Deterministic RocketRide-usage evaluation engine.

Measures usage from a repo's CODE (parsed `.pipe` files + source scan), scores it against the
approved weights (SCORING_SPEC.md), and derives Tag + Backbone deterministically - no LLM. The
LLM (elsewhere) only writes the human-readable prose from this evaluation.

Split into:
  • pure functions  - parse_pipe / sdk_metrics / pipe_called / evaluate  (network-free, unit-tested)
  • gather(url, gh) - fetches the repo (given a `gh(url)->(status, text)` fetcher) into `evidence`
"""

from __future__ import annotations

import json
import re

from .target import Target, load_preset  # noqa: F401  (eval/ dir is on sys.path wherever engine is imported)

# The bundled preset (eval/targets/rocketride.json) mirrors the constants below verbatim -
# it is the DB-seeded description of what this module's legacy path checks. The legacy
# (pipeline-scoring) path below is kept byte-identical for fixture parity; targets with
# pipeline_scoring=False route to the target-agnostic generic path at the bottom.
ROCKETRIDE = load_preset()

# ---------------------------------------------------------------- approved weights (SCORING_SPEC.md)
W = {
    'dependency': 1.0,  # C1  rocketride in a manifest
    'pipeline_called': 2.0,  # B1  per pipeline proven to be called
    'agent_node': 1.0,  # A3  a called pipeline contains an agent_* node
    'complexity_mid': 0.5,  # A2  called pipeline has 4-8 nodes
    'complexity_high': 1.0,  # A2  called pipeline has 9+ nodes
    'tool_or_llm': 0.5,  # A4  called pipeline has a tool_* or llm_* node
    'hosted': 1.0,  # C4  hosted-pipeline usage (id/env + adapter)
    'sdk_callsites': 0.5,  # C2  >=3 SDK call-sites
    'file_spread': 0.5,  # C3  >=2 distinct files use RocketRide
    'uncalled_penalty': 1.0,  # B2  per pipeline present but NEVER called
    'predates_penalty': 1.0,  # D4  flat, once per project: a called pipeline predates the event window
}
THRESHOLDS = {'significant': 4.0, 'moderate': 2.0, 'less': 1.0}
_MAX_SCORED_PIPES = 6  # cap how many called pipelines score, so a big generated suite can't run away
EVENT_GRACE_DAYS = 2  # commits within event_date ± this many days are fine (no reuse penalty)
DEFAULT_HISTORY_PENALTY = 2.0  # judge-configurable deduction when a project's history predates the
# window or a commit-date rewrite is detected (0 = flag only)

_SDK_CALL = re.compile(r'\b(RocketRideClient|client\.use|client\.chat|client\.send|client\.connect)', re.I)
_MANIFEST = re.compile(
    r'(^|/)(package\.json|requirements\.txt|pyproject\.toml|Cargo\.toml|go\.mod'
    r'|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|[^/]+\.csproj)$',
    re.I,
)
# scan beyond JS/Python - a pipeline can be called (or the SDK used) from any language
_SRC_EXT = re.compile(r'\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|rb|php|cs|swift|scala|sh)$', re.I)
_SRC_HINT = re.compile(
    r'rocket|pipeline|integration|agent|engine|config|api|route|server|main|index|app|relay|deploy', re.I
)
# a pipeline defined in code and handed straight to the SDK: client.use({ pipeline ... })
_INLINE_PIPE = re.compile(r'client\.use\(\s*\{\s*pipeline\b', re.I)
# a GENERIC runner: client.use(filepath=<variable>) / client.use({ filepath: <var> }) - the pipe path
# is computed/passed in, so specific .pipe names never appear next to the call (NOUS pattern).
_RUNNER = re.compile(r"""client\.use\(\s*\{?\s*(?:file)?path\s*[=:]\s*(?!['"])""", re.I)
# SDK-less HTTP / webhook invocation: a raw call to the hosted API or a deployed pipeline's webhook
# (any language, no SDK). This IS a real runtime call to RocketRide.
_RR_HTTP = re.compile(r'api\.rocketride\.ai|rocketride\.ai/[\w/-]*(pipeline|webhook|hook|run|invoke)', re.I)
# a deployed-pipeline URL / webhook / token env (ROCKETRIDE_*_URL / _WEBHOOK / _ENDPOINT) - NOT a bare
# ROCKETRIDE_API_KEY (auth only), which stays excluded.
_HOSTED_ENV = re.compile(r'rocketride_\w*(url|webhook|endpoint|hook)', re.I)
# a committed .json is a pipeline (not package.json / config) only if it has provider-bearing nodes
_PIPE_HINT = re.compile(
    r'^(webhook|chat|prompt|response|source|memory|telegram)$|^(llm_|agent_|tool_|db_|embedding_|vector|response_|source_)',
    re.I,
)
_JSON_PIPE_PATH = re.compile(r'pipeline|rocketride', re.I)
_JSON_CONFIG = re.compile(
    r'(package(-lock)?|tsconfig|composer|schema|manifest|settings|config)\.json$|node_modules', re.I
)


# ---------------------------------------------------------------- pure detectors
def parse_pipe(text: str) -> dict | None:
    """Node metrics for one .pipe JSON. None if unparseable."""
    try:
        d = json.loads(text)
    except Exception:
        return None
    if not isinstance(d, dict):
        return None
    if isinstance(d.get('pipeline'), dict):
        d = d['pipeline']  # unwrap the { "pipeline": {…} } envelope - the SDK loader does the same
    # canvas exports use "components"; hand-written pipes sometimes use "nodes" (and "type" for
    # the provider). Accept both so a valid pipeline isn't read as 0 nodes.
    comps = d.get('components') or d.get('nodes') or []
    providers = [str(c.get('provider') or c.get('type') or '') for c in comps]
    return {
        'nodes': len(comps),
        'providers': providers,
        'has_agent': any(p.startswith('agent_') for p in providers),
        'has_llm': any(p.startswith('llm_') for p in providers),
        'tool_count': sum(p.startswith('tool_') for p in providers),
        'project_id': d.get('project_id') or '',
    }


def complexity_band(nodes: int) -> str:
    return 'high' if nodes >= 9 else 'medium' if nodes >= 4 else 'low'


def history_tamper_scan(commits: list, win: dict) -> tuple:
    """Scan a repo's commit list for evidence of history rewriting. Git stamps every commit with an
    AUTHOR date (when the work was originally made) and a COMMITTER date (when it was last
    rewritten). A commit whose committer date sits in/after the event window while its author date
    is OLDER than the window is pre-existing work re-stamped for the event (rebase / amend /
    filter-branch) - git's own metadata records the rewrite.
    Returns ([tampered commits], earliest_date_seen).
    """
    tampered, earliest = [], ''
    for it in commits or []:
        c = (it or {}).get('commit', {})
        a = (c.get('author') or {}).get('date', '') or ''
        m = (c.get('committer') or {}).get('date', '') or ''
        for d in (a, m):
            if d and (not earliest or d < earliest):
                earliest = d
        if a and m and a[:10] < win['start'] and m[:10] >= win['start']:
            tampered.append({'sha': (it.get('sha') or '')[:7], 'author': a, 'committer': m})
    return tampered[:5], earliest


def event_window(event_date: str | None) -> dict | None:
    """The allowed commit window for an event date (YYYY-MM-DD): event ± EVENT_GRACE_DAYS.
    Pipelines whose history starts BEFORE the window are pre-existing work (reuse).
    """
    if not event_date:
        return None
    try:
        from datetime import date, timedelta

        d = date.fromisoformat(str(event_date)[:10])
    except ValueError:
        return None
    g = timedelta(days=EVENT_GRACE_DAYS)
    return {'event': d.isoformat(), 'start': (d - g).isoformat(), 'end': (d + g).isoformat()}


def _looks_like_pipeline(m: dict | None) -> bool:
    """True only if a parsed JSON is actually a pipeline (has provider-bearing nodes) - so a
    package.json / config file is never mistaken for one.
    """
    return bool(m) and m['nodes'] > 0 and any(_PIPE_HINT.search(p) for p in m['providers'] if p)


_INVOKE = ('client.use', 'client.send', 'client.chat', 'rocketride start')

# tech-stack detection (for the dossier's "Built with" chips) - languages from file
# extensions, frameworks from manifest contents. Deterministic, from code, never self-reported.
_TECH_EXT = {
    '.py': 'Python',
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript',
    '.mjs': 'JavaScript',
    '.rs': 'Rust',
    '.go': 'Go',
    '.java': 'Java',
    '.kt': 'Kotlin',
    '.rb': 'Ruby',
    '.php': 'PHP',
    '.cs': 'C#',
    '.swift': 'Swift',
    '.scala': 'Scala',
    '.vue': 'Vue',
    '.svelte': 'Svelte',
    '.sh': 'Shell',
}
_TECH_FRAMEWORKS = (
    ('"next"', 'Next.js'),
    ('"react"', 'React'),
    ('"vite"', 'Vite'),
    ('"tailwindcss"', 'Tailwind CSS'),
    ('"express"', 'Express'),
    ('"vue"', 'Vue'),
    ('"svelte"', 'Svelte'),
    ('fastapi', 'FastAPI'),
    ('flask', 'Flask'),
    ('django', 'Django'),
    ('streamlit', 'Streamlit'),
    ('gradio', 'Gradio'),
    ('"electron"', 'Electron'),
)


def detect_tech(paths: list, manifest_texts: list, gh_languages: dict | None = None) -> list:
    """Language + framework chips for a repo. Languages come from GitHub's own Linguist
    detection (the /languages API - authoritative, same data as the repo's language bar)
    when available, ranked by byte count; extension counting is only the offline fallback.
    Frameworks come from manifest contents (Linguist doesn't know frameworks).
    """
    if gh_languages:
        langs = [k for k, _ in sorted(gh_languages.items(), key=lambda kv: -kv[1])][:5]
    else:
        counts: dict = {}
        for p in paths:
            pl = p.lower()
            if 'node_modules/' in pl or 'vendor/' in pl or '/dist/' in pl:
                continue
            dot = pl.rfind('.')
            t = _TECH_EXT.get(pl[dot:]) if dot >= 0 else None
            if t:
                counts[t] = counts.get(t, 0) + 1
        langs = [t for t, _ in sorted(counts.items(), key=lambda kv: -kv[1])][:5]
    joined = ' '.join(manifest_texts).lower()
    fws = [label for key, label in _TECH_FRAMEWORKS if key in joined and label not in langs]
    return langs + fws[:5]


def _gh_languages(gh, owner: str, repo: str) -> dict | None:
    """GitHub Linguist language byte counts, or None if the call fails (fallback kicks in)."""
    st, body = gh(f'https://api.github.com/repos/{owner}/{repo}/languages')
    if st != 200:
        return None
    try:
        d = json.loads(body)
        return d if isinstance(d, dict) and d else None
    except Exception:
        return None


def _first_site(source_files: list, rx, snippet: str) -> dict | None:
    """First line matching `rx` across the source, as a call-site dict (for inline / runner patterns)."""
    for f in source_files:
        mt = rx.search(f['text'])
        if mt:
            return {'file': f['path'], 'line': f['text'][: mt.start()].count('\n') + 1, 'snippet': snippet}
    return None


def _call_sites(f: dict, base: str) -> list:
    out = []
    for i, line in enumerate(f['text'].splitlines(), 1):
        ll = line.lower()
        if base in ll or any(k in ll for k in _INVOKE):
            out.append({'file': f['path'], 'line': i, 'snippet': line.strip()[:110]})
    return out


def pipe_called(pipe_path: str, source_files: list) -> tuple:
    """A pipeline is 'called' when the code loads/runs it via the SDK. Two patterns count:
      • strong     - a file names the pipe (its basename appears, even inside resolve(HERE, '...'))
                     AND that same file invokes client.use/send/chat / `rocketride start`;
      • cross-file - the basename is referenced in one file while the SDK is invoked in another
                     (common when the path is a shared constant or built dynamically).
    Returns (called, call_sites[]).
    """
    base = pipe_path.rsplit('/', 1)[-1].lower()
    ref_files = [f for f in source_files if base in f['text'].lower()]
    if not ref_files:
        return False, []
    # strong: same file names the pipe and drives the SDK
    for f in ref_files:
        if any(k in f['text'].lower() for k in _INVOKE):
            return True, _call_sites(f, base)[:6]
    # cross-file: pipe referenced here, SDK invoked somewhere else in the repo
    if any(k in f['text'].lower() for f in source_files for k in _INVOKE):
        sites = [s for f in ref_files for s in _call_sites(f, base)]
        return True, sites[:6]
    return False, []


def sdk_metrics(source_files: list) -> dict:
    """Deterministic SDK-depth metrics across the fetched source."""
    callsites = files_using = 0
    hosted = engine = False
    for f in source_files:
        t, low = f['text'], f['text'].lower()
        n = len(_SDK_CALL.findall(t))
        callsites += n
        if n or 'from rocketride' in low or 'import rocketride' in low or '@rocketride' in low:
            files_using += 1
        # hosted-pipeline usage = a pipeline called by id / a deployed webhook + an adapter. A bare
        # ROCKETRIDE_API_KEY is only authentication (present even for local-pipe projects like
        # constructor) - it is NOT hosted-pipeline usage, so it must not score on its own.
        if 'rocketride_pipeline' in low or 'lib/rocketride' in low or _HOSTED_ENV.search(low):
            hosted = True
        # a real runtime call to RocketRide - the local engine, the /v1 API, the hosted API host, or a
        # deployed pipeline's webhook (raw HTTP, no SDK, any language). This is genuine invocation.
        if 'ws://localhost:5565' in low or '/v1/pipelines' in low or _RR_HTTP.search(low):
            engine = True
    return {'callsites': callsites, 'file_spread': files_using, 'hosted': hosted, 'engine': engine}


# ---------------------------------------------------------------- backbone + tag (deterministic)
_AI_COMPETITORS = {'langchain', 'crewai'}  # a competing AI runtime demotes to Partial
# butterbase/supabase/firebase/pinecone/etc. are data/gateway - they do NOT demote


def _backbone(pipelines: list, sdk: dict, evidence: dict) -> str:
    runs_orchestration = any(p['called'] and (p.get('has_agent') or p.get('has_llm')) for p in pipelines)
    real = runs_orchestration or sdk['hosted'] or sdk['engine']
    if not real:
        return 'No'
    if any(o in _AI_COMPETITORS for o in evidence.get('other_platforms', [])):
        return 'Partial'
    return 'Yes'


def _tag(score: float, backbone: str, called: int, evidence: dict) -> str:
    if evidence.get('overclaim') or not evidence.get('accessible', True):
        return 'None'
    if evidence.get('scaffold_only') and called == 0:
        return 'Less'  # D1 cap: scaffold/branding only
    if score >= THRESHOLDS['significant']:
        return 'Significant' if backbone in ('Yes', 'Partial') else 'Moderate'  # gate
    if score >= THRESHOLDS['moderate']:
        return 'Moderate'
    if score >= THRESHOLDS['less']:
        return 'Less'
    return 'None'


def evaluate(evidence: dict, target: Target | None = None) -> dict:
    """Score the gathered evidence → deterministic Tag / Backbone / ground-truth table.
    `target=None` (or the pipeline-scoring preset) uses the legacy RocketRide path unchanged;
    any other target routes to the target-agnostic generic path.
    """
    if target is not None and not target.pipeline_scoring:
        return _evaluate_generic(evidence, target)
    if not evidence.get('accessible'):
        return {
            'tag': 'None',
            'backbone': 'No',
            'score': 0.0,
            'pipelines': [],
            'sdk': {},
            'breakdown': [],
            'pipelines_called': 0,
            'reason': 'inaccessible',
        }

    breakdown, score = [], 0.0

    def add(label, pts):
        nonlocal score
        score += pts
        breakdown.append({'signal': label, 'points': pts})

    if evidence.get('dependency'):
        add('dependency in manifest', W['dependency'])

    sdk = evidence.get('sdk', {'callsites': 0, 'file_spread': 0, 'hosted': False, 'engine': False})

    pipelines = []
    for p in evidence.get('pipes', []):
        m = p.get('metrics')
        nodes = m['nodes'] if m else 0
        pipelines.append(
            {
                'name': p['path'],
                'nodes': nodes,
                'complexity': complexity_band(nodes),
                'has_agent': bool(m and m['has_agent']),
                'has_llm': bool(m and m['has_llm']),
                'tool_count': (m['tool_count'] if m else 0),
                'providers': (m['providers'] if m else []),
                'called': p.get('called', False),
                'call_sites': p.get('call_sites', []),
                'first_commit': p.get('first_commit'),
            }
        )

    called_pipes = [e for e in pipelines if e['called']]
    called = len(called_pipes)
    # Does the repo genuinely run RocketRide pipelines? (SDK call-sites, live-engine calls, or an
    # already-called pipe.) A bare hosted env-var alone does NOT count - see MCP AttackGraph.
    repo_invokes = called > 0 or sdk.get('callsites', 0) > 0 or bool(sdk.get('engine'))

    for e in called_pipes[:_MAX_SCORED_PIPES]:  # cap so a big generated suite can't run away
        add(f'pipeline called: {e["name"]}', W['pipeline_called'])
        if e['has_agent']:
            add(f'agent node in {e["name"]}', W['agent_node'])
        if e['nodes'] >= 9:
            add(f'complexity high ({e["nodes"]} nodes)', W['complexity_high'])
        elif e['nodes'] >= 4:
            add(f'complexity mid ({e["nodes"]} nodes)', W['complexity_mid'])
        if e['has_llm'] or e['tool_count']:
            add(f'tool/llm node in {e["name"]}', W['tool_or_llm'])
    if called > _MAX_SCORED_PIPES:
        add(f'(+{called - _MAX_SCORED_PIPES} more called pipeline(s) - score capped)', 0.0)

    # Uncalled pipes are "for show" ONLY when the repo never invokes RocketRide at all. Otherwise
    # they're experiments / examples / runtime-generated - no credit, but NO penalty, so a big
    # uncalled suite can never bury genuine usage (the NOUS / rocketride-server false-negative).
    if not repo_invokes:
        for e in pipelines:
            if not e['called']:
                add(f'PENALTY pipeline never called: {e["name"]}', -W['uncalled_penalty'])

    # D4 - commit-history freshness: a CALLED pipeline whose history starts BEFORE the allowed
    # event window (event ± grace days) is pre-existing work being reused for the hackathon.
    # Flat −1 once per project, loudly flagged. ISO dates compare lexicographically.
    win = evidence.get('event_window')
    reused = []
    if win:
        for e in pipelines:
            e['predates'] = bool(e['called'] and e.get('first_commit') and str(e['first_commit'])[:10] < win['start'])
        reused = [e for e in pipelines if e.get('predates')]
        if reused:
            names = ', '.join(f'{e["name"]} (first commit {str(e["first_commit"])[:10]})' for e in reused[:4])
            add(
                f'PENALTY: pipeline predates event window {win["start"]}..{win["end"]} - {names}',
                -W['predates_penalty'],
            )

    if sdk.get('hosted'):
        add('hosted-pipeline usage', W['hosted'])
    if sdk.get('callsites', 0) >= 3:
        add(f'SDK call-sites ({sdk["callsites"]})', W['sdk_callsites'])
    if sdk.get('file_spread', 0) >= 2:
        add(f'SDK spread ({sdk["file_spread"]} files)', W['file_spread'])

    # D5/D6 - event-integrity FLAGS (judge's call, when an event window is set). Each deducts the
    # judge-configurable history penalty (default 2; 0 = flag only, a large value ≈ disqualify):
    #   D5 project predates: ANY commit before the window start = the project wasn't built at the
    #      event (old project + a few event-day commits).
    #   D6 history tampered: git's author-vs-committer dates prove pre-window work was re-stamped
    #      into the window (rebase/amend/filter-branch) - faked freshness.
    project_predates = evidence.get('project_predates')
    tampered = evidence.get('history_tampered') or []
    pen = evidence.get('history_penalty')
    pen = DEFAULT_HISTORY_PENALTY if pen is None else max(0.0, float(pen))
    if win and project_predates:
        pp_date = str(project_predates.get('date', ''))[:10]
        early = str(evidence.get('earliest_commit', ''))[:10]
        earliest = min(d for d in (pp_date, early) if d) if (pp_date or early) else '?'
        add(
            f'⚠ FLAGGED: project history predates the event window {win["start"]}..{win["end"]} - '
            f'work goes back to {earliest} (latest pre-window commit '
            f'{project_predates.get("sha", "?")} on {pp_date or "?"}); judge-set penalty',
            -pen,
        )
    if win and tampered:
        t0 = tampered[0]
        add(
            f'⚠ FLAGGED: commit-date rewrite detected - {t0["sha"]} authored '
            f'{str(t0["author"])[:10]} but re-stamped {str(t0["committer"])[:10]} into the window; '
            f'judge-set penalty',
            -pen,
        )

    score = max(0.0, round(score, 1))
    backbone = _backbone(pipelines, sdk, evidence)
    tag = _tag(score, backbone, called, evidence)
    # couple backbone to the verdict: a project with no real usage (None/Less) can't be the backbone
    # of anything, so it never shows Yes/Partial. This makes contradictions like "None + Yes" impossible.
    if tag in ('None', 'Less'):
        backbone = 'No'
    return {
        'tag': tag,
        'backbone': backbone,
        'score': score,
        'pipelines': pipelines,
        'sdk': sdk,
        'breakdown': breakdown,
        'pipelines_called': called,
        'tech': evidence.get('tech', []),
        'pipelines_total': len(pipelines),
        'other_platforms': evidence.get('other_platforms', []),
        'event_window': win,
        'history_penalty': pen if win else None,
        'project_predates': project_predates if win else None,
        'history_tampered': tampered if win else [],
        'earliest_commit': evidence.get('earliest_commit', ''),
        'repo_created_at': evidence.get('repo_created_at', ''),
        'reused_pipelines': [{'name': e['name'], 'first_commit': e.get('first_commit')} for e in reused],
    }


# default deterministic-eval fields for short-circuit rows (no repo / inaccessible), so the UI +
# Excel never see a missing key. Kept here so the app and the CLI use the exact same shape.
ZERO_EVAL = {
    'score': 0.0,
    'pipelines': [],
    'breakdown': [],
    'pipelines_called': 0,
    'pipelines_total': 0,
    'other_platforms': [],
    'event_window': None,
    'reused_pipelines': [],
    'project_predates': None,
    'history_tampered': [],
    'earliest_commit': '',
    'repo_created_at': '',
    'history_penalty': None,
    'tech': [],
}


# ---------------------------------------------------------------- LLM prose helpers (shared: app + CLI)
# The verdict is deterministic (evaluate()); the cloud LLM's ONLY job is to explain it in plain
# English. These helpers build that prompt and parse the reply, so app and CLI never diverge.
EXPLAIN_PROMPT = """You are documenting how a hackathon project used RocketRide, for a judge.

The VERDICT has ALREADY been decided deterministically from the project's actual code - you must NOT
change it. Your only job is to explain it in plain English, grounded entirely in the evidence table
you are given (pipelines, their node counts, and whether each is actually CALLED in the code, with
call sites).

Return ONLY a strict JSON object - start with { and end with }, no prose outside it:
{
  "description": "<1-2 sentences: what the project does>",
  "rocketride_usage": "<1-2 sentences: concretely how it uses RocketRide - name the pipeline(s), the
                        node count, and whether/where they are called; ground every claim in the table>",
  "justification": "<2-3 sentences: why the code earns THIS tag and backbone, citing the table (e.g.
                     'the 7-node agent pipeline is loaded and run at relay.ts:83'). If a pipeline is
                     present but never called, say so explicitly. If a pipeline predates the event
                     window (reused), call that out.>",
  "project_name": "<ONLY if the README clearly states the project's name - else omit>",
  "team_members": "<ONLY if the README clearly lists team member names - comma-separated - else omit>"
}
Rules: cite ONLY what is in the evidence. Never contradict the verdict. If the tag is None, state that
the code shows no real RocketRide usage. Write plainly and never use em dashes anywhere in your
prose; use commas, periods, or parentheses instead."""


def _iter_json_objects(text: str):
    depth, start = 0, None
    for i, ch in enumerate(text):
        if ch == '{':
            if depth == 0:
                start = i
            depth += 1
        elif ch == '}' and depth > 0:
            depth -= 1
            if depth == 0 and start is not None:
                yield text[start : i + 1]
                start = None


def extract_prose(text: str) -> dict:
    """Pull the {description, rocketride_usage, justification} object out of the LLM reply, tolerating
    any wrapping analysis. The verdict is NOT here - that's decided deterministically.
    """
    best: dict = {}
    for cand in _iter_json_objects(text or ''):
        try:
            obj = json.loads(cand)
        except Exception:
            continue
        if isinstance(obj, dict) and any(k in obj for k in ('description', 'rocketride_usage', 'justification')):
            best = obj
    return best


def explain_prompt(
    evaluation: dict, project: str, repo: str, feedback: str, readme_head: str = '', target_name: str = 'RocketRide'
) -> str:
    """Build the prose prompt: the deterministic verdict + the ground-truth table as fixed context.
    `target_name` retargets every display-name mention (the wire key `rocketride_usage` is
    lowercase and untouched, so parsing never changes).
    """
    payload = {
        'verdict': {'tag': evaluation['tag'], 'backbone': evaluation['backbone'], 'score': evaluation['score']},
        'score_breakdown': evaluation.get('breakdown', []),
        'pipelines': [
            {
                'name': p['name'],
                'nodes': p['nodes'],
                'complexity': p['complexity'],
                'has_agent': p['has_agent'],
                'called': p['called'],
                'first_commit': p.get('first_commit'),
                'call_sites': [f'{s["file"]}:{s["line"]}' for s in p.get('call_sites', [])],
            }
            for p in evaluation.get('pipelines', [])
        ],
        'sdk': evaluation.get('sdk', {}),
        'other_platforms': evaluation.get('other_platforms', []),
        'event_window': evaluation.get('event_window'),
        'reused_pipelines': evaluation.get('reused_pipelines', []),
    }
    if evaluation.get('platform'):
        payload['platform_evidence'] = evaluation['platform']
    readme_block = (
        f'\n\nREADME EXCERPT (for project_name / team_members / description only):\n{readme_head[:2500]}'
        if readme_head
        else ''
    )
    # retarget display-name mentions only - "rocketride_usage" (the JSON wire key) is lowercase
    # and therefore untouched by this case-sensitive replace
    base = EXPLAIN_PROMPT if target_name == 'RocketRide' else EXPLAIN_PROMPT.replace('RocketRide', target_name)
    return (
        base
        + f'\n\nPROJECT: {project}\nREPO: {repo}\n'
        + 'TEAM FEEDBACK (context only - the verdict is already fixed from code): '
        + f'{feedback or "(none provided)"}\n\nDETERMINISTIC EVALUATION (do not change the verdict):\n'
        + json.dumps(payload, indent=2)
        + readme_block
    )


def evidence_lines(ev: dict) -> list:
    """Deterministic, judge-readable evidence bullets built straight from the metrics (no LLM)."""
    lines = []
    win = ev.get('event_window')
    pen = ev.get('history_penalty')
    pen_txt = f'−{pen:g} judge-set penalty' if pen else 'flag only - no deduction'
    if win and ev.get('project_predates'):
        pp = ev['project_predates']
        pp_date = str(pp.get('date', ''))[:10]
        early = str(ev.get('earliest_commit', ''))[:10]
        earliest = min(d for d in (pp_date, early) if d) if (pp_date or early) else '?'
        lines.append(
            f'⚠ FLAGGED - project history predates the event window '
            f'{win["start"]}..{win["end"]}: work goes back to {earliest}; latest pre-window '
            f"commit {pp.get('sha', '?')} on {pp_date or '?'} ({pen_txt}; judge's call)"
        )
    if win and ev.get('history_tampered'):
        for t in ev['history_tampered'][:3]:
            lines.append(
                f'⚠ FLAGGED - commit-date rewrite: {t["sha"]} authored '
                f'{str(t["author"])[:10]} but re-stamped {str(t["committer"])[:10]} '
                f"({pen_txt}; judge's call)"
            )
    if win and ev.get('reused_pipelines'):
        for r in ev['reused_pipelines']:
            lines.append(
                f'⚠ REUSED PIPELINE: {r["name"]} first committed '
                f'{str(r.get("first_commit") or "?")[:10]} - BEFORE the event window '
                f'{win["start"]}..{win["end"]} (−1 penalty)'
            )
    for p in ev.get('pipelines', []):
        where = '; '.join(f'{s["file"]}:{s["line"]}' for s in p.get('call_sites', [])[:3])
        status = (
            f'CALLED @ {where}'
            if p['called'] and where
            else 'CALLED'
            if p['called']
            else 'NOT called (present for show)'
        )
        fc = f', first commit {str(p["first_commit"])[:10]}' if p.get('first_commit') else ''
        lines.append(
            f'{p["name"]} - {p["nodes"]} nodes ({p["complexity"]}), '
            f'{"agent" if p["has_agent"] else "no agent"} - {status}{fc}'
        )
    sdk = ev.get('sdk', {})
    lines.append(
        f'SDK: {sdk.get("callsites", 0)} call-site(s) across {sdk.get("file_spread", 0)} '
        f'file(s)' + (', hosted/Cloud usage' if sdk.get('hosted') else '')
    )
    pf = ev.get('platform') or {}
    if pf.get('domains'):
        lines.append('Deployed on target platform: ' + ', '.join(pf['domains'][:3]))
    if pf.get('files'):
        lines.append('Target config/artifacts committed: ' + ', '.join(pf['files'][:3]))
    if pf.get('markers'):
        lines.append('Account/env markers: ' + ', '.join(pf['markers'][:4]))
    if ev.get('other_platforms'):
        lines.append('Other platforms in code: ' + ', '.join(ev['other_platforms']))
    return lines


def det_note(ev: dict) -> str:
    note = (
        f'Deterministic score {ev["score"]} -> {ev["tag"]} / backbone {ev["backbone"]}; '
        f'{ev["pipelines_called"]}/{ev["pipelines_total"]} pipeline(s) called.'
    )
    pen = ev.get('history_penalty')
    pen_txt = f'−{pen:g}' if pen else 'flag only'
    if ev.get('project_predates'):
        pp_date = str(ev['project_predates'].get('date', ''))[:10]
        early = str(ev.get('earliest_commit', ''))[:10]
        earliest = min(d for d in (pp_date, early) if d) if (pp_date or early) else '?'
        note += (
            f' ⚠ FLAGGED: project history predates the event window (work goes back to '
            f"{earliest}; {pen_txt}, judge's call)."
        )
    if ev.get('history_tampered'):
        t0 = ev['history_tampered'][0]
        note += (
            f' ⚠ FLAGGED: commit-date rewrite detected ({t0["sha"]}: authored '
            f'{str(t0["author"])[:10]}, re-stamped {str(t0["committer"])[:10]}; {pen_txt}, '
            f"judge's call)."
        )
    if ev.get('reused_pipelines'):
        names = ', '.join(r['name'] for r in ev['reused_pipelines'][:3])
        note += f' ⚠ REUSED PIPELINE(S) predating the event window: {names} (−1).'
    return note


# ---------------------------------------------------------------- gather (network; `gh` injected)
def gather(
    url: str, gh, event_date: str | None = None, history_penalty: float | None = None, target: Target | None = None
) -> dict:
    """Fetch a repo into an `evidence` dict. `gh(url) -> (status, text)`.
    When `event_date` (YYYY-MM-DD) is given, each pipeline's first-commit date is fetched so
    evaluate() can flag pre-existing (reused) pipelines against the event ± grace-day window.
    `history_penalty` is the judge-set deduction for project-predates / tampered-history flags
    (None -> DEFAULT_HISTORY_PENALTY; 0 = flag only). `target=None` / the preset = legacy
    RocketRide gathering; other targets use the target-agnostic generic gatherer.
    """
    if target is not None and not target.pipeline_scoring:
        return _gather_generic(url, gh, event_date, history_penalty, target)
    from . import fetch as rb  # lazy: reuse repo helpers/constants without a hard import cycle

    pr = rb.parse_repo(url)
    if not pr:
        return {'accessible': False, 'note': 'URL not parseable'}
    owner, repo = pr
    st, body = gh(f'https://api.github.com/repos/{owner}/{repo}')
    if st != 200:
        return {'accessible': False, 'status': st}
    meta = json.loads(body)
    branch = meta.get('default_branch', 'main')
    created_at = meta.get('created_at', '')
    st, tbody = gh(f'https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1')
    if st != 200:
        return {'accessible': True, 'fetch_incomplete': True, 'note': f'tree fetch failed (HTTP {st})'}
    paths = [x.get('path', '') for x in json.loads(tbody).get('tree', [])]

    fetch_fails = [0]

    def raw(p):
        st_f, body_f = gh(f'https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{p}')
        if st_f != 200:
            fetch_fails[0] += 1
            return ''
        return body_f

    pipes = [{'path': pp, 'metrics': parse_pipe(raw(pp))} for pp in [p for p in paths if p.endswith('.pipe')][:12]]
    # pipelines committed as .json (canvas "export as JSON" / reference copies), not config files
    for jp in [p for p in paths if p.endswith('.json') and _JSON_PIPE_PATH.search(p) and not _JSON_CONFIG.search(p)][
        :6
    ]:
        m = parse_pipe(raw(jp))
        if _looks_like_pipeline(m):
            pipes.append({'path': jp, 'metrics': m})

    dependency, others = False, set()
    manifest_texts = []
    for mf in [p for p in paths if _MANIFEST.search(p)][:8]:
        txt = raw(mf)
        manifest_texts.append(txt)
        if re.search(r'rocketride|@rocketride/sdk', txt, re.I):
            dependency = True
        others.update(o for o in rb.OTHER_PLATFORMS if o in txt.lower())

    src = [p for p in paths if _SRC_EXT.search(p)]
    rr = [p for p in src if 'rocketride' in p.lower()]  # RR in the path - strongest signal
    kw = [p for p in src if p not in rr and _SRC_HINT.search(p)]
    rest = [p for p in src if p not in rr and p not in kw]
    source_files = []
    for cf in (rr + kw + rest)[:40]:
        txt = raw(cf)
        source_files.append({'path': cf, 'text': txt})
        others.update(o for o in rb.OTHER_PLATFORMS if o in txt.lower())

    # an in-code pipeline handed to client.use({ pipeline: … }) - the committed .json is its
    # definition/mirror, so it counts as called even if its filename never appears in the code.
    inline_site = _first_site(source_files, _INLINE_PIPE, 'client.use({ pipeline: … }) - in-code pipeline')
    # a generic runner - client.use(filepath=<variable>) - runs pipes whose names never appear next
    # to the call (loaded dynamically / generated at runtime). Its pipes count as called-via-runner.
    runner_site = _first_site(source_files, _RUNNER, 'client.use(filepath=<variable>) - pipes run via a generic runner')
    for pe in pipes:
        called, sites = pipe_called(pe['path'], source_files)
        if not called and pe['path'].endswith('.json') and inline_site:
            called, sites = True, [inline_site]
        if not called and runner_site:
            called, sites = True, [runner_site]
        pe['called'], pe['call_sites'] = called, sites

    # commit-history freshness (only when an event date was provided - one API call per pipe):
    # earliest commit touching the pipe file, taking the older of author/committer date so a
    # rebase can't hide pre-existing work.
    win = event_window(event_date)
    project_predates, tampered, earliest = None, [], ''
    if win:
        from urllib.parse import quote

        for pe in pipes:
            st, cbody = gh(f'https://api.github.com/repos/{owner}/{repo}/commits?path={quote(pe["path"])}&per_page=100')
            first = None
            if st == 200:
                try:
                    commits = json.loads(cbody)
                    if isinstance(commits, list) and commits:
                        c = commits[-1].get('commit', {})  # newest-first → last = earliest
                        dates = [c.get('author', {}).get('date', ''), c.get('committer', {}).get('date', '')]
                        first = min(d for d in dates if d) if any(dates) else None
                except Exception:
                    first = None
            pe['first_commit'] = first
        # WHOLE-PROJECT freshness: the entire project must be built inside the window. If ANY
        # commit exists before the window start, the project predates the event (hard disqualifier).
        st, cbody = gh(f'https://api.github.com/repos/{owner}/{repo}/commits?until={win["start"]}T00:00:00Z&per_page=1')
        if st == 200:
            try:
                lst = json.loads(cbody)
                if isinstance(lst, list) and lst:
                    c = lst[0].get('commit', {})
                    dates = [(c.get('author') or {}).get('date', ''), (c.get('committer') or {}).get('date', '')]
                    d = min((x for x in dates if x), default='')
                    if d:
                        project_predates = {'date': d, 'sha': (lst[0].get('sha') or '')[:7]}
            except Exception:
                project_predates = None
        # TAMPER scan: author-vs-committer date evidence of history rewriting (hard disqualifier)
        st, cbody = gh(f'https://api.github.com/repos/{owner}/{repo}/commits?per_page=100')
        if st == 200:
            try:
                tampered, earliest = history_tamper_scan(json.loads(cbody), win)
            except Exception:
                tampered, earliest = [], ''

    # README - the repo's own title/head, used to label projects better than the repo slug
    readme_title, readme_head = '', ''
    readmes = sorted([p for p in paths if re.fullmatch(r'readme\.(md|rst|txt)', p, re.I)], key=len) or sorted(
        [p for p in paths if p.lower().endswith('/readme.md')], key=len
    )
    if readmes:
        head_lines = raw(readmes[0]).splitlines()[:60]
        readme_head = '\n'.join(head_lines)
        for ln in head_lines:
            if ln.strip().startswith('# '):
                readme_title = ln.strip().lstrip('# ').strip()
                break

    scaffold = any(p.endswith('.claude/rules/rocketride.md') for p in paths)
    if fetch_fails[0]:
        return {
            'accessible': True,
            'fetch_incomplete': True,
            'note': f'{fetch_fails[0]} file fetch(es) failed - evidence would be partial',
        }
    return {
        'accessible': True,
        'file_count': len(paths),
        'tech': detect_tech(paths, manifest_texts, _gh_languages(gh, owner, repo)),
        'dependency': dependency,
        'pipes': pipes,
        'source_files': source_files,
        'other_platforms': sorted(others),
        'scaffold_only': scaffold and not (dependency or pipes),
        'sdk': sdk_metrics(source_files),
        'event_window': win,
        'repo_created_at': created_at,
        'history_penalty': history_penalty,
        'project_predates': project_predates,
        'history_tampered': tampered,
        'earliest_commit': earliest,
        'readme_title': readme_title,
        'readme_head': readme_head,
    }


# ---------------------------------------------------------------- target-agnostic generic path
# Everything below reads ONLY from the Target - no product names in code. Used for every
# target whose config came from the Targets editor (pipeline_scoring=False).


def _gather_generic(url: str, gh, event_date: str | None, history_penalty: float | None, t: Target) -> dict:
    """Fetch a repo into evidence for an arbitrary target: dependency in manifests, invocation
    call-sites, runtime API usage, env/key markers, committed artifacts, deploy-domain links,
    plus the same project-level commit-history integrity checks as the preset path.
    """
    from . import fetch as rb

    pr = rb.parse_repo(url)
    if not pr:
        return {'accessible': False, 'note': 'URL not parseable'}
    owner, repo = pr
    st, body = gh(f'https://api.github.com/repos/{owner}/{repo}')
    if st != 200:
        return {'accessible': False, 'status': st}
    meta = json.loads(body)
    branch = meta.get('default_branch', 'main')
    created_at = meta.get('created_at', '')
    st, tbody = gh(f'https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1')
    if st != 200:
        return {'accessible': True, 'fetch_incomplete': True, 'note': f'tree fetch failed (HTTP {st})'}
    paths = [x.get('path', '') for x in json.loads(tbody).get('tree', [])]

    fetch_fails = [0]

    def raw(p):
        st_f, body_f = gh(f'https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{p}')
        if st_f != 200:
            fetch_fails[0] += 1
            return ''
        return body_f

    # committed artifacts / platform config files - path-substring evidence
    artifact_files = [p for p in paths if any(tok in p.lower() for tok in (t.artifact_paths + t.platform_files))][:12]

    # the global watchlist + this target's competitors, minus the target itself (a target must
    # never count as its own competitor)
    own = {t.slug, t.name.lower()} | set(t.import_hints)
    watch = {
        w
        for w in (set(rb.OTHER_PLATFORMS) | set(t.competitors)) - set(t.neutral)
        if not any(w in o or o in w for o in own)
    }

    dependency, others = False, set()
    manifest_texts = []
    for mf in [p for p in paths if _MANIFEST.search(p)][:8]:
        txt = raw(mf)
        manifest_texts.append(txt)
        if t.dependency_rx and t.dependency_rx.search(txt):
            dependency = True
        others.update(o for o in watch if o in txt.lower())

    src = [p for p in paths if _SRC_EXT.search(p)]
    named = [p for p in src if t.name_in_path_rx and t.name_in_path_rx.search(p)]
    hint = [p for p in src if p not in named and t.src_hint_rx and t.src_hint_rx.search(p)]
    rest = [p for p in src if p not in named and p not in hint]
    source_files, callsites, files_using = [], 0, 0
    hosted = api_used = False
    domain_hits, marker_hits = set(), set()
    for cf in (named + hint + rest)[:40]:
        txt = raw(cf)
        low = txt.lower()
        source_files.append({'path': cf, 'text': txt})
        n = len(t.sdk_call_rx.findall(txt)) if t.sdk_call_rx else 0
        callsites += n
        if n or any(h in low for h in t.import_hints):
            files_using += 1
        if any(tok in low for tok in t.hosted_tokens):
            hosted = True
            marker_hits.update(tok for tok in t.platform_markers if tok in low)
        if any(tok in low for tok in t.engine_tokens):
            api_used = True
        domain_hits.update(d for d in t.platform_domains if d in low)
        others.update(o for o in watch if o in low)

    # README - title/head + deploy-domain / marker evidence
    readme_title, readme_head = '', ''
    readmes = sorted([p for p in paths if re.fullmatch(r'readme\.(md|rst|txt)', p, re.I)], key=len) or sorted(
        [p for p in paths if p.lower().endswith('/readme.md')], key=len
    )
    if readmes:
        head_lines = raw(readmes[0]).splitlines()[:60]
        readme_head = '\n'.join(head_lines)
        for ln in head_lines:
            if ln.strip().startswith('# '):
                readme_title = ln.strip().lstrip('# ').strip()
                break
    rl = readme_head.lower()
    domain_hits.update(d for d in t.platform_domains if d in rl)
    marker_hits.update(m for m in t.platform_markers if m in rl)

    # project-level commit-history integrity (identical logic to the preset path)
    win = event_window(event_date)
    project_predates, tampered, earliest = None, [], ''
    if win:
        st, cbody = gh(f'https://api.github.com/repos/{owner}/{repo}/commits?until={win["start"]}T00:00:00Z&per_page=1')
        if st == 200:
            try:
                lst = json.loads(cbody)
                if isinstance(lst, list) and lst:
                    c = lst[0].get('commit', {})
                    dates = [(c.get('author') or {}).get('date', ''), (c.get('committer') or {}).get('date', '')]
                    d = min((x for x in dates if x), default='')
                    if d:
                        project_predates = {'date': d, 'sha': (lst[0].get('sha') or '')[:7]}
            except Exception:
                project_predates = None
        st, cbody = gh(f'https://api.github.com/repos/{owner}/{repo}/commits?per_page=100')
        if st == 200:
            try:
                tampered, earliest = history_tamper_scan(json.loads(cbody), win)
            except Exception:
                tampered, earliest = [], ''

    if fetch_fails[0]:
        return {
            'accessible': True,
            'fetch_incomplete': True,
            'note': f'{fetch_fails[0]} file fetch(es) failed - evidence would be partial',
        }
    return {
        'accessible': True,
        'file_count': len(paths),
        'tech': detect_tech(paths, manifest_texts, _gh_languages(gh, owner, repo)),
        'dependency': dependency,
        'pipes': [],
        'source_files': source_files,
        'other_platforms': sorted(others),
        'scaffold_only': False,
        'sdk': {'callsites': callsites, 'file_spread': files_using, 'hosted': hosted, 'engine': api_used},
        'platform': {'domains': sorted(domain_hits), 'markers': sorted(marker_hits), 'files': artifact_files},
        'event_window': win,
        'repo_created_at': created_at,
        'history_penalty': history_penalty,
        'project_predates': project_predates,
        'history_tampered': tampered,
        'earliest_commit': earliest,
        'readme_title': readme_title,
        'readme_head': readme_head,
        'target_name': t.name,
    }


def _evaluate_generic(evidence: dict, t: Target) -> dict:
    """Deterministic scoring for an arbitrary target: dependency / invocation depth / runtime
    API usage / env wiring / file spread / committed artifacts / deploy evidence, with the same
    judge-set commit-history flags as the preset path.
    """
    Wt, TH = t.weights, t.thresholds
    if not evidence.get('accessible'):
        return {
            'tag': 'None',
            'backbone': 'No',
            'score': 0.0,
            'pipelines': [],
            'sdk': {},
            'breakdown': [],
            'pipelines_called': 0,
            'reason': 'inaccessible',
        }

    breakdown, score = [], 0.0

    def add(label, pts):
        nonlocal score
        score += pts
        breakdown.append({'signal': label, 'points': pts})

    if evidence.get('dependency'):
        add('dependency in manifest', Wt['dependency'])
    sdk = evidence.get('sdk', {'callsites': 0, 'file_spread': 0, 'hosted': False, 'engine': False})
    cs = sdk.get('callsites', 0)
    if cs >= 3:
        add(f'invocation call-sites ({cs})', Wt['invocation'])
    if cs >= 8:
        add('deep integration (8+ call-sites)', Wt['invocation_deep'])
    if sdk.get('engine'):
        add('runtime API usage', Wt['api_usage'])
    if sdk.get('hosted'):
        add('environment/key wiring', Wt['hosted'])
    if sdk.get('file_spread', 0) >= 2:
        add(f'usage across {sdk["file_spread"]} files', Wt['file_spread'])
    pf = evidence.get('platform') or {}
    if pf.get('files'):
        add(f'target artifact committed: {pf["files"][0]}', Wt['artifact'])
    if pf.get('domains'):
        add('deployed on target platform: ' + ', '.join(pf['domains'][:2]), Wt['platform_deploy'])

    # D5/D6 - the same judge-set event-integrity flags as the preset path
    win = evidence.get('event_window')
    project_predates = evidence.get('project_predates')
    tampered = evidence.get('history_tampered') or []
    pen = evidence.get('history_penalty')
    pen = DEFAULT_HISTORY_PENALTY if pen is None else max(0.0, float(pen))
    if win and project_predates:
        pp_date = str(project_predates.get('date', ''))[:10]
        early = str(evidence.get('earliest_commit', ''))[:10]
        earliest = min(d for d in (pp_date, early) if d) if (pp_date or early) else '?'
        add(
            f'⚠ FLAGGED: project history predates the event window {win["start"]}..{win["end"]} - '
            f'work goes back to {earliest} (latest pre-window commit '
            f'{project_predates.get("sha", "?")} on {pp_date or "?"}); judge-set penalty',
            -pen,
        )
    if win and tampered:
        t0 = tampered[0]
        add(
            f'⚠ FLAGGED: commit-date rewrite detected - {t0["sha"]} authored '
            f'{str(t0["author"])[:10]} but re-stamped {str(t0["committer"])[:10]} into the window; '
            f'judge-set penalty',
            -pen,
        )

    score = max(0.0, round(score, 1))
    # backbone: real usage = code invocation, runtime API calls, or deployed-on-platform with
    # corroborating wiring; a competitor in the codebase demotes primacy to Partial
    real = (
        cs > 0
        or sdk.get('engine')
        or (
            bool(pf.get('domains')) and (bool(pf.get('files')) or bool(pf.get('markers')) or evidence.get('dependency'))
        )
    )
    if not real:
        backbone = 'No'
    elif any(o in t.competitors for o in evidence.get('other_platforms', [])):
        backbone = 'Partial'
    else:
        backbone = 'Yes'

    if evidence.get('overclaim') or not evidence.get('accessible', True):
        tag = 'None'
    elif score >= TH['significant']:
        tag = 'Significant' if backbone in ('Yes', 'Partial') else 'Moderate'
    elif score >= TH['moderate']:
        tag = 'Moderate'
    elif score >= TH['less']:
        tag = 'Less'
    else:
        tag = 'None'
    if tag in ('None', 'Less'):
        backbone = 'No'

    return {
        'tag': tag,
        'backbone': backbone,
        'score': score,
        'pipelines': [],
        'sdk': sdk,
        'breakdown': breakdown,
        'pipelines_called': 0,
        'pipelines_total': 0,
        'other_platforms': evidence.get('other_platforms', []),
        'tech': evidence.get('tech', []),
        'platform': pf,
        'target_name': t.name,
        'event_window': win,
        'history_penalty': pen if win else None,
        'project_predates': project_predates if win else None,
        'history_tampered': tampered if win else [],
        'earliest_commit': evidence.get('earliest_commit', ''),
        'repo_created_at': evidence.get('repo_created_at', ''),
        'reused_pipelines': [],
    }
