import importlib.util
import json
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / 'scripts' / 'validate-node-readme.py'
SPEC = importlib.util.spec_from_file_location('validate_node_readme', SCRIPT)
VALIDATOR = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(VALIDATOR)


def write_node(tmp_path, *, class_type=('llm',), profiles, default, profile_section):
    node = tmp_path / 'fixture_node'
    node.mkdir()
    service = {
        'protocol': 'fixture',
        'classType': list(class_type),
        'capabilities': [],
        'lanes': {},
        'fields': {},
        'preconfig': {'default': default, 'profiles': profiles},
    }
    (node / 'services.json').write_text(json.dumps(service))
    (node / 'README.md').write_text(
        '# fixture_node\n\nA fixture node used to test documentation validation.\n\n'
        '## What it does\n\nRuns fixture prompts.\n\n'
        f'{profile_section}\n\n'
        '## Configuration\n\nChoose a profile.\n'
    )
    return node


def failures(node):
    _, results = VALIDATOR.validate(node)
    return [(check, detail) for status, check, detail in results if status == 'FAIL']


LARGE_PROFILES = {
    'profile-1': {'title': 'Profile 1'},
    'profile-2': {'title': 'Profile 2'},
    'profile-3': {'title': 'Profile 3'},
    'profile-4': {'title': 'Profile 4'},
    'profile-5': {'title': 'Profile 5'},
    'profile-6': {'title': 'Profile 6'},
    'legacy': {'title': 'Legacy', 'deprecated': True},
    'custom': {'title': 'Custom'},
}

VALID_LARGE_SECTION = """## Profiles

Default: **Profile 1** (`profile-1`).

| Profile | Model |
| ------- | ----- |
| `profile-1` **(default)** | `model-1` |
| `profile-2` | `model-2` |
| `profile-3` | `model-3` |
| `profile-4` | `model-4` |
| `profile-5` | `model-5` |
| `profile-6` | `model-6` |

<details>
<summary><strong>View 2 more models</strong></summary>

| Profile | Model |
| ------- | ----- |
| `legacy` | `legacy-model` |
| `custom` | _(user-specified)_ |

</details>"""


def test_large_llm_requires_details(tmp_path):
    profiles = {
        'profile-1': {'title': 'Profile 1'},
        'profile-2': {'title': 'Profile 2'},
        'profile-3': {'title': 'Profile 3'},
        'profile-4': {'title': 'Profile 4'},
        'profile-5': {'title': 'Profile 5'},
        'profile-6': {'title': 'Profile 6'},
        'profile-7': {'title': 'Profile 7'},
    }
    profile_section = """## Profiles

Default: **Profile 1** (`profile-1`).

| Profile | Model |
| ------- | ----- |
| `profile-1` **(default)** | `model-1` |
| `profile-2` | `model-2` |
| `profile-3` | `model-3` |
| `profile-4` | `model-4` |
| `profile-5` | `model-5` |
| `profile-6` | `model-6` |
| `profile-7` | `model-7` |"""
    node = write_node(tmp_path, profiles=profiles, default='profile-1', profile_section=profile_section)

    assert any(check == 'Profiles details layout' for check, _ in failures(node))


def test_large_llm_accepts_default_plus_five_and_collapses_remainder(tmp_path):
    node = write_node(
        tmp_path,
        profiles=LARGE_PROFILES,
        default='profile-1',
        profile_section=VALID_LARGE_SECTION,
    )

    assert failures(node) == []


def test_large_llm_requires_matching_table_headers(tmp_path):
    profile_section = VALID_LARGE_SECTION.replace(
        """| Profile | Model |
| ------- | ----- |
| `legacy` | `legacy-model` |
| `custom` | _(user-specified)_ |""",
        """| Profile | Context tokens |
| ------- | -------------- |
| `legacy` | 32,768 |
| `custom` | _(user-specified)_ |""",
    )
    node = write_node(
        tmp_path,
        profiles=LARGE_PROFILES,
        default='profile-1',
        profile_section=profile_section,
    )

    assert any(check == 'Profiles table headers match' for check, _ in failures(node))


def test_large_llm_rejects_more_than_six_visible_rows(tmp_path):
    profile_section = """## Profiles

Default: **Profile 1** (`profile-1`).

| Profile | Model |
| ------- | ----- |
| `profile-1` **(default)** | `model-1` |
| `profile-2` | `model-2` |
| `profile-3` | `model-3` |
| `profile-4` | `model-4` |
| `profile-5` | `model-5` |
| `profile-6` | `model-6` |
| `legacy` | `legacy-model` |

<details>
<summary><strong>View 1 more models</strong></summary>

| Profile | Model |
| ------- | ----- |
| `custom` | _(user-specified)_ |

</details>"""
    node = write_node(tmp_path, profiles=LARGE_PROFILES, default='profile-1', profile_section=profile_section)

    assert any(check == 'Profiles visible row count' for check, _ in failures(node))


