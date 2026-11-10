# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

import os
import uuid
from functools import lru_cache
from pathlib import Path
from typing import List, Dict, Any, Optional
from .discovery import NodeTestConfig, get_node_test_config, _parse_service_json

# Maps ROCKETRIDE_<PROVIDER>_<ATTR> attribute names to config field names.
# Used by _parse_credential_env_var() to derive credentials from env var names.
_ENV_ATTR_MAP = {
    'SECRET_KEY': 'secretKey',
    'ACCESS_KEY': 'accessKey',
    'APIKEY': 'apikey',
    'KEY': 'apikey',
    'KEY_ID': 'apiKeyId',
    'KEY_SECRET': 'apiKeySecret',
    'REGION': 'region',
    'HOST': 'host',
    'PORT': 'port',
}


def _parse_credential_env_var(env_var: str, provider: str) -> Optional[str]:
    """Resolve a `requires` env var name to a node config field name.

    Algorithm
    ---------
    The env var must follow ``ROCKETRIDE_<PROVIDER>_<ATTR>``:

    1. Verify the ``ROCKETRIDE_`` prefix.
    2. Match the next segment against ``provider`` (case-insensitive),
       accepting either the full directory name (``LLM_OPENAI``) or the
       short form with ``llm_``/``tool_`` stripped (``OPENAI``). Strict
       match — this catches typos and cross-provider pollution where a
       services.json lists an env var for the wrong node.
    3. Whatever remains is ``<ATTR>``. Look it up in ``_ENV_ATTR_MAP``
       for known tokens (``KEY`` → ``apikey``, ``SECRET_KEY`` →
       ``secretKey``); otherwise fall back to ``attr.lower()``
       (e.g. ``SERVERBASE`` → ``serverbase``).

    Examples (provider='llm_openai'):
        ROCKETRIDE_OPENAI_KEY         → 'apikey'
        ROCKETRIDE_LLM_OPENAI_KEY     → 'apikey'   (full form also OK)
        ROCKETRIDE_ANTHROPIC_KEY      → None       (wrong provider)

    Examples (provider='llm_gmi_cloud'):
        ROCKETRIDE_GMI_CLOUD_KEY           → 'apikey'
        ROCKETRIDE_LLM_GMI_CLOUD_SECRET_KEY → 'secretKey'
        ROCKETRIDE_GMICLOUD_KEY            → None       (missing underscore)

    Possible issues
    ---------------
    * Hidden prefix-stripping rule: a hypothetical directory named
      ``tool_xyz`` that isn't semantically a tool node would still have
      ``tool_`` stripped. Today every ``llm_*``/``tool_*`` directory is
      a real LLM/tool node, so this doesn't bite in practice.
    * Provider whose short name collides with an ATTR token (e.g. a
      pathological provider ``llm_key``): the strict provider check
      still fires first, so ``ROCKETRIDE_KEY_REGION`` for that provider
      parses to ``region``. No real provider triggers this.
    * Returns ``None`` for structural mismatches (wrong prefix, wrong
      provider, empty attr). Callers must treat ``None`` as a
      services.json ``requires`` bug — NOT as "env var missing in the
      environment", which is detected separately via
      ``os.environ.get(env_var)``.
    """
    if not env_var.startswith('ROCKETRIDE_'):
        return None
    suffix = env_var[len('ROCKETRIDE_') :]  # e.g. 'OPENAI_KEY'

    # Accept both full provider name ('LLM_OPENAI') and short form
    # ('OPENAI'). Full form is tried first so that an exact directory
    # name always wins over the prefix-stripped form.
    candidates = [provider.upper()]
    for pfx in ('llm_', 'tool_'):
        if provider.startswith(pfx):
            candidates.append(provider[len(pfx) :].upper())
            break

    suffix_upper = suffix.upper()
    for candidate in candidates:
        token = candidate + '_'
        if suffix_upper.startswith(token):
            attr = suffix[len(token) :]
            if not attr:
                return None
            return _ENV_ATTR_MAP.get(attr.upper(), attr.lower())

    return None


