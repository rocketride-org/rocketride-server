"""
AST-based contract extractor.

Walks every ``.py`` file under a configured tree and produces a
:class:`ComponentContract` describing the third-party imports and attribute
chains the code uses. Recurses into function and class bodies so SDK imports
placed inside the method that uses them (a common pattern) are seen.

Auto-detects three things without a manifest:
  1. Plain imports → :class:`ImportRequirement`.
  2. ``try / except (ImportError, ModuleNotFoundError)`` shims around imports
     → :class:`AnyOf` candidates.
  3. SDK client patterns via intra-procedural data-flow tracking:
     ``client = TwelveLabs(api_key=key)`` then ``client.indexes.create(...)``
     → auto-emitted :class:`HeavyClass` with a dummied construction expression.

Honours ``# contract-check: ignore`` on an import line to drop that import
entirely.
"""

from __future__ import annotations

import ast
import io
import sys
import tokenize
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Optional

from contract_checks.manifest import (
    AnyOf,
    ComponentManifest,
    HeavyClass,
    ImportRequirement,
)
from contract_checks.trees import Tree


# Comment marker that drops an import from the contract entirely.
_IGNORE_COMMENT = 'contract-check: ignore'

# Python stdlib top-level names. `sys.stdlib_module_names` exists since 3.10.
_STDLIB = frozenset(getattr(sys, 'stdlib_module_names', ()))


@dataclass
class ComponentContract:
    """
    The auto-extracted (+ manifest-overlaid) contract for one component.

    Attributes:
        tree_name:      Short id of the owning :class:`Tree` (e.g.,
                        ``"nodes"``).
        component_name: Directory name of the component (e.g.,
                        ``"twelvelabs"``).
        component_dir:  Absolute path to the component directory.
        imports:        Required imports the runner will resolve one-by-one.
        any_of_imports: Version-fallback groups; each requires at least one
                        alternative to resolve.
        heavy_classes:  SDK-client contracts to construct + walk.
    """

    tree_name: str
    component_name: str
    component_dir: Path
    imports: list[ImportRequirement] = field(default_factory=list)
    any_of_imports: list[AnyOf] = field(default_factory=list)
    heavy_classes: list[HeavyClass] = field(default_factory=list)

    @property
    def packages(self) -> list[str]:
        """
        Enumerate distinct top-level packages referenced by this contract.

        Returns:
            Insertion-ordered list of unique top-level package names found
            across :attr:`imports`, :attr:`any_of_imports`, and
            :attr:`heavy_classes`. Used by the CLI to drive its
            per-package skip-on-missing loop.
        """
        seen: list[str] = []

        def _add(name: str) -> None:
            """Add ``name``'s top-level package to ``seen`` if not present."""
            top = name.split('.', 1)[0]
            if top and top not in seen:
                seen.append(top)

        for req in self.imports:
            _add(req.module)
        for group in self.any_of_imports:
            for alt in group.alternatives:
                _add(alt.module)
        for hc in self.heavy_classes:
            _add(hc.qualname)
        return seen


# --------------------------------------------------------------------------- #
# Internal helpers
# --------------------------------------------------------------------------- #


def _find_ignored_lines(source: str) -> set[int]:
    """
    Scan source for ``# contract-check: ignore`` comments.

    Args:
        source: Full text of a .py file.

    Returns:
        Set of 1-based line numbers that carry the ignore marker. Any import
        statement at one of these lines is dropped from the contract.
    """
    ignored: set[int] = set()
    try:
        tokens = tokenize.generate_tokens(io.StringIO(source).readline)
        for tok in tokens:
            if tok.type == tokenize.COMMENT and _IGNORE_COMMENT in tok.string:
                ignored.add(tok.start[0])
    except tokenize.TokenizeError:
        pass
    return ignored