def test_large_llm_requires_default_in_visible_table_and_intro(tmp_path):
    profile_section = """## Profiles

Default: **Profile 2** (`profile-2`).

| Profile | Model |
| ------- | ----- |
| `profile-2` | `model-2` |
| `profile-1` | `model-1` |
| `profile-3` | `model-3` |
| `profile-4` | `model-4` |
| `profile-5` | `model-5` |
| `profile-6` | `model-6` |

<details>
<summary><strong>View 2 more models</strong></summary>

| Profile | Model |
| ------- | ----- |
| `legacy` | `legacy-model` |
| `custom` | _(user-specified)_ |

</details>"""
    node = write_node(tmp_path, profiles=LARGE_PROFILES, default='profile-1', profile_section=profile_section)
    checks = {check for check, _ in failures(node)}

    assert 'Profiles default is visible and first' in checks
    assert 'Profiles default is marked' in checks
    assert 'Profiles default appears in intro' in checks


def test_profiles_require_default_title_in_intro(tmp_path):
    profile_section = VALID_LARGE_SECTION.replace('**Profile 1** (`profile-1`)', '**Old Profile** (`profile-1`)')
    node = write_node(
        tmp_path,
        profiles=LARGE_PROFILES,
        default='profile-1',
        profile_section=profile_section,
    )
    checks = {check for check, _ in failures(node)}

    assert 'Profiles default title appears in intro' in checks
    assert 'Profiles default appears in intro' not in checks


def test_large_llm_requires_custom_and_deprecated_rows_collapsed(tmp_path):
    profile_section = """## Profiles

Default: **Profile 1** (`profile-1`).

| Profile | Model |
| ------- | ----- |
| `profile-1` **(default)** | `model-1` |
| `profile-2` | `model-2` |
| `profile-3` | `model-3` |
| `profile-4` | `model-4` |
| `legacy` | `legacy-model` |
| `custom` | _(user-specified)_ |

<details>
<summary><strong>View 2 more models</strong></summary>

| Profile | Model |
| ------- | ----- |
| `profile-5` | `model-5` |
| `profile-6` | `model-6` |

</details>"""
    node = write_node(tmp_path, profiles=LARGE_PROFILES, default='profile-1', profile_section=profile_section)

    assert any(check == 'Profiles custom/deprecated rows collapsed' for check, _ in failures(node))


def test_profiles_reject_missing_duplicate_and_unknown_rows(tmp_path):
    profile_section = """## Profiles

Default: **Profile 1** (`profile-1`).

| Profile | Model |
| ------- | ----- |
| `profile-1` **(default)** | `model-1` |
| `profile-2` | `model-2` |
| `profile-2` | `model-2` |
| `profile-3` | `model-3` |
| `profile-4` | `model-4` |
| `profile-5` | `model-5` |

<details>
<summary><strong>View 2 more models</strong></summary>

| Profile | Model |
| ------- | ----- |
| `custom` | _(user-specified)_ |
| `mystery` | `mystery-model` |

</details>"""
    node = write_node(tmp_path, profiles=LARGE_PROFILES, default='profile-1', profile_section=profile_section)
    checks = {check for check, _ in failures(node)}

    assert 'Profiles missing rows' in checks
    assert 'Profiles duplicate rows' in checks
    assert 'Profiles unknown rows' in checks


def test_large_llm_rejects_wrong_hidden_count(tmp_path):
    profile_section = VALID_LARGE_SECTION.replace('View 2 more models', 'View 3 more models')
    node = write_node(tmp_path, profiles=LARGE_PROFILES, default='profile-1', profile_section=profile_section)

    assert any(check == 'Profiles hidden row count' for check, _ in failures(node))


def test_large_llm_rejects_broken_details_blank_lines(tmp_path):
    profile_section = VALID_LARGE_SECTION.replace('</summary>\n\n| Profile', '</summary>\n| Profile').replace(
        '| _(user-specified)_ |\n\n</details>', '| _(user-specified)_ |\n</details>'
    )
    node = write_node(tmp_path, profiles=LARGE_PROFILES, default='profile-1', profile_section=profile_section)

    assert any(check == 'Profiles details blank lines' for check, _ in failures(node))


def test_large_llm_rejects_custom_or_deprecated_default(tmp_path):
    node = write_node(tmp_path, profiles=LARGE_PROFILES, default='legacy', profile_section=VALID_LARGE_SECTION)

    assert any(check == 'Profiles default metadata is compatible with large layout' for check, _ in failures(node))