# Placeholder credentials for LLM nodes when ROCKETRIDE_MOCK is set (mocks handle requests)
# apikey: format must pass each provider's validation (sk-ant, xai-, sk-, AI..., etc.)
# Bedrock uses accessKey/secretKey; Vertex uses GCP service account (not covered here)
_LLM_MOCK_CREDENTIALS = {
    'llm_anthropic': {'apikey': 'sk-ant-mock-placeholder-for-tests'},
    'llm_xai': {'apikey': 'xai-mock-placeholder-for-tests'},
    'llm_openai': {'apikey': 'sk-mock-placeholder-for-tests'},
    'llm_perplexity': {'apikey': 'sk-mock-placeholder-for-tests'},
    'llm_deepseek': {'apikey': 'sk-mock-placeholder-for-tests'},
    'llm_mistral': {'apikey': 'mock-mistral-placeholder-for-tests'},
    'llm_vision_mistral': {'apikey': 'mock-mistral-placeholder-for-tests'},
    'llm_gemini': {'apikey': 'AIza-mock-placeholder-for-tests'},
    'accessibility_describe': {'apikey': 'AIza-mock-placeholder-for-tests'},
    'llm_ibm_watson': {'apikey': 'mock-watson-placeholder-for-tests'},
    'llm_bedrock': {'accessKey': 'mock-access-key', 'secretKey': 'mock-secret-key', 'region': 'us-east-1'},
    'llm_openai_api': {'apikey': 'sk-mock-placeholder-for-tests', 'model': 'mock-model'},
    'llm_gmi_cloud': {'apikey': 'sk-mock-placeholder-for-tests'},
    'llm_qwen': {'apikey': 'sk-mock-placeholder-for-tests'},
    'llm_minimax': {'apikey': 'sk-mock-placeholder-for-tests'},
    'llm_baidu_qianfan': {'apikey': 'mock-baidu-qianfan-placeholder-for-tests'},
    'llm_glm': {'apikey': 'mock-glm-placeholder-for-tests'},
    'llm_vision_ollama': {'apikey': 'sk-mock-placeholder-for-tests'},
    'rerank_cohere': {'apikey': 'mock-cohere-placeholder-for-tests'},
    'tool_apify': {'apikey': 'mock-apify-placeholder-for-tests'},
    'tool_daytona': {'apikey': 'mock-daytona-placeholder-for-tests'},
    'tool_exa_search': {'apikey': 'mock-exa-search-placeholder-for-tests'},
    'tool_tavily': {'apikey': 'mock-tavily-placeholder-for-tests'},
    'tool_crustdata': {'apikey': 'mock-crustdata-placeholder-for-tests'},
    'tool_deepl': {'apikey': 'mock-deepl-placeholder-for-tests'},
    'tool_slack': {'token': 'xoxb-mock-placeholder-for-tests'},
    'tool_notion': {'apikey': 'secret_mock-notion-placeholder-for-tests'},
    'tool_tenki': {'apikey': 'tk_mock-tenki-placeholder-for-tests'},
}


# =============================================================================
# Converted-node config shape (plan section 5.6.2)
#
# A converted node stores its config as a tree addressed by the engine's leaf
# paths: a selector's own value at its path, a branch's values under the branch
# VALUE, a leaf referenced by the identical specifier in every branch hoisted to
# the parent, everything else flat. SchemaPaths derives those paths from the raw
# definition the same way the engine does, so the builder can place a profile
# and the mock credentials where the resolver expects them.
# =============================================================================

_CORE_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'core'


@lru_cache(maxsize=None)
def _global_definitions() -> Dict[str, Any]:
    """The shared ``propertyDefinitions`` every node may reference (``core/services.common*.json``)."""
    definitions: Dict[str, Any] = {}
    for path in sorted(_CORE_DIR.glob('services.common*.json')):
        data = _parse_service_json(str(path)) or {}
        definitions.update(data.get('propertyDefinitions') or {})
    return definitions


def _set_path(config: Dict[str, Any], path: str, value: Any) -> None:
    """Store ``value`` at dotted ``path`` inside ``config``, creating the groups on the way."""
    target = config
    *groups, leaf = path.split('.')
    for group in groups:
        target = target.setdefault(group, {})
    target[leaf] = value


