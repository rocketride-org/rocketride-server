#!/usr/bin/env python3
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
"""
new_node.py - RocketRide node scaffolding CLI
=============================================

Generates a fully-wired, engine-compatible node skeleton under
``nodes/src/nodes/<node_name>/`` from the project root.

Usage
-----
  python new_node.py <node_name> [options]

Examples
--------
  python new_node.py my_custom_llm --class-type llm --prefix my
  python new_node.py tool_slack    --class-type tool
  python new_node.py db_redis      --class-type database --capability noremote invoke
  python new_node.py my_processor  --class-type text --register endpoint

Run ``python new_node.py --help`` for full option documentation.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import textwrap
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

NODES_ROOT = Path(__file__).parent / "nodes" / "src" / "nodes"
DOCS_URL = "https://docs.rocketride.org"
LICENSE_YEAR = "2026"
LICENSE_HOLDER = "Aparavi Software AG"

# Valid enum values sourced from corpus analysis of all existing nodes.
VALID_CLASS_TYPES = {
    "llm", "tool", "database", "text", "agent",
    "embedding", "audio", "image", "video",
}
VALID_CAPABILITIES = {"invoke", "gpu", "noremote"}
VALID_REGISTERS = {"filter", "endpoint"}

# Base-class map: (class_type) -> (IGlobal base, IInstance base, global imports, instance imports)
_BASE_MAP: dict[str, tuple[str, str, list[str], list[str]]] = {
    "llm": (
        "IGlobalBase",
        "LLMBase",
        [
            "from rocketlib import IGlobalBase",
        ],
        [
            "from ai.common.llm_base import LLMBase",
        ],
    ),
    "database": (
        "DatabaseGlobalBase",
        "DatabaseInstanceBase",
        [
            "from ai.common.database import DatabaseGlobalBase",
        ],
        [
            "from ai.common.database import DatabaseInstanceBase",
        ],
    ),
    "default": (
        "IGlobalBase",
        "IInstanceBase",
        [
            "from rocketlib import IGlobalBase",
        ],
        [
            "from rocketlib import IInstanceBase",
        ],
    ),
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _license_header() -> str:
    """Return the standard MIT licence header comment block."""
    return textwrap.dedent(f"""\
        # =============================================================================
        # MIT License
        # Copyright (c) {LICENSE_YEAR} {LICENSE_HOLDER}
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
    """)


def _derive_prefix(node_name: str) -> str:
    """
    Derive a short UI prefix from the node name.

    Strategy (mirrors corpus):
      - Strip the leading category segment if it matches a known prefix
        (e.g. ``llm_anthropic`` → ``llm``, ``db_postgres`` → ``postgres``).
      - For two-segment names drop the first segment; single-segment names
        are used as-is.

    Examples
    --------
    >>> _derive_prefix("llm_anthropic")
    'llm'
    >>> _derive_prefix("db_postgres")
    'postgres'
    >>> _derive_prefix("tool_http_request")
    'http'
    >>> _derive_prefix("webhook")
    'webhook'
    """
    parts = node_name.split("_")
    known_first = {"llm", "tool", "agent", "embedding", "db", "audio", "image", "video"}
    if len(parts) >= 2 and parts[0] in known_first:
        # Use second segment as prefix (drop the category)
        return parts[1]
    return parts[0]


def _title_from_name(node_name: str) -> str:
    """Convert snake_case node name to a Title Case display name."""
    return " ".join(word.capitalize() for word in node_name.split("_"))


def _validate_node_name(name: str) -> None:
    """Raise SystemExit if *name* does not conform to the snake_case convention."""
    if not re.fullmatch(r"[a-z][a-z0-9]*(?:_[a-z0-9]+)*", name):
        _die(
            f"Invalid node name {name!r}. "
            "Must be lowercase snake_case (e.g. 'my_node', 'llm_custom')."
        )


def _die(message: str) -> None:
    print(f"[new_node] ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def _info(message: str) -> None:
    print(f"[new_node] {message}")


# ---------------------------------------------------------------------------
# File generators
# ---------------------------------------------------------------------------


def _render_services_json(
    node_name: str,
    title: str,
    prefix: str,
    class_types: list[str],
    capabilities: list[str],
    register: str | None,
    description: str,
    has_requirements: bool,
) -> str:
    """
    Render a valid services.json for the new node.

    The output uses JSONC (JSON-with-comments) matching the existing node
    style — inline ``//`` comments explaining every key.

    Field naming convention: ``"<prefix>.<fieldName>"``.
    """
    # Build the field namespace prefix
    fp = prefix  # e.g. "llm", "postgres", "http"

    # Capabilities string for JSON
    caps_json = json.dumps(capabilities)
    class_type_json = json.dumps(class_types)

    # Construct a sensible tile expression
    tile_expr = f"${{{fp}.profile}}" if len(class_types) == 1 else ""
    tile_json = json.dumps([f"{title}: {tile_expr}"] if tile_expr else [])

    # Description split into sentence-sized chunks for array style
    # NOTE: This regex splits on any '. ' sequence and will incorrectly split
    # on abbreviations like 'e.g.' or 'i.e.' — acceptable for boilerplate text.
    desc_sentences = [s.strip() + " " for s in re.split(r"(?<=\.)\s+", description) if s.strip()]
    desc_json = json.dumps(desc_sentences, indent=None)

    # Build the services.json as a list of lines to avoid indentation issues
    # with dynamic block injection (register_block) in f-string templates.
    lines: list[str] = []
    T = "\t"  # tab shorthand

    def L(line: str = "") -> None:
        lines.append(line)

    L("{")
    L(f'{T}//')
    L(f'{T}// Required:')
    L(f'{T}//\t\tThe displayable name of this node')
    L(f'{T}//')
    L(f'{T}"title": "{title}",')
    L(f'{T}//')
    L(f'{T}// Required:')
    L(f'{T}//\t\tThe protocol is the endpoint protocol')
    L(f'{T}//')
    L(f'{T}"protocol": "{node_name}://",')
    L(f'{T}//')
    L(f'{T}// Required:')
    L(f'{T}//\t\tClass type of the node - what it does')
    L(f'{T}//')
    L(f'{T}"classType": {class_type_json},')
    L(f'{T}//')
    L(f'{T}// Required:')
    L(f'{T}//\t\tCapabilities are flags that change the behavior of the underlying')
    L(f'{T}//\t\tengine')
    L(f'{T}//')
    L(f'{T}"capabilities": {caps_json},')
    L(f'{T}//')
    L(f'{T}// Optional:')
    L(f'{T}//\t\tRegister is either filter, endpoint or ignored if not specified. If the')
    L(f'{T}//\t\ttype is specified, a factory is registered of that given type')
    L(f'{T}//')
    if register:
        L(f'{T}"register": "{register}",')
    L(f'{T}//')
    L(f'{T}// Optional:')
    L(f'{T}//\t\tThe node is the actual physical node to instantiate - if')
    L(f'{T}//\t\tnot specified, the protocol will be used')
    L(f'{T}//')
    L(f'{T}"node": "python",')
    L(f'{T}//')
    L(f'{T}// Optional:')
    L(f'{T}//\t\tThe path is the executable/script code - it is node dependent')
    L(f'{T}// \t\tand is optional for most node')
    L(f'{T}//')
    L(f'{T}"path": "nodes.{node_name}",')
    L(f'{T}//')
    L(f'{T}// Required:')
    L(f'{T}//\t\tThe prefix map when added/removed when converting URLs <=> paths')
    L(f'{T}//')
    L(f'{T}"prefix": "{fp}",')
    L(f'{T}//')
    L(f'{T}// Optional:')
    L(f'{T}//\t\tDescription of this driver')
    L(f'{T}//')
    L(f'{T}"description": {desc_json},')
    L(f'{T}//')
    L(f'{T}// Optional:')
    L(f'{T}//    The icon is the icon to display in the UI for this node')
    L(f'{T}//')
    L(f'{T}"icon": "{node_name}.svg",')
    L(f'{T}"documentation": "{DOCS_URL}",')
    L(f'{T}//')
    L(f'{T}// Optional:')
    L(f'{T}//\t The tile is the displayable name of this node in a pipeline card')
    L(f'{T}//')
    L(f'{T}"tile": {tile_json},')
    L(f'{T}//')
    L(f'{T}// Optional:')
    L(f'{T}//\t\tAs a pipe component, define what this pipe component takes')
    L(f'{T}//\t\tand what it produces')
    L(f'{T}//')
    L(f'{T}"lanes": {{')
    L(f'{T}{T}"questions": ["answers"]')
    L(f'{T}}},')
    L(f'{T}"input": [')
    L(f'{T}{T}{{')
    L(f'{T}{T}{T}"lane": "questions",')
    L(f'{T}{T}{T}"output": [')
    L(f'{T}{T}{T}{T}{{')
    L(f'{T}{T}{T}{T}{T}"lane": "answers"')
    L(f'{T}{T}{T}{T}}}')
    L(f'{T}{T}{T}]')
    L(f'{T}{T}}}')
    L(f'{T}],')
    L(f'{T}//')
    L(f'{T}// Optional:')
    L(f'{T}//\t\tProfile section are configuration options used by the driver itself')
    L(f'{T}//')
    L(f'{T}"preconfig": {{')
    L(f'{T}{T}// Define the values that will be merged into any profile configuration')
    L(f'{T}{T}// specified, unless the profile is \'absolute\'')
    L(f'{T}{T}"default": "default",')
    L(f'{T}{T}// Defines profiles used with the "profile": key')
    L(f'{T}{T}"profiles": {{')
    L(f'{T}{T}{T}"default": {{')
    L(f'{T}{T}{T}{T}// TODO: add default profile keys here')
    L(f'{T}{T}{T}{T}"setting": ""')
    L(f'{T}{T}{T}}}')
    L(f'{T}{T}}}')
    L(f'{T}}},')
    L(f'{T}//')
    L(f'{T}// Optional:')
    L(f'{T}//\t\tLocal fields definitions - these define fields only for the')
    L(f'{T}//\t\tcurrent service. You may specify them here, or directly')
    L(f'{T}//\t\tin the shape')
    L(f'{T}//')
    L(f'{T}"fields": {{')
    L(f'{T}{T}"{fp}.setting": {{')
    L(f'{T}{T}{T}"type": "string",')
    L(f'{T}{T}{T}"title": "Setting",')
    L(f'{T}{T}{T}"description": "TODO: describe this field",')
    L(f'{T}{T}{T}"default": ""')
    L(f'{T}{T}}},')
    L(f'{T}{T}"{fp}.default": {{')
    L(f'{T}{T}{T}"object": "default",')
    L(f'{T}{T}{T}"properties": ["{fp}.setting"]')
    L(f'{T}{T}}},')
    L(f'{T}{T}"{fp}.profile": {{')
    L(f'{T}{T}{T}"hidden": true,')
    L(f'{T}{T}{T}"type": "string",')
    L(f'{T}{T}{T}"default": "default",')
    L(f'{T}{T}{T}"enum": [["default", "Default"]],')
    L(f'{T}{T}{T}"conditional": [')
    L(f'{T}{T}{T}{T}{{')
    L(f'{T}{T}{T}{T}{T}"value": "default",')
    L(f'{T}{T}{T}{T}{T}"properties": ["{fp}.default"]')
    L(f'{T}{T}{T}{T}}}')
    L(f'{T}{T}{T}]')
    L(f'{T}{T}}}')
    L(f'{T}}},')
    L(f'{T}//')
    L(f'{T}// Required:')
    L(f'{T}//\t\tDefines the fields (shape) of the service. Either source or target')
    L(f'{T}//\t\tmay be specified, or both, but at least one is required')
    L(f'{T}//')
    L(f'{T}"shape": [')
    L(f'{T}{T}{{')
    L(f'{T}{T}{T}"section": "Pipe",')
    L(f'{T}{T}{T}"title": "{title}",')
    L(f'{T}{T}{T}"properties": ["{fp}.profile"]')
    L(f'{T}{T}}}')
    L(f'{T}],')
    L(f'{T}//')
    L(f'{T}// Optional:')
    L(f'{T}//\t\tTest harness configuration')
    L(f'{T}//')
    L(f'{T}"test": {{')
    L(f'{T}{T}"profiles": ["default"],')
    L(f'{T}{T}"outputs": ["answers"],')
    L(f'{T}{T}"cases": [')
    L(f'{T}{T}{T}{{')
    L(f'{T}{T}{T}{T}"name": "Smoke test",')
    L(f'{T}{T}{T}{T}"text": "Hello, world!",')
    L(f'{T}{T}{T}{T}"expect": {{')
    L(f'{T}{T}{T}{T}{T}"answers": {{')
    L(f'{T}{T}{T}{T}{T}{T}"notEmpty": true')
    L(f'{T}{T}{T}{T}{T}}}')
    L(f'{T}{T}{T}{T}}}')
    L(f'{T}{T}{T}}}')
    L(f'{T}{T}]')
    L(f'{T}}}')
    L("}")
    return "\n".join(lines) + "\n"


def _render_iglobal(
    node_name: str,
    class_types: list[str],
    has_requirements: bool,
) -> str:
    """Render `IGlobal.py` matching the corpus conventions."""
    primary = class_types[0] if class_types else "default"
    base_entry = _BASE_MAP.get(primary, _BASE_MAP["default"])
    global_base, _instance_base, global_imports, _instance_imports = base_entry

    extra_imports = "\n".join(global_imports)

    begin_global_body = textwrap.indent(
        textwrap.dedent("""\
            \"\"\"Initialize global state for this node.\"\"\"
            # TODO: implement node-level initialisation
            pass
        """),
        "        ",
    )

    end_global_body = textwrap.indent(
        textwrap.dedent("""\
            \"\"\"Tear down global state for this node.\"\"\"
            # TODO: implement cleanup
            pass
        """),
        "        ",
    )

    req_depends = ""
    if has_requirements:
        req_depends = textwrap.dedent("""\

                from depends import depends  # type: ignore

                requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
                depends(requirements)
        """)

    return (
        _license_header()
        + "\n"
        + (f"import os\n" if has_requirements else "")
        + f"{extra_imports}\n"
        + "\n\n"
        + f"class IGlobal({global_base}):\n"
        + f'    """Global (per-pipeline) state for the {node_name} node."""\n'
        + "\n"
        + "    def validateConfig(self):\n"
        + "        \"\"\"Validate configuration before the pipeline starts.\"\"\"\n"
        + (req_depends if has_requirements else "        # TODO: validate node configuration here\n        pass\n")
        + "\n"
        + "    def beginGlobal(self):\n"
        + f"        {begin_global_body.strip()}\n"
        + "\n"
        + "    def endGlobal(self):\n"
        + f"        {end_global_body.strip()}\n"
    )


def _render_iinstance(node_name: str, class_types: list[str]) -> str:
    """Render `IInstance.py` matching the corpus conventions."""
    primary = class_types[0] if class_types else "default"
    base_entry = _BASE_MAP.get(primary, _BASE_MAP["default"])
    _global_base, instance_base, _global_imports, instance_imports = base_entry

    extra_imports = "\n".join(instance_imports)

    return (
        _license_header()
        + "\n"
        + f"from .IGlobal import IGlobal\n"
        + f"{extra_imports}\n"
        + "\n\n"
        + f"class IInstance({instance_base}):\n"
        + f'    """Per-request state for the {node_name} node."""\n'
        + "\n"
        + "    IGlobal: IGlobal\n"
        + "\n"
        + "    # TODO: implement lane handlers and tool methods here\n"
    )


def _render_init(node_name: str, has_requirements: bool) -> str:
    """Render `__init__.py`."""
    if has_requirements:
        # Pattern B: eager depends load
        body = textwrap.dedent("""\
            import os
            from depends import depends  # type: ignore

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            from .IGlobal import IGlobal  # noqa: E402
            from .IInstance import IInstance  # noqa: E402

            __all__ = ['IGlobal', 'IInstance']
        """)
    else:
        # Pattern A: simple import
        body = textwrap.dedent("""\
            from .IGlobal import IGlobal
            from .IInstance import IInstance

            __all__ = ['IGlobal', 'IInstance']
        """)

    return _license_header() + "\n" + body


def _render_readme(node_name: str, title: str, description: str) -> str:
    """Render a minimal but valid README.md."""
    return textwrap.dedent(f"""\
        # {title}

        {description}

        ## Configuration

        | Field | Type | Description |
        |---|---|---|
        | setting | string | TODO: describe |

        ## Lanes

        | Lane | Direction | Description |
        |---|---|---|
        | questions | input | Incoming questions |
        | answers | output | Generated answers |

        ## Requirements

        See `requirements.txt` for Python dependencies.

        ## Documentation

        {DOCS_URL}
    """)


def _render_requirements() -> str:
    """Render an empty requirements.txt with a placeholder comment."""
    return "# Add Python package dependencies here (one per line)\n"


# ---------------------------------------------------------------------------
# Scaffolding orchestrator
# ---------------------------------------------------------------------------


def scaffold(
    node_name: str,
    class_types: list[str],
    capabilities: list[str],
    register: str | None,
    prefix: str | None,
    description: str,
    with_requirements: bool,
    dry_run: bool,
    force: bool,
) -> None:
    """Create all node files under ``nodes/src/nodes/<node_name>/``."""

    _validate_node_name(node_name)

    effective_prefix = prefix or _derive_prefix(node_name)
    title = _title_from_name(node_name)
    target_dir = NODES_ROOT / node_name

    # Guard: refuse to overwrite unless --force
    if target_dir.exists() and not force:
        _die(
            f"Directory already exists: {target_dir}\n"
            "  Use --force to overwrite."
        )

    # ------------------------------------------------------------------
    # Build the file map: relative_path -> content
    # ------------------------------------------------------------------
    files: dict[str, str] = {
        "__init__.py": _render_init(node_name, with_requirements),
        "IGlobal.py": _render_iglobal(node_name, class_types, with_requirements),
        "IInstance.py": _render_iinstance(node_name, class_types),
        "services.json": _render_services_json(
            node_name=node_name,
            title=title,
            prefix=effective_prefix,
            class_types=class_types,
            capabilities=capabilities,
            register=register,
            description=description,
            has_requirements=with_requirements,
        ),
        "README.md": _render_readme(node_name, title, description),
    }

    if with_requirements:
        files["requirements.txt"] = _render_requirements()

    # ------------------------------------------------------------------
    # Emit
    # ------------------------------------------------------------------
    _info(f"Scaffolding node: {node_name!r}  ->  {target_dir}")
    _info(f"  class-type   : {class_types}")
    _info(f"  capabilities : {capabilities}")
    _info(f"  register     : {register or '(none)'}")
    _info(f"  prefix       : {effective_prefix}")
    _info(f"  requirements : {'yes' if with_requirements else 'no'}")
    _info(f"  dry-run      : {'yes' if dry_run else 'no'}")
    print()

    for relative, content in files.items():
        filepath = target_dir / relative
        if dry_run:
            _info(f"  [dry-run] would write -> {filepath}")
        else:
            filepath.parent.mkdir(parents=True, exist_ok=True)
            filepath.write_text(content, encoding="utf-8")
            _info(f"  created -> {filepath}")

    print()
    if dry_run:
        _info("Dry-run complete. No files were written.")
    else:
        _info("Done! Next steps:")
        _info(f"  1. Edit  nodes/src/nodes/{node_name}/services.json  -- fill in your fields and lanes")
        _info(f"  2. Edit  nodes/src/nodes/{node_name}/IGlobal.py     -- implement validateConfig / beginGlobal")
        _info(f"  3. Edit  nodes/src/nodes/{node_name}/IInstance.py   -- implement lane handlers")
        if with_requirements:
            _info(f"  4. Edit  nodes/src/nodes/{node_name}/requirements.txt -- add pip dependencies")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="new_node",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    parser.add_argument(
        "node_name",
        help=(
            "Snake_case name for the new node directory "
            "(e.g. 'my_custom_llm', 'tool_slack'). "
            "Must match pattern [a-z][a-z0-9]*(_[a-z0-9]+)*."
        ),
    )

    parser.add_argument(
        "--class-type",
        dest="class_types",
        nargs="+",
        metavar="TYPE",
        default=["tool"],
        choices=sorted(VALID_CLASS_TYPES),
        help=(
            "One or more class types for the node. "
            f"Valid values: {', '.join(sorted(VALID_CLASS_TYPES))}. "
            "Default: tool"
        ),
    )

    parser.add_argument(
        "--capability",
        dest="capabilities",
        nargs="+",
        metavar="CAP",
        default=["invoke"],
        choices=sorted(VALID_CAPABILITIES),
        help=(
            "One or more capability flags. "
            f"Valid values: {', '.join(sorted(VALID_CAPABILITIES))}. "
            "Default: invoke"
        ),
    )

    parser.add_argument(
        "--register",
        choices=sorted(VALID_REGISTERS) + ["none"],
        default="filter",
        help=(
            "Factory registration type. "
            f"Valid values: {', '.join(sorted(VALID_REGISTERS))}, none. "
            "Use 'none' to omit the register field entirely. "
            "Default: filter"
        ),
    )

    parser.add_argument(
        "--prefix",
        default=None,
        help=(
            "Short namespace prefix for UI field keys (e.g. 'llm', 'http'). "
            "Derived automatically from node_name if omitted."
        ),
    )

    parser.add_argument(
        "--description",
        default="A custom RocketRide node.",
        help="Human-readable description written into services.json and README.md.",
    )

    parser.add_argument(
        "--with-requirements",
        action="store_true",
        default=False,
        help=(
            "Generate a requirements.txt and add eager depends() loading in __init__.py. "
            "Use this when your node has Python package dependencies."
        ),
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Print what would be created without writing any files.",
    )

    parser.add_argument(
        "--force",
        action="store_true",
        default=False,
        help="Overwrite an existing node directory. USE WITH CAUTION.",
    )

    return parser


def main(argv: list[str] | None = None) -> None:
    parser = _build_parser()
    args = parser.parse_args(argv)

    # Map the "none" sentinel string to Python None so scaffold() omits the
    # register field entirely when the user passes --register none.
    register: str | None = None if args.register == "none" else args.register

    scaffold(
        node_name=args.node_name,
        class_types=args.class_types,
        capabilities=args.capabilities,
        register=register,
        prefix=args.prefix,
        description=args.description,
        with_requirements=args.with_requirements,
        dry_run=args.dry_run,
        force=args.force,
    )


if __name__ == "__main__":
    main()