VALUE_PROFILES = {
    'profile-a': {
        'title': 'Profile A',
        'model': 'model-a',
        'modelTotalTokens': 128000,
        'modelOutputTokens': 8192,
    },
    'profile-b': {
        'title': 'Profile B',
        'model': 'model-b',
        'modelTotalTokens': 1000000,
        'modelOutputTokens': 64000,
    },
}

VALUE_SECTION_ALIASES = """## Profiles

Default: **Profile A** (`profile-a`).

| Profile | Model ID | Context tokens | Output tokens |
| ------- | -------- | -------------- | ------------- |
| `profile-a` **(default)** | `model-a` | 128,000 | 8,192 |
| `profile-b` | `model-b` | 1,000,000 | 64,000 |"""


def test_profiles_reject_mismatched_model_identifier(tmp_path):
    profile_section = VALUE_SECTION_ALIASES.replace('`model-b`', '`wrong-model`')
    node = write_node(tmp_path, profiles=VALUE_PROFILES, default='profile-a', profile_section=profile_section)

    assert any(check == 'Profiles model matches preconfig' for check, _ in failures(node))


def test_profiles_reject_mismatched_context_tokens(tmp_path):
    profile_section = VALUE_SECTION_ALIASES.replace('1,000,000', '999,999')
    node = write_node(tmp_path, profiles=VALUE_PROFILES, default='profile-a', profile_section=profile_section)

    assert any(check == 'Profiles context tokens match preconfig' for check, _ in failures(node))


def test_profiles_reject_mismatched_output_tokens(tmp_path):
    profile_section = VALUE_SECTION_ALIASES.replace('64,000', '63,999')
    node = write_node(tmp_path, profiles=VALUE_PROFILES, default='profile-a', profile_section=profile_section)

    assert any(check == 'Profiles output tokens match preconfig' for check, _ in failures(node))


def test_profiles_reject_missing_value_in_present_semantic_column(tmp_path):
    profile_section = VALUE_SECTION_ALIASES.replace(
        '| `profile-b` | `model-b` | 1,000,000 | 64,000 |', '| `profile-b` | `model-b` | 1,000,000 |'
    )
    node = write_node(tmp_path, profiles=VALUE_PROFILES, default='profile-a', profile_section=profile_section)

    assert any(check == 'Profiles output tokens match preconfig' for check, _ in failures(node))


def test_profiles_accept_header_aliases_and_thousands_separators(tmp_path):
    aliases_root = tmp_path / 'aliases'
    aliases_root.mkdir()
    aliases = write_node(
        aliases_root,
        profiles=VALUE_PROFILES,
        default='profile-a',
        profile_section=VALUE_SECTION_ALIASES,
    )
    canonical_root = tmp_path / 'canonical'
    canonical_root.mkdir()
    canonical_section = VALUE_SECTION_ALIASES.replace('Model ID', 'Model').replace(
        'Context tokens | Output tokens', 'Context | Output'
    )
    canonical = write_node(
        canonical_root,
        profiles=VALUE_PROFILES,
        default='profile-a',
        profile_section=canonical_section,
    )

    assert failures(aliases) == []
    assert failures(canonical) == []


def test_non_llm_and_six_profile_sections_remain_single_table(tmp_path):
    profiles = {
        'profile-1': {'title': 'Profile 1'},
        'profile-2': {'title': 'Profile 2'},
        'profile-3': {'title': 'Profile 3'},
        'profile-4': {'title': 'Profile 4'},
        'profile-5': {'title': 'Profile 5'},
        'profile-6': {'title': 'Profile 6'},
        'profile-7': {'title': 'Profile 7'},
    }
    seven_rows = """## Profiles

Default: **Profile 1** (`profile-1`).

| Profile | Model |
| ------- | ----- |
| `profile-1` **(default)** | `model-1` |
| `profile-2` | `model-2` |
| `profile-3` | `model-3` |
| `profile-4` | `model-4` |
| `profile-5` | `model-5` |
| `profile-6` | `model-6` |
| `profile-7` | `model-7` |"""
    non_llm_root = tmp_path / 'non_llm'
    non_llm_root.mkdir()
    non_llm = write_node(
        non_llm_root,
        class_type=('model',),
        profiles=profiles,
        default='profile-1',
        profile_section=seven_rows,
    )
    six_profiles = {
        'profile-1': {'title': 'Profile 1'},
        'profile-2': {'title': 'Profile 2'},
        'profile-3': {'title': 'Profile 3'},
        'profile-4': {'title': 'Profile 4'},
        'profile-5': {'title': 'Profile 5'},
        'profile-6': {'title': 'Profile 6'},
    }
    six_llm_root = tmp_path / 'six_llm'
    six_llm_root.mkdir()
    six_llm = write_node(
        six_llm_root,
        profiles=six_profiles,
        default='profile-1',
        profile_section=seven_rows.replace('| `profile-7` | `model-7` |', ''),
    )

    assert failures(non_llm) == []
    assert failures(six_llm) == []