class SchemaPaths:
    """Where a converted node stores each config leaf (the engine's ``path`` rule, plan section 5.6.1).

    Attributes:
        leaves: short name -> the paths it resolves at: one per branch when the
            definition is branch-specific, a single hoisted path when it is shared.
        selectors: selector path -> its branch values, in declaration order.
        defaults: path -> the leaf's declared default (constants included).
    """

    def __init__(self, property_definitions: Dict[str, Any], properties: List[Any]):
        """Walk ``properties`` against the local and shared definitions.

        Args:
            property_definitions: The node's own ``propertyDefinitions``.
            properties: The node's ordered ``properties`` list.
        """
        self.leaves: Dict[str, List[str]] = {}
        self.selectors: Dict[str, List[str]] = {}
        self.defaults: Dict[str, Any] = {}
        self._local = property_definitions or {}
        self._walk(properties or [], '')

    def _lookup(self, name: str) -> Dict[str, Any]:
        """A definition by name; the node's own wins over a shared one, unknown is empty."""
        return self._local.get(name) or _global_definitions().get(name) or {}

    def _expand(self, specifier: Any) -> Dict[str, Any]:
        """Resolve one property specifier, following ``base`` aliases; the name shortens to its last dotted segment."""
        if isinstance(specifier, str):
            name, field = specifier, dict(self._lookup(specifier))
        elif isinstance(specifier, dict) and 'base' in specifier:
            name = specifier['base']
            field = {**self._lookup(name), **{key: value for key, value in specifier.items() if key != 'base'}}
        elif isinstance(specifier, dict):
            name, field = specifier.get('name', ''), dict(specifier)
        else:
            return {}
        followed = set()
        while 'base' in field and field['base'] not in followed:
            alias = field.pop('base')
            followed.add(alias)
            field = {**self._lookup(alias), **field}
        field.setdefault('name', name)
        field['name'] = str(field['name']).rsplit('.', 1)[-1]
        return field

    def _walk(self, specifiers: List[Any], prefix: str) -> None:
        """Record the leaves and selectors of one level; branches recurse at ``prefix + value``."""
        for specifier in specifiers:
            field = self._expand(specifier)
            name = field.get('name')
            if not name:
                continue
            enum = field.get('enum')
            path = f'{prefix}{name}'
            if isinstance(field.get('properties'), list) and not isinstance(enum, dict):
                self._walk(field['properties'], f'{path}.')
                continue
            if path not in self.leaves.setdefault(name, []):
                self.leaves[name].append(path)
            if 'default' in field:
                self.defaults[path] = field['default']
            if isinstance(enum, dict):
                self.selectors[path] = list(enum)
                bodies = [body.get('properties') or [] for body in enum.values() if isinstance(body, dict)]
                hoisted = [spec for spec in bodies[0] if all(spec in other for other in bodies[1:])] if bodies else []
                self._walk(hoisted, prefix)
                for value, body in enum.items():
                    if isinstance(body, dict):
                        branch = [spec for spec in (body.get('properties') or []) if spec not in hoisted]
                        self._walk(branch, f'{prefix}{value}.')

    def selector_for(self, value: Optional[str]) -> Optional[str]:
        """The root-level selector that has ``value`` as a branch, or None."""
        for path, branches in self.selectors.items():
            if '.' not in path and value in branches:
                return path
        return None

    def path_for(self, name: str, branch: Optional[str]) -> Optional[str]:
        """The path short name ``name`` resolves at with ``branch`` selected, or None when undeclared."""
        candidates = self.leaves.get(name) or []
        for path in candidates:
            if '.' not in path or (branch and path.startswith(f'{branch}.')):
                return path
        return candidates[0] if candidates else None

    def profile_values(self, profile: Optional[str]) -> Dict[str, Any]:
        """Short name -> declared default for every leaf reachable with ``profile`` selected.

        The stand-in for the old ``preconfig.profiles[<name>]`` object: root leaves,
        the selected branch's leaves (constants included) and the selector itself.

        Args:
            profile: The branch value, or None for the selector's default.
        """
        selector = self.selector_for(profile) if profile else None
        if selector is None:
            selector = next((path for path in self.selectors if '.' not in path), None)
            profile = self.defaults.get(selector) if selector else None
        values: Dict[str, Any] = {}
        for name in self.leaves:
            path = self.path_for(name, profile)
            if path is not None and path in self.defaults:
                values[name] = self.defaults[path]
        if selector and profile is not None:
            values[selector] = profile
        return values