def _is_third_party(module: str, internal: frozenset[str]) -> bool:
    """
    Decide whether a module name should be checked against upstream.

    Args:
        module:   Dotted module name as it appears in an ``import``
                  statement (e.g., ``"langchain_core.messages"``).
        internal: Set of top-level package names treated as internal by the
                  tree's :class:`Tree` config (filtered out from contracts).

    Returns:
        ``True`` when the module's top-level name is neither stdlib nor an
        internal repo package — i.e., when it represents a real third-party
        dependency the framework should verify.
    """
    if not module:
        return False
    top = module.split('.', 1)[0]
    if top in _STDLIB:
        return False
    if top in internal:
        return False
    return True


def _import_caught_as_optional(handler: ast.ExceptHandler) -> bool:
    """
    Decide whether an ``except`` clause guards optional imports.

    Args:
        handler: A single ``except`` clause from a ``try`` statement.

    Returns:
        ``True`` when the handler catches ``ImportError``,
        ``ModuleNotFoundError``, both, or is a bare ``except:`` (which also
        catches them). Used to detect version-fallback shims that should be
        modelled as :class:`AnyOf` groups rather than required imports.

    Examples:
        ``True`` for the handler in each of::

            except ImportError: ...                       # Name match
            except ModuleNotFoundError: ...               # Name match
            except (ImportError, ValueError): ...         # one element matches
            except builtins.ImportError: ...              # Attribute match
            except: ...                                   # bare — catches all

        ``False`` for::

            except ValueError: ...                        # unrelated exception
            except (KeyError, RuntimeError): ...          # no element matches
    """
    if handler.type is None:
        return True  # bare except catches everything, including ImportError
    targets: list[ast.expr] = []
    if isinstance(handler.type, ast.Tuple):
        targets.extend(handler.type.elts)
    else:
        targets.append(handler.type)
    for t in targets:
        if isinstance(t, ast.Name) and t.id in {'ImportError', 'ModuleNotFoundError'}:
            return True
        if isinstance(t, ast.Attribute) and t.attr in {'ImportError', 'ModuleNotFoundError'}:
            return True
    return False


def _dummy_for_arg(arg: ast.expr) -> str:
    """
    Pick a safe source-text dummy for one constructor argument.

    Strategy: preserve literals as-is when they're already safe (numbers,
    booleans, None, empty sequences); replace any non-literal — or a
    non-empty string/sequence — with the smallest plausible value of the
    inferred type. The dummy must be syntactically valid Python source so
    that :func:`_render_construct`'s output can be ``eval()``'d.

    Args:
        arg: AST node for one positional or keyword-value argument.

    Returns:
        A short Python source-text expression suitable for placing in an
        auto-generated construction call (e.g., ``'"x"'``, ``'0'``,
        ``'[]'``).
    """
    if isinstance(arg, ast.Constant):
        val = arg.value
        if val is None or isinstance(val, bool):
            return repr(val)
        if isinstance(val, (int, float)):
            return repr(val)
        if isinstance(val, str):
            return '"x"'
        if isinstance(val, bytes):
            return 'b"x"'
        return repr(val)
    if isinstance(arg, ast.List):
        return '[]'
    if isinstance(arg, ast.Tuple):
        return '()'
    if isinstance(arg, ast.Dict):
        return '{}'
    if isinstance(arg, ast.Set):
        return 'set()'
    return '"x"'  # safest default — most SDK constructor args are strings


def _render_construct(class_name: str, call: ast.Call) -> str:
    """
    Synthesize a construction expression from a real call's argument shape.

    Walks each positional and keyword argument of ``call`` and replaces its
    value with a type-appropriate dummy via :func:`_dummy_for_arg`. Preserves
    keyword names so SDKs that require specific kwargs still see them.

    Args:
        class_name: Bare class name to use as the callee (e.g.,
                    ``"TwelveLabs"``).
        call:       AST node of the real constructor call from source.

    Returns:
        A Python source-text expression like ``'TwelveLabs(api_key="x")'``
        that :func:`runner.verify_heavy_class` will ``eval()``. ``**kwargs``
        splats are skipped since their shape can't be synthesized.
    """
    parts: list[str] = []
    for a in call.args:
        parts.append(_dummy_for_arg(a))
    for kw in call.keywords:
        if kw.arg is None:
            continue  # skip **kwargs splat — can't synthesize
        parts.append(f'{kw.arg}={_dummy_for_arg(kw.value)}')
    return f'{class_name}({", ".join(parts)})'