def write_multi_service_node(tmp_path, *, profile_section, class_type=('llm',)):
    """A directory with two protocol-bearing services, each with its own default.

    Mirrors cloud_tts, store_elasticsearch and llm_openai_api: a second
    registration is a different node to the engine, so its default is a fact
    about that service rather than a competing claim about the primary one.
    """
    node = tmp_path / 'fixture_node'
    node.mkdir()
    base = {
        'classType': list(class_type),
        'capabilities': [],
        'lanes': {},
        'fields': {},
    }
    primary = {
        **base,
        'protocol': 'fixture_primary',
        'preconfig': {
            'default': 'primary-a',
            'profiles': {'primary-a': {'title': 'Primary A'}, 'primary-b': {'title': 'Primary B'}},
        },
    }
    secondary = {
        **base,
        'protocol': 'fixture_secondary',
        'preconfig': {
            'default': 'secondary-a',
            'profiles': {'secondary-a': {'title': 'Secondary A'}, 'secondary-b': {'title': 'Secondary B'}},
        },
    }
    (node / 'services.json').write_text(json.dumps(primary))
    (node / 'services.secondary.json').write_text(json.dumps(secondary))
    (node / 'README.md').write_text(
        '# fixture_node\n\nA fixture node used to test documentation validation.\n\n'
        '## What it does\n\nRuns fixture prompts.\n\n'
        f'{profile_section}\n\n'
        '## Configuration\n\nChoose a profile.\n'
    )
    return node


MULTI_SERVICE_SECTION = """## Profiles

Primary default: **Primary A** (`primary-a`). Secondary default: **Secondary A** (`secondary-a`).

| Profile | Model |
| ------- | ----- |
| `primary-a` **(default)** | `model-pa` |
| `primary-b` | `model-pb` |
| `secondary-a` **(default)** | `model-sa` |
| `secondary-b` | `model-sb` |"""


def test_multi_service_accepts_one_default_per_service(tmp_path):
    node = write_multi_service_node(tmp_path, profile_section=MULTI_SERVICE_SECTION)
    assert failures(node) == []


def test_multi_service_rejects_a_missing_service_default(tmp_path):
    section = MULTI_SERVICE_SECTION.replace('| `secondary-a` **(default)** |', '| `secondary-a` |')
    node = write_multi_service_node(tmp_path, profile_section=section)
    checks = [check for check, _ in failures(node)]
    assert 'Profiles default is marked' in checks


def test_multi_service_rejects_marking_a_non_default(tmp_path):
    section = MULTI_SERVICE_SECTION.replace('| `secondary-b` |', '| `secondary-b` **(default)** |')
    node = write_multi_service_node(tmp_path, profile_section=section)
    checks = [check for check, _ in failures(node)]
    assert 'Profiles default is marked' in checks


def test_multi_service_requires_every_default_in_the_intro(tmp_path):
    section = MULTI_SERVICE_SECTION.replace(' Secondary default: **Secondary A** (`secondary-a`).', '')
    node = write_multi_service_node(tmp_path, profile_section=section)
    checks = [check for check, _ in failures(node)]
    assert 'Profiles default appears in intro' in checks
    assert 'Profiles default title appears in intro' in checks


PADDED_PROFILES = {
    'small': {'title': 'Text Small   - A highly efficient model'},
    'large': {'title': 'Text Large   - A larger and more powerful model'},
}

PADDED_SECTION = """## Profiles

Default: **Text Small - A highly efficient model** (`small`).

| Profile | Model |
| ------- | ----- |
| Text Small - A highly efficient model **(default)** | `model-small` |
| Text Large - A larger and more powerful model | `model-large` |"""


def test_profile_titles_match_with_dropdown_padding_collapsed(tmp_path):
    """Titles are padded to align in the config panel; prose writes them normally."""
    node = write_node(
        tmp_path,
        class_type=('embedding',),
        profiles=PADDED_PROFILES,
        default='small',
        profile_section=PADDED_SECTION,
    )
    assert failures(node) == []


def test_profile_title_mismatch_still_fails_when_words_differ(tmp_path):
    section = PADDED_SECTION.replace('A highly efficient model**', 'A highly efficient encoder**')
    node = write_node(
        tmp_path,
        class_type=('embedding',),
        profiles=PADDED_PROFILES,
        default='small',
        profile_section=section,
    )
    checks = [check for check, _ in failures(node)]
    assert 'Profiles default title appears in intro' in checks
