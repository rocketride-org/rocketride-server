# Mypy diagnosis: client-python

**Summary:** Mypy reports **320 errors in 34 files** when run from the repo root with `[tool.mypy]` in `pyproject.toml` (strict mode: `strict = true`, `disallow_untyped_defs = true`). Below are the main categories and how to fix them.

---

## 1. Incompatible default `None` (implicit Optional) — **~40+ errors**

**Cause:** Parameters typed as `str`, `int`, `dict`, etc. but given `= None`. PEP 484: a default of `None` requires the type to be `Optional[T]` or `T | None`.

**Examples:**
- `mixins/execution.py`: `token: str = None`, `filepath: str = None`, `pipeline: Dict[str, Any] = None`, `args: List[str] = None`, etc.
- `mixins/data.py`: `objinfo: Dict[str, Any] = None`, `mime_type: str = None`, `provider: str = None`, `mimetype: str = None`
- `mixins/ping.py`: `token: str = None`
- `core/dap_base.py`: `token: str = None`, `arguments: ... = None`, `data: ... = None`, `id: str = None`
- `cli/utils/formatters.py`: `end_time: float = None`
- `cli/monitors/base.py`, `upload.py`, `status.py`, `generic.py`, `events.py`: `width: int = None`, `height: int = None`

**Fix:** Use `Optional[T]` (or `T | None` on 3.10+), e.g.:
- `token: Optional[str] = None`
- `width: Optional[int] = None`
- `pipeline: Optional[Dict[str, Any]] = None`

---

## 2. Missing type annotations (no-untyped-def) — **~80+ errors**

**Cause:** `disallow_untyped_defs = true` requires every function to have typed parameters and return type.