class PipelineBuilder:
    """
    Builds test pipelines for node testing.

    Creates pipelines in the form:
        webhook → [chain nodes] → [node under test] → [chain nodes] → response(s)

    With control nodes attached to the node under test.
    """

    def __init__(self, config: NodeTestConfig, profile: Optional[str] = None):
        """
        Initialize the pipeline builder.

        Args:
            config: The node test configuration
            profile: Optional profile name to use (from preconfig.profiles)
        """
        self.config = config
        self.profile = profile
        self._component_counter = 0

    def _next_id(self, prefix: str) -> str:
        """Generate a unique component ID."""
        self._component_counter += 1
        return f'{prefix}_{self._component_counter}'

    def _get_node_config(self, provider: str, profile: Optional[str] = None) -> Dict[str, Any]:
        """
        Get configuration for a node, optionally with a profile.

        Args:
            provider: The node provider name
            profile: Optional profile name

        Returns:
            Configuration dict for the node
        """
        node = self.config if provider == self.config.provider else get_node_test_config(provider)
        converted = node is not None and node.converted

        config = {}
        # An old-format node selects its profile by name; a converted node has no
        # "profile" key, its selector is written below at the selector's own path.
        if profile and not converted:
            config['profile'] = profile

        if provider == self.config.provider and self.config.config:
            config.update(self.config.config)
        # Inject credentials into the pipeline config.
        #
        # `ROCKETRIDE_MOCK` (set by the test runner) and per-group
        # `avoidMocks` control the mock-SDK baseline. `requires` is
        # independent — it always overlays real env var values on top.
        #
        #   MOCK + !avoidMocks + requires=[]   → mock placeholders only
        #   MOCK + !avoidMocks + requires=[…]  → mock placeholders baseline,
        #                                        env vars override (tester
        #                                        with real creds still
        #                                        exercises the real config
        #                                        path even under mocked SDK)
        #   avoidMocks=true + requires=[…]     → env vars only (real API)
        #   MOCK unset + requires=[…]          → env vars only (real SDK)
        creds: Dict[str, Any] = {}
        if profile:
            if os.environ.get('ROCKETRIDE_MOCK') and not self.config.avoid_mocks and provider in _LLM_MOCK_CREDENTIALS:
                creds.update(_LLM_MOCK_CREDENTIALS[provider])
            if self.config.requires:
                for env_var in self.config.requires:
                    val = os.environ.get(env_var)
                    field = _parse_credential_env_var(env_var, provider)
                    if val and field:
                        creds[field] = val
        if converted:
            # Path-addressed shape (plan section 5.6.2): the selector value only when
            # the schema declares a selector with that branch; a credential under
            # the branch VALUE when its definition is branch-specific, flat when
            # it is hoisted. An undeclared credential goes flat so the resolver
            # names it instead of the builder hiding it.
            paths = SchemaPaths(node.property_definitions, node.properties)
            selector = paths.selector_for(profile)
            if selector:
                config[selector] = profile
            for field, value in creds.items():
                _set_path(config, paths.path_for(field, profile) or field, value)
        elif creds:
            overrides = config.get(profile, {})
            if isinstance(overrides, dict):
                config[profile] = {**overrides, **creds}
        return config

    def _build_chain_component(
        self, provider: str, component_id: str, input_from: str, input_lanes: List[str]
    ) -> Dict[str, Any]:
        """Build a component for a chain node.

        Wires all input_lanes that the chain node supports (e.g. embedding_transformer
        receives both documents and questions so vector DB search-with-question works).
        """
        node_config = get_node_test_config(provider)
        profile = None
        if node_config and node_config.profiles:
            profile = node_config.profiles[0]  # Use first profile

        # Wire every lane that both the pipeline and the chain node support
        if node_config and node_config.lanes:
            chain_lanes = list(node_config.lanes.keys())
            lanes_to_wire = [lane for lane in input_lanes if lane in chain_lanes]
        else:
            lanes_to_wire = []
        if not lanes_to_wire:
            lanes_to_wire = [input_lanes[0]] if input_lanes else ['text']

        return {
            'id': component_id,
            'provider': provider,
            'config': self._get_node_config(provider, profile),
            'input': [{'lane': lane, 'from': input_from} for lane in lanes_to_wire],
        }

    def _build_control_components(self, target_id: str) -> List[Dict[str, Any]]:
        """Build control node components attached to the target node."""
        components = []

        for control_provider in self.config.controls:
            control_id = self._next_id(control_provider)

            # Get control node's test config for profile
            control_config = get_node_test_config(control_provider)
            profile = None
            if control_config and control_config.profiles:
                profile = control_config.profiles[0]

            components.append(
                {
                    'id': control_id,
                    'provider': control_provider,
                    'config': self._get_node_config(control_provider, profile),
                    'control': target_id,  # Attach as control to target
                }
            )

        return components

    def _build_response_components(self, input_from: str) -> List[Dict[str, Any]]:
        """Build response node components for each output lane."""
        components = []

        for output_lane in self.config.outputs:
            response_id = self._next_id(f'response_{output_lane}')
            components.append(
                {
                    'id': response_id,
                    'provider': 'response',
                    'config': {},
                    'input': [{'lane': output_lane, 'from': input_from}],
                }
            )

        # Sink nodes (outputs=[]): no response components needed
        if not self.config.outputs:
            return components
        # No outputs inferred: add default response on text lane
        if not components:
            response_id = self._next_id('response')
            components.append(
                {
                    'id': response_id,
                    'provider': 'response',
                    'config': {},
                    'input': [{'lane': 'text', 'from': input_from}],
                }
            )

        return components

    def build(self) -> Dict[str, Any]:
        """
        Build the complete test pipeline.

        Returns:
            Pipeline configuration dict ready for client.use()
        """
        project_id = f'test_{self.config.node_name}_{uuid.uuid4().hex[:8]}'
        components = []

        # Start with webhook
        webhook_id = self._next_id('webhook')
        components.append({'id': webhook_id, 'provider': 'webhook', 'config': {}, 'input': []})

        # Process chain, finding where * (node under test) goes
        chain = self.config.chain if self.config.chain else ['*']

        # Ensure * is in the chain
        if '*' not in chain:
            chain = chain + ['*']

        prev_id = webhook_id
        # Get all input lanes from the node's lanes config
        input_lanes = list(self.config.lanes.keys()) if self.config.lanes else []
        # Fallback: infer from test cases if no lanes defined
        if not input_lanes and self.config.cases:
            input_lanes = [self.config.cases[0].input_lane]
        # Ultimate fallback
        if not input_lanes:
            input_lanes = ['text']

        for chain_item in chain:
            if chain_item == '*':
                # This is the node under test
                node_id = self._next_id(self.config.provider)

                # Wire ALL input lanes from webhook to the node
                node_inputs = [{'lane': lane, 'from': prev_id} for lane in input_lanes]

                components.append(
                    {
                        'id': node_id,
                        'provider': self.config.provider,
                        'config': self._get_node_config(self.config.provider, self.profile),
                        'input': node_inputs,
                    }
                )

                # Add control nodes attached to this node
                control_components = self._build_control_components(node_id)
                components.extend(control_components)

                prev_id = node_id
            else:
                # Chain node (before or after node under test)
                chain_id = self._next_id(chain_item)
                components.append(self._build_chain_component(chain_item, chain_id, prev_id, input_lanes))
                prev_id = chain_id

        # Add response nodes for each output lane
        response_components = self._build_response_components(prev_id)
        components.extend(response_components)

        pipeline = {'project_id': project_id, 'source': webhook_id, 'components': components}
        if self.config.avoid_mocks:
            pipeline['avoidMocks'] = True
        return pipeline

    def get_required_env_vars(self) -> List[str]:
        """
        Get all required environment variables for this pipeline.

        Includes requirements from the node under test and all chain/control nodes.
        """
        required = set(self.config.requires)

        # Add requirements from control nodes
        for control in self.config.controls:
            control_config = get_node_test_config(control)
            if control_config:
                required.update(control_config.requires)

        # Add requirements from chain nodes
        for chain_item in self.config.chain:
            if chain_item != '*':
                chain_config = get_node_test_config(chain_item)
                if chain_config:
                    required.update(chain_config.requires)

        return list(required)