def _attr_chain(node: ast.Attribute) -> Optional[tuple[str, tuple[str, ...]]]:
    """
    Decompose a dotted attribute access into its root name + attribute path.

    For ``client.indexes.create``, the AST is
    ``Attribute(value=Attribute(value=Name('client'), attr='indexes'), attr='create')``.
    This walks back to the root ``Name`` and returns the attribute names in
    left-to-right order.

    Args:
        node: ``ast.Attribute`` node, typically encountered while walking a
              function body.

    Returns:
        ``(root_name, (attr1, attr2, ...))`` when the chain is rooted at a
        bare ``Name`` (e.g., a local variable); ``None`` when the root is
        anything else (a call result, a subscript, a literal — any of which
        the framework cannot statically resolve to an imported binding).
    """
    parts: list[str] = []
    cur: ast.AST = node
    while isinstance(cur, ast.Attribute):
        parts.append(cur.attr)
        cur = cur.value
    if not isinstance(cur, ast.Name):
        return None
    return cur.id, tuple(reversed(parts))


# --------------------------------------------------------------------------- #
# Per-file visitor
# --------------------------------------------------------------------------- #


class _FileVisitor(ast.NodeVisitor):
    """
    Walks a single .py file, accumulating imports, any-of groups, and
    auto-detected heavy classes.
    """

    def __init__(self, file_path: Path, source: str, internal: frozenset[str]):
        """
        Build a fresh visitor for one source file.

        Args:
            file_path: Path of the file being walked (used only for error
                       messages and the ``HeavyClass.source`` marker).
            source:    Full text of the file — needed to scan for
                       ``# contract-check: ignore`` comments.
            internal:  Tree-specific set of internal package top-level names
                       to filter out (e.g., ``{'rocketlib', 'engLib'}``).
        """
        self.file_path = file_path
        self.internal = internal
        self.ignored_lines = _find_ignored_lines(source)

        self.imports: list[ImportRequirement] = []
        self.any_of: list[AnyOf] = []
        self.heavy_classes: list[HeavyClass] = []

        # Scope stack of bindings: name -> (qualname, ast.Call). Maps a local
        # variable name to the imported class it was assigned from and the
        # AST node of the constructor call (for argshape replay).
        self._scope_stack: list[dict[str, tuple[str, ast.Call]]] = [{}]

        # Module-scope alias map: local name -> (module, attr) where attr is
        # the symbol name imported, or '' for `import module` form. Populated
        # as we encounter top-level imports; consulted when an `ast.Call.func`
        # resolves to a Name that was imported.
        self._aliases: dict[str, tuple[str, str]] = {}

        # Per-class chains-seen-so-far map, keyed by qualname:
        # qualname -> {construct_text -> set(chain)}
        self._heavy_buf: dict[str, dict[str, set[str]]] = {}

        # True while visiting children of a try-block whose handler catches
        # ImportError / ModuleNotFoundError. In that context, nested imports
        # must not be re-recorded as required — they've already been routed
        # to AnyOf.
        self._in_import_guard: bool = False

    # ----- scope helpers -----

    def _push_scope(self) -> None:
        """Open a fresh lexical scope frame on the binding stack."""
        self._scope_stack.append({})

    def _pop_scope(self) -> None:
        """Discard the topmost lexical scope frame."""
        self._scope_stack.pop()

    def _lookup_binding(self, name: str) -> Optional[tuple[str, ast.Call]]:
        """
        Walk scope frames inside-out looking for a tracked binding.

        Args:
            name: Local variable name (e.g., ``"client"``).

        Returns:
            ``(qualname, ast.Call)`` when ``name`` was assigned the result
            of constructing a tracked imported class in some enclosing
            scope; ``None`` otherwise.
        """
        for frame in reversed(self._scope_stack):
            if name in frame:
                return frame[name]
        return None

    def _set_binding(self, name: str, value: tuple[str, ast.Call]) -> None:
        """
        Record that ``name`` in the current scope holds an SDK instance.

        Args:
            name:  Local variable name from an assignment target.
            value: ``(qualname, ast.Call)`` pair captured when the RHS was
                   a call to a tracked imported class.
        """
        self._scope_stack[-1][name] = value

    # ----- import handling -----

    def _record_import(self, module: str, symbols: tuple[str, ...]) -> None:
        """
        Append one :class:`ImportRequirement` if it's a real third-party use.

        Suppressed when the visitor is inside an import-guard ``try`` block
        (those go to :class:`AnyOf` instead) or when ``module`` filters out
        as stdlib / internal.

        Args:
            module:  Dotted module name from the import statement.
            symbols: Tuple of symbol names imported (empty for bare
                     ``import X`` form).
        """
        if self._in_import_guard:
            return
        if not _is_third_party(module, self.internal):
            return
        self.imports.append(ImportRequirement(module=module, symbols=symbols))

    def visit_Import(self, node: ast.Import) -> None:
        """
        Handle a top-level ``import X`` or ``import X as Y`` statement.

        Args:
            node: AST node for the import statement.
        """
        if node.lineno in self.ignored_lines:
            return
        for alias in node.names:
            # Don't register internal-package aliases. Otherwise heavy-class
            # auto-detection would treat `import rocketlib; rocketlib.X(...)`
            # as a third-party SDK contract and emit a spurious HeavyClass.
            if not _is_third_party(alias.name, self.internal):
                continue
            local = alias.asname or alias.name.split('.', 1)[0]
            self._aliases[local] = (alias.name, '')
            self._record_import(alias.name, ())

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        """
        Handle a ``from X import Y`` statement.

        Relative imports (``from . import X``) are dropped: by construction
        they reach into the repo, not into third-party packages.

        Args:
            node: AST node for the from-import statement.
        """
        if node.lineno in self.ignored_lines:
            return
        if node.level and node.level > 0:
            return  # relative import, internal by construction
        module = node.module or ''
        if not module:
            return
        # Same internal filter as visit_Import — internal aliases must NOT
        # land in the alias map, or heavy-class auto-detection picks them
        # up and emits spurious entries like rocketlib.getServiceDefinition.
        if not _is_third_party(module, self.internal):
            return
        symbols = tuple(a.name for a in node.names if a.name != '*')
        for a in node.names:
            local = a.asname or a.name
            if a.name != '*':
                self._aliases[local] = (module, a.name)
        self._record_import(module, symbols)

    def visit_Try(self, node: ast.Try) -> None:
        """
        Inspect a ``try`` and route guarded imports to :class:`AnyOf`.

        Imports inside ``try / except (ImportError, ModuleNotFoundError)``
        are version-fallback shims, not required imports. The shim's
        alternatives all go into a single ``AnyOf`` group; non-import code
        inside the try is still walked normally (with an internal flag set
        so nested imports aren't double-recorded).

        Args:
            node: AST node for the try statement.
        """
        if not any(_import_caught_as_optional(h) for h in node.handlers):
            # Not an import-guard try; walk normally.
            self.generic_visit(node)
            return

        alternatives = self._extract_alternative_imports(node)
        if alternatives:
            self.any_of.append(AnyOf(alternatives=tuple(alternatives)))

        # Still walk the bodies for non-import statements (attribute chains
        # etc.) but mark the context so nested imports aren't re-recorded.
        prev = self._in_import_guard
        self._in_import_guard = True
        try:
            for child in ast.iter_child_nodes(node):
                if isinstance(child, (ast.Import, ast.ImportFrom)):
                    continue
                self.visit(child)
        finally:
            self._in_import_guard = prev

    def _extract_alternative_imports(self, try_node: ast.Try) -> list[ImportRequirement]:
        """
        Collect import statements from a try-body + its import-guard handlers.

        Only handlers that actually catch an import error contribute
        alternatives (see :func:`_import_caught_as_optional`). Imports under a
        handler for an unrelated exception are *not* fallbacks for the guarded
        import and must not be folded into the :class:`AnyOf` group.

        Args:
            try_node: AST node for an import-guard try statement.

        Returns:
            List of :class:`ImportRequirement` — one per third-party import
            seen in the try body or an import-guard handler body. Side effect:
            also updates ``self._aliases`` so any chains using these imports
            still resolve.

        Example:
            For::

                try:
                    import fast_json as json  # alternative
                except ImportError:
                    import json  # alternative (real fallback)
                except ValueError:
                    import unrelated  # NOT an alternative — skipped

            returns ``[ImportRequirement('fast_json'), ImportRequirement('json')]``;
            ``unrelated`` is ignored because ``except ValueError`` does not
            catch an import error.
        """
        alts: list[ImportRequirement] = []

        def _scan(stmts: list[ast.stmt]) -> None:
            for s in stmts:
                if isinstance(s, ast.ImportFrom):
                    module = s.module or ''
                    if not module or not _is_third_party(module, self.internal):
                        continue
                    syms = tuple(a.name for a in s.names if a.name != '*')
                    alts.append(ImportRequirement(module=module, symbols=syms))
                    # Also register aliases so attribute walks find the symbol.
                    for a in s.names:
                        if a.name == '*':
                            continue
                        local = a.asname or a.name
                        self._aliases[local] = (module, a.name)
                elif isinstance(s, ast.Import):
                    for alias in s.names:
                        if not _is_third_party(alias.name, self.internal):
                            continue
                        alts.append(ImportRequirement(module=alias.name, symbols=()))
                        local = alias.asname or alias.name.split('.', 1)[0]
                        self._aliases[local] = (alias.name, '')

        _scan(try_node.body)
        for h in try_node.handlers:
            if _import_caught_as_optional(h):
                _scan(h.body)
        return alts

    # ----- function/class scope recursion -----

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        """
        Enter a function body with a fresh binding scope.

        Args:
            node: AST node for the ``def`` statement.
        """
        self._push_scope()
        try:
            self.generic_visit(node)
        finally:
            self._pop_scope()

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        """
        Enter an async function body with a fresh binding scope.

        Args:
            node: AST node for the ``async def`` statement.
        """
        self._push_scope()
        try:
            self.generic_visit(node)
        finally:
            self._pop_scope()

    # ----- assignment tracking (data-flow) -----

    def visit_Assign(self, node: ast.Assign) -> None:
        """
        Track variable assignments whose RHS constructs a tracked class.

        ``client = TwelveLabs(api_key=key)`` registers ``client`` as bound
        to ``twelvelabs.TwelveLabs`` in the current scope. Subsequent
        ``client.xxx`` chains are then attributed to that SDK class via
        :meth:`visit_Attribute`.

        Args:
            node: AST node for the assignment statement.
        """
        self.generic_visit(node)  # recurse first so call args etc. are visited
        if not isinstance(node.value, ast.Call):
            return
        call = node.value
        func = call.func
        # Recognise bare-name calls: `client = TwelveLabs(...)`
        if isinstance(func, ast.Name) and func.id in self._aliases:
            module, symbol = self._aliases[func.id]
            if not symbol:
                # `import X` form — `X(...)` constructs a module attribute, not
                # something we model. Skip.
                return
            qualname = f'{module}.{symbol}'
            for target in node.targets:
                if isinstance(target, ast.Name):
                    self._set_binding(target.id, (qualname, call))

    # ----- attribute chain detection -----

    def visit_Attribute(self, node: ast.Attribute) -> None:
        """
        Inspect a dotted attribute access for SDK-client chain detection.

        Two cases:
          * Root name is a local variable previously bound to an SDK class
            via :meth:`visit_Assign` — record the chain in the heavy-class
            buffer (will become a :class:`HeavyClass` on finalisation).
          * Root name is an alias for an imported module — left to the
            runner's class-level :func:`runner.verify_class_attrs` checks;
            no extraction needed here.

        Args:
            node: AST node for the attribute access.
        """
        self.generic_visit(node)
        decomposed = _attr_chain(node)
        if decomposed is None:
            return
        root_name, attrs = decomposed
        if not attrs:
            return
        # Case A: root_name is a local bound to an SDK class — heavy-class chain.
        bound = self._lookup_binding(root_name)
        if bound is not None:
            qualname, call = bound
            class_name = qualname.rsplit('.', 1)[-1]
            construct = _render_construct(class_name, call)
            chain = '.'.join(attrs)
            self._heavy_buf.setdefault(qualname, {}).setdefault(construct, set()).add(chain)
            return
        # Case B: root_name is an alias for an imported module — class-level
        # attribute walks (e.g., `np.array`) are validated separately by the
        # runner using `getattr` on the imported module/symbol. No extraction
        # needed here.

    # ----- finalisation -----

    def finalise(self) -> None:
        """
        Flush the per-class attribute buffer into :class:`HeavyClass` entries.

        Call this once after :meth:`visit` has walked the whole module.
        Side effect: populates ``self.heavy_classes``. No return value;
        caller reads results off the visitor's public lists.
        """
        line = 1  # we don't track call line precisely; default to 1
        for qualname, by_construct in self._heavy_buf.items():
            for construct, chains in by_construct.items():
                self.heavy_classes.append(
                    HeavyClass(
                        qualname=qualname,
                        construct=construct,
                        attr_chains=tuple(sorted(chains)),
                        source=f'{self.file_path}:{line}',
                    )
                )


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #


