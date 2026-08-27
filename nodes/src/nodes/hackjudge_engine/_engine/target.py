"""TargetConfig - the product being verified, as data.

The engine is purely target-agnostic: every check reads from a Target. Two construction
paths:

  • Target.from_preset(dict)  - trusted JSON (eval/targets/*.json) carrying explicit regex
    sources. The bundled RocketRide preset reproduces the historical constants verbatim,
    which is what guarantees fixture parity.
  • Target.from_ui_config(name, dict) - an end user's saved target (free-text fields from
    the Targets editor). Tokens are treated as LITERALS (regex-escaped); matching is
    case-insensitive substring/alternation. No user input is ever compiled as raw regex.

Nothing about any specific product (Butterbase, Supabase, ...) lives in code - only in
config. `pipeline_scoring` selects the artifact-graph scoring path (RocketRide pipelines);
generic targets score on dependency / invocation depth / API usage / platform evidence.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

_TARGETS_DIR = Path(__file__).resolve().parent / 'targets'

# generic-path weights (used when pipeline_scoring is off). Chosen so a genuinely
# integrated product reaches Significant (>= 4.0) and a passing mention stays None/Less.
GENERIC_WEIGHTS = {
    'dependency': 1.0,  # the target's package in a manifest
    'invocation': 1.5,  # >=3 invocation/call sites in code
    'invocation_deep': 1.0,  # >=8 call sites - deep integration
    'api_usage': 1.5,  # real runtime calls to the target's API hosts
    'hosted': 0.5,  # env markers / keys wiring the target in
    'file_spread': 0.5,  # >=2 distinct files touch the target
    'artifact': 1.0,  # a target-specific config file/dir committed
    'platform_deploy': 1.5,  # deployed on the target's domains (link in code/README)
    'predates_penalty': 1.0,
    'uncalled_penalty': 1.0,
}
GENERIC_THRESHOLDS = {'significant': 4.0, 'moderate': 2.0, 'less': 1.0}


def _split_tokens(text: str | None) -> list[str]:
    """Free-text field -> clean literal tokens. Splits on commas and pipes, strips
    parenthetical hints and glob stars, drops empties and one-char noise.
    """
    out = []
    for raw in re.split(r'[|,\n]', text or ''):
        tok = re.sub(r'\([^)]*\)', '', raw).strip().strip('*').strip()
        if len(tok) >= 2:
            out.append(tok)
    return out


def _alt_regex(tokens: list[str]) -> re.Pattern | None:
    if not tokens:
        return None
    return re.compile('|'.join(re.escape(t) for t in tokens), re.I)


def _num_map(overrides: dict | None, defaults: dict) -> dict:
    """Merge user-tuned rubric numbers over the defaults. Values arrive as strings from
    the editor; anything unparseable or negative falls back to the default for that key,
    and unknown keys are ignored (the engine only reads known signals).
    """
    out = dict(defaults)
    for k, v in (overrides or {}).items():
        if k in out:
            try:
                f = float(v)
                if f >= 0:
                    out[k] = f
            except (TypeError, ValueError):
                pass
    return out


@dataclass
class Target:
    slug: str
    name: str
    types: list = field(default_factory=lambda: ['code'])
    pipeline_scoring: bool = False
    # compiled matchers (regex for presets, escaped-literal alternations for user targets)
    sdk_call_rx: re.Pattern | None = None
    dependency_rx: re.Pattern | None = None
    inline_pipe_rx: re.Pattern | None = None
    runner_rx: re.Pattern | None = None
    http_rx: re.Pattern | None = None
    hosted_env_rx: re.Pattern | None = None
    src_hint_rx: re.Pattern | None = None
    name_in_path_rx: re.Pattern | None = None
    # lowercase substring tokens
    invoke_tokens: tuple = ()
    import_hints: tuple = ()
    hosted_tokens: tuple = ()
    engine_tokens: tuple = ()
    # artifacts
    artifact_extensions: tuple = ()
    json_pipelines: bool = False
    artifact_paths: tuple = ()  # generic: path substrings that prove usage
    # platform evidence
    platform_domains: tuple = ()
    platform_files: tuple = ()
    platform_markers: tuple = ()
    competitors: frozenset = frozenset()
    neutral: frozenset = frozenset()
    scaffold_paths: tuple = ()
    weights: dict = field(default_factory=dict)
    thresholds: dict = field(default_factory=dict)

    # ---- construction ----
    @classmethod
    def from_preset(cls, cfg: dict) -> 'Target':
        rx = cfg.get('regex', {})
        tk = cfg.get('tokens', {})
        pf = cfg.get('platform', {})
        c = lambda k: re.compile(rx[k], re.I) if rx.get(k) else None  # noqa: E731
        return cls(
            slug=cfg['slug'],
            name=cfg['name'],
            types=cfg.get('types', ['code']),
            pipeline_scoring=bool(cfg.get('pipeline_scoring')),
            sdk_call_rx=c('sdk_call'),
            dependency_rx=c('dependency'),
            inline_pipe_rx=c('inline_pipe'),
            runner_rx=c('runner'),
            http_rx=c('http'),
            hosted_env_rx=c('hosted_env'),
            src_hint_rx=c('src_hint'),
            name_in_path_rx=c('name_in_path'),
            invoke_tokens=tuple(t.lower() for t in tk.get('invoke', [])),
            import_hints=tuple(t.lower() for t in tk.get('import_hints', [])),
            hosted_tokens=tuple(t.lower() for t in tk.get('hosted', [])),
            engine_tokens=tuple(t.lower() for t in tk.get('engine', [])),
            artifact_extensions=tuple(cfg.get('artifact_extensions', [])),
            json_pipelines=bool(cfg.get('json_pipelines')),
            platform_domains=tuple(t.lower() for t in pf.get('domains', [])),
            platform_files=tuple(t.lower() for t in pf.get('files', [])),
            platform_markers=tuple(t.lower() for t in pf.get('markers', [])),
            competitors=frozenset(t.lower() for t in cfg.get('competitors', [])),
            scaffold_paths=tuple(cfg.get('scaffold_paths', [])),
            weights=dict(cfg.get('weights', {})),
            thresholds=dict(cfg.get('thresholds', {})),
        )

    @classmethod
    def from_ui_config(cls, name: str, cfg: dict) -> 'Target':
        """Build from the Targets editor's free-text fields (all literals, never raw regex)."""
        deps = _split_tokens(cfg.get('dependency_names'))
        invoc = _split_tokens(cfg.get('invocation'))
        hosted = _split_tokens(cfg.get('hosted_markers'))
        cli = _split_tokens(cfg.get('cli_verbs'))
        arts = _split_tokens(cfg.get('artifacts'))
        domains = [t.lstrip('*.').lower() for t in _split_tokens(cfg.get('platform_domains'))]
        pfiles = _split_tokens(cfg.get('platform_files'))
        markers = _split_tokens(cfg.get('platform_markers'))
        slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-') or 'target'
        # API-host-looking tokens (contain a dot) among invocation/hosted markers count as
        # runtime-call evidence; the rest of hosted_markers are env/key wiring.
        hosts = [t.lower() for t in (invoc + hosted) if '.' in t and ' ' not in t]
        return cls(
            slug=slug,
            name=name,
            types=list(cfg.get('types') or ['code']),
            pipeline_scoring=False,
            sdk_call_rx=_alt_regex(invoc + cli),
            dependency_rx=_alt_regex(deps),
            src_hint_rx=_alt_regex(
                [name] + deps + ['api', 'client', 'server', 'main', 'index', 'app', 'config', 'lib']
            ),
            name_in_path_rx=_alt_regex([name] + deps),
            invoke_tokens=tuple(t.lower() for t in invoc + cli),
            import_hints=tuple(t.lower() for t in deps),
            hosted_tokens=tuple(t.lower() for t in hosted + markers),
            engine_tokens=tuple(dict.fromkeys(hosts + domains)),
            artifact_paths=tuple(t.lower() for t in arts + pfiles),
            platform_domains=tuple(dict.fromkeys(domains)),
            platform_files=tuple(t.lower() for t in pfiles),
            platform_markers=tuple(t.lower() for t in markers + hosted),
            competitors=frozenset(t.lower() for t in _split_tokens(cfg.get('competitors'))),
            neutral=frozenset(t.lower() for t in _split_tokens(cfg.get('neutral'))),
            weights=_num_map(cfg.get('weights'), GENERIC_WEIGHTS),
            thresholds=_num_map(cfg.get('thresholds'), GENERIC_THRESHOLDS),
        )


def load_preset(slug: str = 'rocketride') -> Target:
    return Target.from_preset(json.loads((_TARGETS_DIR / f'{slug}.json').read_text(encoding='utf-8')))
