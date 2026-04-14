"""
sync_models.py — CLI entry point for LLM model list synchronisation.

Usage
-----
  python tools/src/sync_models.py --provider openai [--apply]
  python tools/src/sync_models.py --provider anthropic [--apply]
  python tools/src/sync_models.py --all [--apply]

Without ``--apply`` the script runs in dry-run mode: it prints what would
change but does not write any files.

Exit codes
----------
  0  — success (even if there are no changes)
  1  — one or more providers failed to fetch/sync
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
from pathlib import Path
from typing import Dict, Any

try:
    from dotenv import load_dotenv

    load_dotenv()  # reads .env from cwd or any parent directory up to the repo root
except ImportError:
    pass  # python-dotenv not installed — rely on shell environment

# Make tools/src importable when running as a script from any CWD
_TOOLS_SRC = Path(__file__).parent
if str(_TOOLS_SRC) not in sys.path:
    sys.path.insert(0, str(_TOOLS_SRC))

from core.merger import _LITELLM_AVAILABLE, _OPENROUTER_AVAILABLE, _load_openrouter_cache
from core.patcher import get_profiles
from core.reporter import SyncReport, format_console, format_pr_body
from providers.base import _active_protected_profiles

try:
    import json5 as _json5
except ImportError:
    _json5 = None  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Provider registry
# ---------------------------------------------------------------------------

# Maps provider name (matching sync_models.config.json key) to the class that
# handles it.  Only cloud providers are registered here (Handler A).
_PROVIDER_REGISTRY: Dict[str, str] = {
    'llm_openai': 'providers.openai:OpenAIProvider',
    'embedding_openai': 'providers.embedding_openai:EmbeddingOpenAIProvider',
    'llm_anthropic': 'providers.anthropic:AnthropicProvider',
    'llm_gemini': 'providers.gemini:GeminiProvider',
    'llm_mistral': 'providers.mistral:MistralProvider',
    'llm_deepseek': 'providers.deepseek:DeepSeekProvider',
    'llm_xai': 'providers.xai:XAIProvider',
    'llm_perplexity': 'providers.perplexity:PerplexityProvider',
    'llm_qwen': 'providers.qwen:QwenProvider',
}

# Maps provider name → relative path to its services.json from the repo root
_SERVICES_JSON_PATHS: Dict[str, str] = {
    'llm_openai': 'nodes/src/nodes/llm_openai/services.json',
    'embedding_openai': 'nodes/src/nodes/embedding_openai/services.json',
    'llm_anthropic': 'nodes/src/nodes/llm_anthropic/services.json',
    'llm_gemini': 'nodes/src/nodes/llm_gemini/services.json',
    'llm_mistral': 'nodes/src/nodes/llm_mistral/services.json',
    'llm_deepseek': 'nodes/src/nodes/llm_deepseek/services.json',
    'llm_xai': 'nodes/src/nodes/llm_xai/services.json',
    'llm_perplexity': 'nodes/src/nodes/llm_perplexity/services.json',
    'llm_qwen': 'nodes/src/nodes/llm_qwen/services.json',
}

# Default extra fields added to every new profile (placeholder for API key)
_DEFAULT_EXTRA_FIELDS: Dict[str, Any] = {'apikey': ''}


def _load_config() -> Dict[str, Any]:
    """
    Load sync_models.config.json from the same directory as this script.

    Returns:
        Parsed config dict

    Raises:
        FileNotFoundError: If the config file is missing
    """
    config_path = _TOOLS_SRC / 'sync_models.config.json'
    if _json5 is not None:
        with open(config_path, 'r', encoding='utf-8') as fh:
            return _json5.load(fh)
    # json5 not installed — fall back to stdlib json (comments will fail)
    with open(config_path, 'r', encoding='utf-8') as fh:
        return json.load(fh)


def _import_provider_class(dotted: str) -> type:
    """
    Import a provider class from a 'module:ClassName' specifier.

    Args:
        dotted: e.g. 'providers.openai:OpenAIProvider'

    Returns:
        The class object
    """
    module_path, class_name = dotted.split(':')
    module = importlib.import_module(module_path)
    return getattr(module, class_name)


def _find_repo_root() -> Path:
    """
    Walk up from the current file to find the repository root.

    The repo root is identified by the presence of a nodes/ directory.

    Returns:
        Path to the repo root

    Raises:
        RuntimeError: If the repo root cannot be found
    """
    candidate = _TOOLS_SRC.parent.parent  # tools/src -> tools -> repo root
    if (candidate / 'nodes').exists():
        return candidate
    # Try CWD as fallback
    cwd = Path.cwd()
    if (cwd / 'nodes').exists():
        return cwd
    raise RuntimeError('Cannot find repo root (expected a nodes/ directory). Run this script from the repository root.')


def sync_provider(
    provider_name: str,
    config: Dict[str, Any],
    repo_root: Path,
    apply: bool,
    litellm_only: bool = False,
    openrouter_only: bool = False,
    use_litellm: bool = True,
    use_openrouter: bool = True,
    use_config_overrides: bool = True,
) -> 'ProviderReport':  # noqa: F821
    """
    Sync a single provider.

    Args:
        provider_name: Key in the registry / config (e.g. 'llm_openai')
        config: Full parsed sync_models.config.json
        repo_root: Absolute path to the repository root
        apply: If True, write changes to disk; otherwise dry-run

    Returns:
        ProviderReport
    """
    from core.reporter import ProviderReport

    provider_config = config['providers'].get(provider_name)
    if provider_config is None:
        r = ProviderReport(provider=provider_name)
        r.error = 'No config entry found in sync_models.config.json'
        return r

    services_rel = _SERVICES_JSON_PATHS.get(provider_name)
    if services_rel is None:
        r = ProviderReport(provider=provider_name)
        r.error = 'No services.json path registered for this provider'
        return r

    services_path = repo_root / services_rel
    if not services_path.exists():
        r = ProviderReport(provider=provider_name)
        r.error = f'services.json not found: {services_path}'
        return r

    class_spec = _PROVIDER_REGISTRY.get(provider_name)
    if class_spec is None:
        r = ProviderReport(provider=provider_name)
        r.error = 'No handler registered for provider'
        return r

    try:
        ProviderClass = _import_provider_class(class_spec)
    except Exception as e:
        r = ProviderReport(provider=provider_name)
        r.error = f'Failed to import handler: {e}'
        return r

    provider = ProviderClass(provider_config)

    try:
        current_profiles = get_profiles(str(services_path))
    except Exception as e:
        r = ProviderReport(provider=provider_name)
        r.error = f'Failed to read current profiles: {e}'
        return r

    title_mappings = config.get('title_mappings', {})
    output_token_overrides = config.get('model_output_tokens', {}).get('overrides', {})
    output_defaults = config.get('model_output_tokens', {}).get('defaults', {})
    default_output_tokens = output_defaults.get('embedding', 0) if provider_name.startswith('embedding_') else output_defaults.get('chat', 4096)
    global_protected = list(_active_protected_profiles(config.get('default_protected_profiles', [])))

    return provider.sync(
        current_profiles=current_profiles,
        title_mappings=title_mappings,
        output_token_overrides=output_token_overrides,
        default_output_tokens=default_output_tokens,
        extra_profile_fields=_DEFAULT_EXTRA_FIELDS,
        apply=apply,
        services_json_path=str(services_path),
        litellm_only=litellm_only,
        openrouter_only=openrouter_only,
        use_litellm=use_litellm,
        use_openrouter=use_openrouter,
        use_config_overrides=use_config_overrides,
        global_protected_profiles=global_protected,
    )


def main() -> int:
    """
    CLI entry point.

    Returns:
        Exit code (0 = success, 1 = one or more errors)
    """
    parser = argparse.ArgumentParser(
        description='Sync LLM model lists from provider APIs into services.json files.',
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        '--provider',
        choices=sorted(_PROVIDER_REGISTRY.keys()),
        action='append',
        dest='providers',
        metavar='PROVIDER',
        help='Sync one or more providers (repeat to specify multiple)',
    )
    group.add_argument(
        '--all',
        action='store_true',
        help='Sync all registered providers',
    )
    parser.add_argument(
        '--apply',
        action='store_true',
        default=False,
        help='Write changes to disk. Without this flag the script runs in dry-run mode.',
    )
    parser.add_argument(
        '--pr-body',
        action='store_true',
        default=False,
        help='Output a GitHub PR body in markdown format (for CI/CD use)',
    )
    parser.add_argument(
        '--litellm-only',
        action='store_true',
        default=False,
        help=('Use LiteLLM database as the sole model source — no provider API calls, no smoke tests, no API key required. Exits with an error if litellm is not installed.'),
    )
    parser.add_argument(
        '--no-litellm',
        action='store_true',
        default=False,
        help='Disable LiteLLM entirely — token limits come only from provider APIs, OpenRouter, and config overrides.',
    )
    parser.add_argument(
        '--no-openrouter',
        action='store_true',
        default=False,
        help='Disable OpenRouter fallback — token limits come only from provider APIs, LiteLLM, and config overrides.',
    )
    parser.add_argument(
        '--openrouter-only',
        action='store_true',
        default=False,
        help=('Use OpenRouter as the sole model source — no provider API calls, no smoke tests, no API key required.'),
    )
    parser.add_argument(
        '--no-config-overrides',
        action='store_true',
        default=False,
        help=('Ignore token_limit_overrides and model_output_tokens.overrides from sync_models.config.json. Token limits come entirely from live data sources (provider API, OpenRouter, LiteLLM).'),
    )
    args = parser.parse_args()

    if args.litellm_only and args.no_litellm:
        print(
            'ERROR: --litellm-only and --no-litellm are mutually exclusive.',
            file=sys.stderr,
        )
        return 1

    if args.openrouter_only and args.no_openrouter:
        print(
            'ERROR: --openrouter-only and --no-openrouter are mutually exclusive.',
            file=sys.stderr,
        )
        return 1

    if args.openrouter_only and args.litellm_only:
        print(
            'ERROR: --openrouter-only and --litellm-only are mutually exclusive.',
            file=sys.stderr,
        )
        return 1

    if args.litellm_only:
        if not _LITELLM_AVAILABLE:
            print(
                'ERROR: --litellm-only requires litellm to be installed.\n       Run: pip install litellm',
                file=sys.stderr,
            )
            return 1

    try:
        config = _load_config()
    except Exception as e:
        print(f'ERROR: Failed to load config: {e}', file=sys.stderr)
        return 1

    try:
        repo_root = _find_repo_root()
    except RuntimeError as e:
        print(f'ERROR: {e}', file=sys.stderr)
        return 1

    providers_config = config.get('providers', {})
    providers_to_sync = sorted(k for k in _PROVIDER_REGISTRY if providers_config.get(k, {}).get('enabled', True) is not False) if args.all else args.providers

    use_openrouter = not args.no_openrouter and not args.litellm_only

    # Pre-load OpenRouter cache once before the provider loop so the header
    # status is accurate and all per-model lookups hit the in-memory dict.
    if use_openrouter or args.openrouter_only:
        _load_openrouter_cache()

    report = SyncReport(
        dry_run=not args.apply,
        litellm_available=_LITELLM_AVAILABLE,
        openrouter_available=_OPENROUTER_AVAILABLE,
    )

    for provider_name in providers_to_sync:
        pr = sync_provider(
            provider_name=provider_name,
            config=config,
            repo_root=repo_root,
            apply=args.apply,
            litellm_only=args.litellm_only,
            openrouter_only=args.openrouter_only,
            use_litellm=not args.no_litellm,
            use_openrouter=use_openrouter,
            use_config_overrides=not args.no_config_overrides,
        )
        report.add(pr)

    if args.pr_body:
        print(format_pr_body(report))
        # Also write to GITHUB_ENV for the CI workflow
        github_env = os.environ.get('GITHUB_ENV')
        if github_env:
            with open(github_env, 'a', encoding='utf-8') as fh:
                body = format_pr_body(report)
                fh.write(f'SYNC_OUTPUT<<EOF\n{body}\nEOF\n')
    else:
        print(format_console(report))

    # Exit 1 if any provider had an error
    if any(p.error for p in report.providers):
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