def extract_component(tree: Tree, component_dir: Path) -> ComponentContract:
    """
    Build the auto-extracted contract for one component (= one directory of
    .py files), then overlay any per-component ``external_contracts.py``.

    Args:
        tree:          The :class:`Tree` config this component lives in.
        component_dir: Component directory containing one or more .py files.

    Returns:
        Fully resolved :class:`ComponentContract` ready for the runner.
    """
    contract = ComponentContract(
        tree_name=tree.name,
        component_name=component_dir.name,
        component_dir=component_dir,
    )

    for py in sorted(component_dir.rglob('*.py')):
        # external_contracts.py is the manifest itself — its imports are
        # framework wiring, not runtime production code, so they must not
        # be auto-extracted into the contract.
        if py.name == 'external_contracts.py':
            continue
        try:
            source = py.read_text(encoding='utf-8')
            module_ast = ast.parse(source, filename=str(py))
        except (SyntaxError, UnicodeDecodeError):
            continue
        v = _FileVisitor(py, source, tree.internal_packages)
        v.visit(module_ast)
        v.finalise()
        contract.imports.extend(v.imports)
        contract.any_of_imports.extend(v.any_of)
        contract.heavy_classes.extend(v.heavy_classes)

    # Dedupe imports by (module, symbols) signature, preserving order.
    contract.imports = _dedupe_imports(contract.imports)

    _apply_manifest(contract)
    return contract