**Affected:** Many functions across `schema/` (question.py, doc_metadata.py, doc.py, doc_group.py, doc_filter.py), `cli/` (main.py, commands/*.py, monitors/*.py, utils/*.py, ui/display.py), `core/` (dap_base.py, dap_client.py, transport.py, transport_websocket.py), `mixins/` (execution.py, connection.py, events.py, data.py, chat.py, ping.py, services.py), `client.py`.

**Fix:** Add parameter and return types to every function. Use `-> None` for procedures. For `**kwargs` or complex signatures, use explicit types or `Any` where necessary.

---

## 3. Pydantic / BaseModel — "Class cannot subclass BaseModel (has type Any)" — **~15 errors**

**Cause:** With `ignore_missing_imports = true`, mypy does not load pydantic’s stubs, so `BaseModel` is `Any` and subclassing it is rejected.

**Affected:** `types/task.py`, `schema/doc_metadata.py`, `schema/doc_filter.py`, `schema/doc.py`, `schema/question.py`, `schema/doc_group.py`.

**Fix (pick one):**
- Install pydantic with type stubs and ensure mypy can see them (e.g. use a venv where pydantic is installed and do **not** ignore it for that package), or
- Add a `[tool.mypy.overrides]` section for the pydantic package so mypy uses its types, or
- For the specific modules that subclass BaseModel, use `# type: ignore[misc]` on the class line (least ideal).

---

## 4. Missing generic type parameters (type-arg) — **~15 errors**

**Cause:** Generics must be fully parameterized, e.g. `dict` → `dict[str, Any]`, `list` → `list[str]`, `tuple` → `tuple[str, int]`, `set` → `set[str]`, `Future` → `asyncio.Future[Dict[str, Any]]`, `Task` → `asyncio.Task[None]`.

**Examples:**
- `types/task.py`: `notes: List[Union[str, dict]]` → e.g. `dict[str, Any]`
- `schema/question.py`: `dict`, `list`, `Dict` without parameters
- `core/dap_client.py`: `Dict[int, asyncio.Future]` → `Dict[int, asyncio.Future[Dict[str, Any]]]`
- `core/transport_websocket.py`: `set` without parameters
- `mixins/connection.py`: `Task` without parameters
- `cli/monitors/status.py`: `tuple` without parameters
- `cli/monitors/events.py`: `dict` without parameters

**Fix:** Add the correct type parameters to every generic type.

---

## 5. Optional/union attribute access (union-attr) — **~25 errors**

**Cause:** Calling `.append`, `.get`, or other methods on a value that might be `None` (e.g. `list[...] | None` or `Any | None`) without a guard.

**Examples:**
- `schema/question.py`: `self.instructions.append(...)` when `instructions` is `Optional[List[...]]`; same for `examples`, `history`, `questions`, `documents`, `context`.
- `schema/doc.py`: `metadata.objectId` when `metadata` can be `DocMetadata | None`.
- `core/dap_client.py`, `core/transport_websocket.py`: `self._transport.send(...)` when `_transport` is `Any | None`.
- `mixins/data.py`: `None.get(...)`.
- `cli/commands/upload.py`: `client.set_events` when `client` may be None.

**Fix:** Guard with `if x is not None:` or assert, or use default (e.g. `(self.instructions or []).append(...)`), or narrow type before use.

---

## 6. Incompatible assignment / return (assignment, return-value, no-any-return) — **~30 errors**

**Cause:** Assigning or returning a value whose type does not match the declared type; or returning `Any` from a function declared to return a concrete type.

**Examples:**
- `core/transport.py`: Callbacks assigned to variables initially set to `None`; variable type should be `Optional[Callable[...]]`.
- `client.py`: `_uri` typed as `str` but assigned `str | None`.
- `mixins/connection.py`: `get_connection_info` returns `Any` but declared `str | None`.
- `mixins/data.py`: List element type vs `UPLOAD_RESULT`; `result_types` / similar assigned from `dict[str, Any] | None` to `dict[str, str]`.
- `schema/question.py`: Return type `dict | None` vs actual `dict | list`.
- `cli/utils/file_utils.py`: `Path` vs `str`; return `list[Path]` vs declared `list[str]`.
- `cli/main.py`: Variable typed `int` assigned `float`; function returning value but declared `-> None`.

**Fix:** Align variable/return types with actual values; for return values that are genuinely dynamic, either broaden the return type or cast and document.

---

## 7. Attribute defined on subclass only (attr-defined) — **~15 errors**

**Cause:** Mixins reference attributes that are set on the full class (e.g. `RocketRideClient`) but not on the mixin or base. Mypy checks each class in isolation.

**Examples:**
- `ExecutionMixin` / `DataMixin`: `self._apikey`, `self._caller_on_event`.
- `ConnectionMixin`: `self._debug_message`.
- `ChatMixin`: `self.pipe` (comes from DataMixin when combined in client).
- `DAPBase`: `on_receive` (defined on subclass).
- `core/transport_websocket.py`: `self._websocket` stored as `object`; mypy then says `"object" has no attribute "close"`, `"send"`, etc.

**Fix:** In mixins, either declare the attributes (e.g. `_apikey: Optional[str] = None`) or use a Protocol that defines the interface the mixin expects. For `_websocket`, type it as the real websocket type (e.g. from `websockets` library) or a minimal Protocol with the methods used.

---

## 8. Signature incompatible with supertype (override) — **~6 errors**

**Cause:** Overriding a method with a different signature (e.g. extra required parameter).

**Examples:**
- `ConnectionMixin.connect(self, uri=..., auth=..., timeout=...)` vs `DAPClient.connect(self, timeout=...)`.
- `BaseCommand.execute(self)` vs `StartCommand.execute(self, client)` (and same for upload, stop, status, events).

**Fix:** Make the override compatible: same parameter list (or use optional `client` with default), or refactor base class to accept optional `client` so all subclasses match.

---

## 9. Module does not explicitly export attribute (attr-defined) — **5 errors**

**Cause:** Other modules do `from python.cli.main import RocketRideClient` but `RocketRideClient` is not in `__all__` of `cli/main.py`.

**Affected:** `cli/commands/upload.py`, `stop.py`, `status.py`, `start.py`, `events.py`.

**Fix:** In `cli/main.py`, add `RocketRideClient` to `__all__` (or export it where the CLI actually gets it from).

---

## 10. Call to untyped function (no-untyped-call) — **~50+ errors**

**Cause:** Calling functions that have no type annotations (e.g. `draw()`, `clear()`, `clear_screen()`, `cursor_home()`, `add_common_args()`, `RocketRideCLI()`, various `__init__` and helpers). Under `disallow_untyped_defs`, mypy flags calls into untyped code.

**Fix:** Add type annotations to those functions (and their modules) so the whole call chain is typed. Start with the most-called helpers (e.g. in `cli/monitors/base.py`, `cli/ui/display.py`, `cli/main.py`).

---

## 11. Other single-file or few-off issues**

- **dap_base.py:** `DAPBase` references `on_receive` (doesn’t exist on base); `_call_debug_message` / `_call_debug_protocol` “could always be true in boolean context” (use `if self._call_debug_message is not None:`); “Unsupported target for indexed assignment” (assigning to `object`).
- **dap_client.py:** Missing return in one path; `on_connected` argument `str | None` vs base `str`.
- **transport_websocket.py:** `_receive_task` type `None` vs `Task[None]`; websocket stored as `object` (see attr-defined above).
- **task.py:** `notes` already `List[Union[str, dict]]` but mypy wants full generic (e.g. `dict[str, Any]`).
- **doc_metadata.py:** `defaultMetadata(pInstance: Any, **overrides)` untyped; return type of `toDict` and similar.
- **question.py:** Optional list attributes (e.g. `instructions`) used without None check in `getPrompt` and iteration; `addContext` assignment type; return types of `getJson`, `parseJson`, etc.
- **cli/main.py:** Abstract `BaseCommand` instantiated; `execute` called with too many arguments; float/int assignment.

---

## Recommended order of fixes

1. **Optional defaults:** Fix all `X = None` parameters to `Optional[X] = None` (or `X | None`). This removes a large block of errors and is mechanical.
2. **Generics:** Add missing type parameters to `dict`, `list`, `tuple`, `set`, `Future`, `Task`.
3. **Pydantic:** Fix BaseModel subclass errors (stubs or overrides or targeted ignore).
4. **Export:** Add `RocketRideClient` (and any other needed names) to `__all__` in `cli/main.py`.
5. **Mixin attributes:** Declare or Protocol the attributes that mixins expect (`_apikey`, `_caller_on_event`, `_debug_message`, `pipe`, etc.).
6. **Override signatures:** Align `connect()` and `execute()` overrides with base class (or adjust base).
7. **Union/optional attribute access:** Add None checks or defaults before using optional lists/objects.
8. **Untyped functions:** Add annotations to CLI helpers, monitors, and main so `no-untyped-call` and `no-untyped-def` are resolved.
9. **Remaining assignments/returns:** Tighten variable types and return types so they match actual values.

---

## Quick reference: run mypy

From repo root (uses root `pyproject.toml`):

```bash
python -m mypy packages/client-python/src/clients/python
```

To only check the library (no CLI):

```bash
python -m mypy packages/client-python/src/clients/python --exclude 'cli/'
```

To relax checks temporarily (e.g. only implicit Optional), you can add a `[tool.mypy]` or override in `packages/client-python/pyproject.toml` (e.g. `disallow_untyped_defs = false`) and run mypy from that package; the root config will still apply unless overridden per-package.