def _dedupe_imports(reqs: list[ImportRequirement]) -> list[ImportRequirement]:
    """
    Merge requirements that target the same module, unioning their symbols.

    Walking a multi-file component naturally produces several
    :class:`ImportRequirement` entries for the same module (e.g., one file
    imports ``X``, another imports ``X.Y``). This collapses them into one
    entry per module so the runner doesn't import the same module N times.

    Args:
        reqs: Possibly-duplicate requirements as emitted by ``_FileVisitor``.

    Returns:
        Deduped list, preserving first-seen module order. Each entry's
        ``symbols`` is the sorted union of all matching inputs' symbols.
    """
    by_module: dict[str, set[str]] = {}
    order: list[str] = []
    for r in reqs:
        if r.module not in by_module:
            by_module[r.module] = set()
            order.append(r.module)
        by_module[r.module].update(r.symbols)
    return [ImportRequirement(module=m, symbols=tuple(sorted(by_module[m]))) for m in order]


def _apply_manifest(contract: ComponentContract) -> None:
    """
    Overlay a per-component manifest, if one exists, on top of ``contract``.

    Manifest entries take precedence over auto-extracted entries. Matching
    rules:

    * **Imports:** a manifest :class:`ImportRequirement` with a given
      ``module`` replaces any auto-extracted entry for the same module
      (regardless of symbols overlap). Reason: the manifest captures the
      maintainer's intent — e.g., that the import is version-gated
      (``applies_when='<2.0'``). Letting the unconditional auto-extracted
      entry survive alongside would defeat the gate.
    * **Heavy classes:** a manifest :class:`HeavyClass` with a given
      ``qualname`` replaces any auto-extracted entry for the same class.
    * **AnyOf groups:** always additive (no natural "same group" match).
    * **skip_packages:** drops auto-extracted AND manifest entries for the
      named top-level packages. For an :class:`AnyOf`, only the skip-listed
      *alternatives* are removed; the group survives (with its remaining
      alternatives) unless every alternative was skip-listed.

    Args:
        contract: Component contract built from AST extraction; mutated
                  in place to fold in the manifest.

    Example:
        Given ``skip_packages={'pycryptodome'}`` and an auto-extracted group
        ``AnyOf(cryptography.X, pycryptodome.X)``, the result is
        ``AnyOf(cryptography.X)`` — the skip-listed alternative is stripped,
        but the group is kept so ``cryptography.X`` is still verified. A group
        whose only alternative is ``pycryptodome.X`` is dropped entirely.
    """
    from contract_checks.manifest import load_manifest  # local import to avoid cycle

    manifest: Optional[ComponentManifest] = load_manifest(contract.component_dir)
    if manifest is None:
        return

    # Imports: manifest entries replace auto-extracted entries with the
    # same module. Build a set of module names the manifest covers, drop
    # auto-extracted entries that match, then append the manifest entries.
    if manifest.imports:
        manifest_modules = {r.module for r in manifest.imports}
        contract.imports = [r for r in contract.imports if r.module not in manifest_modules]
        contract.imports.extend(manifest.imports)

    # AnyOf groups: additive. No natural "same group" identity, so we
    # don't try to match. If the manifest's AnyOf overlaps with an
    # auto-extracted one, both run (both pass on matching versions —
    # harmless redundancy).
    contract.any_of_imports.extend(manifest.any_of_imports)

    # Heavy classes: manifest entries replace auto-extracted with the same
    # qualname. Same logic as imports.
    if manifest.heavy_classes:
        manifest_quals = {hc.qualname for hc in manifest.heavy_classes}
        contract.heavy_classes = [hc for hc in contract.heavy_classes if hc.qualname not in manifest_quals]
        contract.heavy_classes.extend(manifest.heavy_classes)

    # Skip list removes ALL entries (auto + manifest) for the named packages.
    if manifest.skip_packages:
        contract.imports = [r for r in contract.imports if r.module.split('.', 1)[0] not in manifest.skip_packages]
        contract.heavy_classes = [
            h for h in contract.heavy_classes if h.qualname.split('.', 1)[0] not in manifest.skip_packages
        ]
        filtered_groups: list[AnyOf] = []
        for g in contract.any_of_imports:
            kept = tuple(alt for alt in g.alternatives if alt.module.split('.', 1)[0] not in manifest.skip_packages)
            if kept:
                # replace() preserves the group's own applies_when gate;
                # a bare AnyOf(alternatives=kept) would silently lose it.
                filtered_groups.append(replace(g, alternatives=kept))
        contract.any_of_imports = filtered_groups


def iter_components(tree: Tree) -> list[Path]:
    """
    Discover the component directories within a tree.

    A component is a directory that either contains a ``requirements.txt``
    (= proper per-component layout, as in ``nodes/``) or is the tree root
    itself when no per-directory requirements are present (collapsed-tree
    case, as in ``rocketlib/lib``).

    Args:
        tree: Tree to inspect.

    Returns:
        Sorted list of component directories. Always at least one entry
        (the tree root itself) so the framework still scans flat-layout trees.
    """
    if not tree.root.exists():
        return []

    per_component: list[Path] = []
    for entry in sorted(tree.root.iterdir()):
        if not entry.is_dir():
            continue
        if entry.name.startswith(('.', '__')):
            continue
        if (entry / 'requirements.txt').exists():
            per_component.append(entry)

    if per_component:
        return per_component
    return [tree.root]
