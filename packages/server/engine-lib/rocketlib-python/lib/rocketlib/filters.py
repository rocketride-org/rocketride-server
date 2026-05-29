# =============================================================================
# MIT License
#
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

from __future__ import annotations  # Enables forward references
import json
import mimetypes
from typing import TYPE_CHECKING, Dict, Any, Iterable, List, Optional, TypedDict, Callable, Protocol
from .types import OPEN_MODE, ENDPOINT_MODE, SERVICE_MODE, Entry, IControl, IInvoke
from .error import APERR, Ec

if TYPE_CHECKING:
    from ai.common.schema import Doc, Question, Answer


# =========================================================================
# Invoke / Tool decorator plumbing
#
# These primitives let any IInstanceBase subclass declare invoke handlers
# and tool entry points via decorators.  No external dependencies.
# =========================================================================


class ToolDescriptor(TypedDict, total=False):
    """Canonical tool descriptor returned by ``tool.query``."""

    name: str
    description: str
    inputSchema: Dict[str, Any]
    outputSchema: Dict[str, Any]


def invoke_function(fn: Callable) -> Callable:
    """Mark a method as an invoke handler.

    The method name becomes the op name.  When ``invoke()`` is called with
    a param whose ``op`` matches, this method is dispatched::

        @invoke_function
        def ask(self, param):
            return self._chat.chat(param.question)
    """
    fn.__invoke_op__ = fn.__name__
    return fn


def tool_function(
    *,
    input_schema: Any = None,
    description: Any = None,
    output_schema: Any = None,
) -> Callable:
    """Mark a method as a tool entry point.

    The method name becomes the bare tool ID.  Each parameter accepts either
    a static value or a ``callable(self)`` evaluated at ``tool.query`` time.

    ``@tool_function`` implicitly registers the method as an invoke handler
    for the ``tool.*`` ops — no separate ``@invoke_function`` needed::

        @tool_function(input_schema={...}, description='...')
        def get_data(self, args): ...
    """

    def decorator(fn: Callable) -> Callable:
        fn.__tool_meta__ = {
            'input_schema': input_schema,
            'description': description,
            'output_schema': output_schema,
        }
        return fn

    return decorator


# =========================================================================
# Tool input normalisation
#
# Agents call tools with payloads that the engine's invoke pipeline can
# deliver in several shapes — plain dicts, Pydantic models, JSON strings,
# or wrapped envelopes such as {"input": {...}, "security_context": ...}.
# Every tool node used to ship its own copy of this normalisation
# function; consolidating into one canonical helper means bug fixes and
# behaviour decisions live in one place.
# =========================================================================


def normalize_tool_input(
    input_obj: Any,
    *,
    extra_envelope_keys: Iterable[str] = (),
    strip_keys: Iterable[str] = ('security_context',),
    parse_json_strings: bool = True,
    unwrap_pydantic: bool = True,
    tool_name: str = 'tool',
) -> Dict[str, Any]:
    """Coerce agent-supplied tool input to a plain args dict.

    Handles, in order:
      1. ``None`` -> ``{}``
      2. Pydantic model unwrap (via ``model_dump()`` / ``dict()``) when
         ``unwrap_pydantic`` is True.
      3. JSON-string parse when ``parse_json_strings`` is True. A string
         that does not parse to a dict is left unchanged (and falls through
         to the unexpected-type branch below).
      4. Anything still not a dict -> ``{}`` after a ``warning(...)``.
      5. Nested envelope unwrap: any of ``('input', *extra_envelope_keys)``
         whose value is a dict is merged into the top level. Top-level keys
         win on conflict (so a sibling key beside the envelope overrides
         the one inside it).
      6. Strip every key listed in ``strip_keys``.

    Args:
        input_obj: Raw tool input as delivered by the engine's invoke chain.
        extra_envelope_keys: Additional keys that, like ``input``, wrap the
            real arguments and should be unwrapped/merged.
        strip_keys: Keys to drop from the final dict before returning.
            Defaults to ``('security_context',)`` — engine-injected and
            never a tool arg. Pass ``()`` to disable stripping, or a list
            to add more (e.g. ``('security_context', 'trace_id')``).
        parse_json_strings: Try ``json.loads`` on string inputs. Set False
            for tools where the engine path is known never to deliver a
            JSON-encoded string.
        unwrap_pydantic: Call ``model_dump()`` / ``dict()`` on objects that
            expose them. Set False for tools where the engine path never
            delivers a Pydantic instance.
        tool_name: Short identifier prefixed onto warning messages so
            unexpected-input traces are attributable to a specific node.

    Returns:
        A plain ``dict`` of normalised tool arguments. Returns ``{}`` for
        inputs that cannot be coerced (e.g. integers, lists, malformed
        JSON), after emitting a warning.
    """
    if input_obj is None:
        return {}

    if unwrap_pydantic:
        model_dump = getattr(input_obj, 'model_dump', None)
        if callable(model_dump):
            input_obj = model_dump()
        else:
            as_dict = getattr(input_obj, 'dict', None)
            if callable(as_dict):
                input_obj = as_dict()

    if parse_json_strings and isinstance(input_obj, str):
        try:
            parsed = json.loads(input_obj)
        except (json.JSONDecodeError, TypeError):
            parsed = None
        if isinstance(parsed, dict):
            input_obj = parsed

    if not isinstance(input_obj, dict):
        # Lazy import: engine.py imports from filters.py, so we can't pull
        # warning() at module load.
        from .engine import warning

        warning(f'{tool_name}: unexpected input type {type(input_obj).__name__}')
        return {}

    # Shallow-copy so the envelope-merge and the strip_keys pop below
    # never mutate a caller-owned dict.
    input_obj = dict(input_obj)

    for key in ('input', *extra_envelope_keys):
        wrapped = input_obj.get(key)
        if isinstance(wrapped, dict):
            extras = {k: v for k, v in input_obj.items() if k != key}
            input_obj = {**wrapped, **extras}

    for key in strip_keys:
        input_obj.pop(key, None)
    return input_obj


# =========================================================================
# Tool argument validators
#
# Tool nodes used to ship private ``_require_str`` / ``_require_int`` /
# ``_optional_str`` helpers with subtly inconsistent semantics — for
# example, tool_github's ``_require_str`` crashed with ``AttributeError``
# on truthy non-string inputs, while tool_filesystem's variant raised a
# clean ValueError. Centralising the helpers here lets every tool node
# get the same validation behaviour and leaves room to fix bugs in one
# place.
# =========================================================================


def require_str(args: Dict[str, Any], key: str, *, tool_name: str = '') -> str:
    """Return ``args[key]`` as a non-empty stripped string, or raise ValueError.

    Args:
        args: The normalised tool args dict (typically the output of
            :func:`normalize_tool_input`).
        key: The required argument name.
        tool_name: Short identifier prefixed onto error messages — usually
            the tool function name (``'file_create'``) or node name
            (``'tool_github'``). Empty string omits the prefix.

    Raises:
        ValueError: If ``key`` is missing, not a string, or is empty/whitespace.
    """
    val = args.get(key)
    if not isinstance(val, str) or not val.strip():
        prefix = f'{tool_name}: ' if tool_name else ''
        raise ValueError(f'{prefix}"{key}" is required and must be a non-empty string')
    return val.strip()


def require_int(
    args: Dict[str, Any],
    key: str,
    *,
    lo: Optional[int] = None,
    hi: Optional[int] = None,
    tool_name: str = '',
) -> int:
    """Return ``args[key]`` coerced to ``int``, or raise ValueError.

    Accepts plain ints and numeric strings. The following are rejected with
    a ValueError instead of being silently coerced:

    * ``bool`` — despite being an ``int`` subclass, ``{"issue_number": true}``
      almost never means ``1``.
    * ``float`` — ``int(3.7)`` would truncate to ``3``, and ``inf`` / ``nan``
      would leak an ``OverflowError`` / ``ValueError`` from ``int()``.
    * Any other non-(int|str) type, e.g. lists, dicts, ``Decimal``.

    Optional bounds:

    * ``lo`` — if set, the value must be ``>= lo``.
    * ``hi`` — if set, the value must be ``<= hi``.
    * Both — the value must lie in ``[lo, hi]``.
    * Neither — no range check.

    The error message advertises the configured bounds so the agent can
    see what range it should retry within.
    """
    prefix = f'{tool_name}: ' if tool_name else ''
    val = args.get(key)
    if val is None:
        raise ValueError(f'{prefix}"{key}" is required')
    # bool is an int subclass and float would truncate — keep str and real
    # int as the only inputs that reach the coercion below. OverflowError
    # is also caught for defence-in-depth (e.g. ``int('1' * 10**6)`` is
    # technically valid but takes minutes; an opaque traceback would be
    # worse than the friendly message).
    if isinstance(val, (bool, float)) or not isinstance(val, (int, str)):
        raise ValueError(f'{prefix}"{key}" must be an integer{_range_phrase(lo, hi)}')
    try:
        out = int(val)
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f'{prefix}"{key}" must be an integer{_range_phrase(lo, hi)}')
    if lo is not None and out < lo:
        raise ValueError(f'{prefix}"{key}" must be an integer{_range_phrase(lo, hi)}')
    if hi is not None and out > hi:
        raise ValueError(f'{prefix}"{key}" must be an integer{_range_phrase(lo, hi)}')
    return out


def _range_phrase(lo: Optional[int], hi: Optional[int]) -> str:
    """Render ' between LO and HI' / ' >= LO' / ' <= HI' / ''."""
    if lo is not None and hi is not None:
        return f' between {lo} and {hi}'
    if lo is not None:
        return f' >= {lo}'
    if hi is not None:
        return f' <= {hi}'
    return ''


def require_bool(args: Dict[str, Any], key: str, *, tool_name: str = '') -> bool:
    """Return ``args[key]`` as ``bool``, or raise ValueError.

    Strict on type to keep agent intent unambiguous. Accepts ``True`` and
    ``False`` only — no truthy coercion of ``1``/``0``/``"true"``/``"false"``,
    because schemas declared ``"type": "boolean"`` mean exactly that and
    a coerced string smells like an LLM hallucination worth flagging.

    For optional booleans (typical schema default), call
    ``args.setdefault(key, <default>)`` before this helper.
    """
    prefix = f'{tool_name}: ' if tool_name else ''
    val = args.get(key)
    if val is None:
        raise ValueError(f'{prefix}"{key}" is required')
    if not isinstance(val, bool):
        raise ValueError(f'{prefix}"{key}" must be a boolean')
    return val


def validate_tool_input_schema(
    input_schema: Dict[str, Any],
    args: Dict[str, Any],
    *,
    tool_name: str = '',
) -> None:
    """Reject any *args* keys not declared in ``input_schema['properties']``.

    Without this check, a hallucinated parameter name (e.g. ``include_remote``
    instead of the schema's ``remote``) is silently dropped by the dispatcher
    and the call returns a default-valued result the agent then misreads —
    "this tool doesn't support remotes" — and gives up. Raising a clean
    ValueError that names the bad key and lists the allowed ones lets the
    agent self-correct on the next turn.

    The framework's ``@tool_function`` only uses ``input_schema`` to build
    the ``tool.query`` descriptor; runtime validation is opt-in via this
    helper. Pair it with :func:`normalize_tool_input` for the typical
    "strip envelope, then validate" pattern at tool-method entry.

    Args:
        input_schema: The JSON-schema-shaped dict that's also passed to
            ``@tool_function``. Only ``input_schema['properties']`` is
            consulted; missing or ``None`` is treated as "no allowed keys".
        args: The (already-normalised) tool arguments dict.
        tool_name: Short identifier prefixed onto error messages so an
            agent looking at multiple errors can attribute each to the
            specific tool. Empty string omits the prefix.

    Raises:
        ValueError: If ``args`` contains any key not in
            ``input_schema['properties']``. The message lists the unknown
            keys and the allowed ones (or "this tool takes no parameters"
            for schemas with empty properties).
    """
    allowed = set((input_schema.get('properties') or {}).keys())
    unknown = sorted(k for k in args if k not in allowed)
    if not unknown:
        return
    prefix = f'{tool_name}: ' if tool_name else ''
    if allowed:
        raise ValueError(f'{prefix}unknown parameter(s) {unknown}. Allowed parameters: {sorted(allowed)}.')
    raise ValueError(f'{prefix}this tool takes no parameters; received unexpected: {unknown}.')


def optional_bool(
    args: Dict[str, Any],
    key: str,
    *,
    default: Any = None,
    tool_name: str = '',
) -> Any:
    """Return ``args[key]`` as ``bool``, or ``default`` if absent/None.

    Type rules mirror :func:`require_bool` exactly when the key is present
    (strict ``True`` / ``False`` only — no truthy coercion of ``1``/``0``/
    ``"true"``). The only difference is the absent-key path: instead of
    raising "is required", ``default`` is returned.

    Following :func:`optional_str`: type validation only fires when ``key``
    is present. ``default`` is returned untouched on the absent path so
    callers can use non-bool sentinels (e.g. ``object()``, ``None``) without
    the helper rejecting them.

    Args:
        args: The (already-normalised) tool arguments dict.
        key: The optional argument name.
        default: Value to return when ``key`` is missing or its value is None.
            Defaults to ``None``. Returned untouched — the helper does NOT
            type-check the default; an unusual default is an author-side
            choice, not an agent-side bug.
        tool_name: Short identifier prefixed onto error messages.

    Raises:
        ValueError: If ``key`` is present with a non-bool value.
    """
    if key not in args:
        return default
    val = args[key]
    if val is None:
        return default
    if not isinstance(val, bool):
        prefix = f'{tool_name}: ' if tool_name else ''
        raise ValueError(f'{prefix}"{key}" must be a boolean')
    return val


def optional_int(
    args: Dict[str, Any],
    key: str,
    *,
    default: Any = None,
    lo: Optional[int] = None,
    hi: Optional[int] = None,
    tool_name: str = '',
) -> Any:
    """Return ``args[key]`` coerced to ``int``, or ``default`` if absent/None.

    Type and bounds rules mirror :func:`require_int` exactly when the key is
    present (bool / float / unsupported types rejected; optional ``lo`` / ``hi``
    inclusive bounds checked). The only difference is the absent-key path:
    instead of raising "is required", ``default`` is returned.

    Following :func:`optional_str`: type and bounds validation only fires
    when ``key`` is present. ``default`` is returned untouched on the absent
    path so callers can use non-int sentinels (e.g. ``object()``) without
    the helper rejecting them.

    Args:
        args: The (already-normalised) tool arguments dict.
        key: The optional argument name.
        default: Value to return when ``key`` is missing or its value is None.
            Defaults to ``None``. Returned untouched — the helper does NOT
            range-check the default; an out-of-range default is an
            author-side bug, not an agent-side bug.
        lo: If set, the value (when present) must be ``>= lo``.
        hi: If set, the value (when present) must be ``<= hi``.
        tool_name: Short identifier prefixed onto error messages so a
            multi-tool dispatcher can attribute each error to a tool.

    Raises:
        ValueError: If ``key`` is present with a non-int value, or with an
            int outside the configured ``[lo, hi]`` bounds.
    """
    if key not in args:
        return default
    val = args[key]
    if val is None:
        return default
    # Reuse require_int's type + range machinery so the validation rules
    # stay in sync between required and optional variants.
    return require_int({key: val}, key, lo=lo, hi=hi, tool_name=tool_name)


def optional_str(
    args: Dict[str, Any],
    key: str,
    *,
    default: Any = None,
    tool_name: str = '',
) -> Any:
    """Return ``args[key]`` as a string, or ``default`` if absent/None.

    Raises ValueError if ``key`` is present but the value is not a string.
    Unlike :func:`require_str`, the returned value is **not** stripped — an
    explicitly-supplied "" stays "".

    Type validation only fires when ``key`` is present with a non-string
    value. A non-string ``default`` is returned untouched on the absent
    path — validating ``default`` would mean the helper rejects perfectly
    legitimate ``optional_str(args, 'n', default=0)`` calls.
    """
    if key not in args:
        return default
    val = args[key]
    if val is None:
        return default
    if not isinstance(val, str):
        prefix = f'{tool_name}: ' if tool_name else ''
        raise ValueError(f'{prefix}"{key}" must be a string')
    return val


class IKeyValueStore:
    pass


class IServiceEndpoint(Protocol):
    """
    Define the engine side of the endpoint.

    This is the interface that the engine uses to communicate with
    the endpoint. The python implementation of the endpoint will
    contain the instance of this class in IEndpoint.endpoint.
    """

    class IServiceEndpoint_JobConfig(TypedDict):
        """
        Define the shape of IEndpoint.jobConfig.
        """

        config: str
        nodeId: str
        paths: Dict
        taskId: str
        type: str

    class IServiceEndpoint_ServiceConfig(TypedDict):
        """
        Define the shape of IEndpoint.serviceConfig.
        """

        key: str
        mode: str
        name: str
        parameters: Dict
        type: str

    openMode: OPEN_MODE
    endpointMode: ENDPOINT_MODE
    level: int
    name: str
    key: str
    logicalType: str
    physicalType: str
    protocol: str
    serviceMode: SERVICE_MODE
    segmentSize: int
    storePath: str
    commonTargetPath: str
    exportUpdateBehavior: int
    exportUpdateBehaviorName: str
    jobConfig: IServiceEndpoint_JobConfig
    taskConfig: Dict[str, Any]
    serviceConfig: IServiceEndpoint_ServiceConfig
    parameters: Dict[str, Any]
    bag: Dict[str, Any]

    def insertFilter(self, filterName: str, filterConfig: Dict) -> None:  #
        ...

    def getToken(self, serviceConfig: IServiceEndpoint_ServiceConfig, key: str) -> str:  #
        ...

    def setToken(self, serviceConfig: IServiceEndpoint_ServiceConfig, key: str, value: str) -> None:  #
        ...

    def getPipe(self) -> 'IServiceFilterInstance':  #
        ...

    def putPipe(self, pipe: 'IServiceFilterInstance'):  #
        ...


class IFilterEndpoint(IServiceEndpoint, Protocol):
    pass


class IEndpointBase:
    """
    Base class for all IEndpoints.

    These calls may all be overridden in derived
    classes. The engine will call these functions.
    """

    # The python IEndpoint points to the engine endpoint here
    endpoint: IFilterEndpoint = None

    def preventDefault(self) -> None:
        """
        Prevent default action.

        Raises an exception to prevent the engine from do it's
        default, which is usually to call the next filter.

        It sends the no default message in case there is no
        default to prevent.
        """
        raise APERR(Ec.PreventDefault, 'No default to prevent')

    def beginEndpoint(self) -> None:
        """
        Begin the endpoint.

        This is called when the engine is starting the endpoint.
        """
        pass

    def getConfigSubKey(self) -> str:
        """
        Get the unique configuration key.

        The configuration subkey is a unique value, based on the
        configuration parameters of the endpoint.
        """
        pass

    def validateConfig(self, syntaxOnly: bool) -> None:
        """
        Validate the configuration.

        Validates the configuration of the endpoint contained
        in self.endpoint.serviceConfig.
        """
        pass

    def getPipeFilters(self) -> List[str | Dict]:
        """
        Get any additional pipe filters.

        Returns a list of containing either a string or dict object
        containing the confugration of any additional filters. Other
        filters may be needed based on the configuration of the endpoint.
        This is called after the endpoint is created, but before any
        global drivers are created. They are placed at the end of
        the driver stack, but before the actual endpoint definition.
        The preferred method now is to use the insertFilter method
        as each global driver is initialized.
        """
        pass

    def scanObjects(self, path: str, callback: Callable[[dict], int]) -> None:
        """
        Scan the objects.

        Scan objects on the endpoint and call the callback for each
        object found. The object is passed to the callback as a dict
        which contain pretty much the same keys as Entry. However,
        one key, isContainer, which is not in the Entry, must be
        set to True of False.
        """
        pass

    def endEndpoint(self) -> None:
        """
        End the endpoint.

        Notification that the engine is done with the endpoint. Cleanup
        any resources that were allocated.
        """
        pass


class IServiceGlobal(Protocol):
    """
    Define the basic C++ IServiceGlobal interface.
    """

    pass


class IFilterGlobal(IServiceGlobal, Protocol):
    """
    Define the engine side of the python global data.
    """

    """
    Connection configuration.

    This is a standard format as follows:
        {
            "profile": "profileName",
            "profileName": {
                "key": "value"
            }
        }
    """
    connConfig: Dict

    """
    Logical type of the driver as defined by your services.json.
    """
    logicalType: str

    """
    Physical type of the driver as defined by your services.json.
    For python based drivers, this will be "python".
    """
    physicalType: str


class IGlobalBase:
    """
    Base class for all IGlobals.

    These calls may all be overridden in derived
    classes. The engine will call these functions.
    """

    IEndpoint: IEndpointBase = None
    glb: IFilterGlobal = None

    def preventDefault(self) -> None:
        """
        Raise an exception indicating that there is no default behavior to prevent.
        """
        raise APERR(Ec.PreventDefault, 'No default to prevent')

    # -------------------
    # These the following are all overridable by
    # the python implementation driver
    # -------------------
    def beginGlobal(self) -> None:
        """
        Initialize global resources at the beginning of execution.
        """
        pass

    def endGlobal(self) -> None:
        """
        Clean up global resources at the end of execution.
        """
        pass


class IServiceFilterInstance(Protocol):
    """
    Define the engine side of the instance data.
    """

    class IServiceFilterInstance_PipeType(TypedDict):
        """
        Define the shape of pipeType.
        """

        id: str
        logicalType: str
        physicalType: str
        capabilities: int
        connConfig: Dict[str, Any]

    currentObject: Entry
    pipeType: IServiceFilterInstance_PipeType
    pipeId: int
    next: 'IServiceFilterInstance | None'

    """
    send* functions are used to send data when you are the
    source endpoint.

    write* functions are used to send data to the next filter
    driver in line.
    """

    """
    SOURCE MODE ENDPOINTS
    """

    def sendOpen(self, obj: Entry) -> None:
        """Send an open event for the given object."""
        pass

    def sendTagMetadata(self, metadata: Dict[str, Any]) -> None:
        """Send metadata associated with a tag."""
        pass

    def sendTagBeginObject(self) -> None:
        """Send a signal to begin processing an object."""
        pass

    def sendTagBeginStream(self) -> None:
        """Send a signal to begin a data stream."""
        pass

    def sendTagData(self, data: Any) -> None:
        """Send a chunk of tagged data."""
        pass

    def sendTagEndObject(self) -> None:
        """Send a signal to end processing an object."""
        pass

    def sendTagEndStream(self) -> None:
        """Send a signal to end a data stream."""
        pass

    def sendText(self, text: str) -> None:
        """Send a text string."""
        pass

    def sendTable(self, table: str) -> None:
        """Send a table structure."""
        pass

    def sendAudio(self, action: int, mimeType: str, buffer: bytes) -> None:
        """Send an audio buffer with the given action and MIME type."""
        pass

    def sendVideo(self, action: int, mimeType: str, buffer: bytes) -> None:
        """Send a video buffer with the given action and MIME type."""
        pass

    def sendImage(self, action: int, mimeType: str, buffer: bytes) -> None:
        """Send an image buffer with the given action and MIME type."""
        pass

    def sendQuestions(self, question: 'Question') -> None:
        """Send a question to the engine."""
        pass

    def sendAnswers(self, answer: List['Answer']) -> None:
        """Send a list of answers to the engine."""
        pass

    def sendDocuments(self, documents: List['Doc']) -> None:
        """Send a list of documents."""
        pass

    def sendClassifications(
        self,
        classifications: Dict[str, Any],
        classificationsPolicies: Dict[str, Any],
        classificationsRules: Dict[str, Any],
    ) -> None:
        """Send classification data."""
        pass

    def sendClassificationContext(self, classifications: Dict[str, Any]) -> None:
        """Send classification context data."""
        pass

    def sendClose(self) -> None:
        """Send a close event."""
        pass

    def addPermissions(self, perm: Dict[str, Any], throwOnError: bool) -> None:
        """Add permissions with error handling based on the throwOnError flag."""
        pass

    def addUserGroupInfo(self, isUser: bool, id: str, authority: str, name: str, local: bool) -> bool:
        """Add user or group information to the system."""
        pass

    def addUserInfo(self, id: str, authority: str, name: str, local: bool) -> bool:
        """Add user information."""
        pass

    def addGroupInfo(self, id: str, authority: str, name: str, local: bool) -> bool:
        """Add group information."""
        pass

    """
    TARGET MODE ENDPOINTS
    """

    def hasListener(self, lane: str) -> bool:
        """
        Return T/F if there are any listeners on the given lane.
        """
        pass

    def getListeners(self) -> List[str]:
        """
        Get the lanes that are being listened to.
        """
        pass

    def getControllerNodeIds(self, classType: str) -> List[str]:
        """
        Get the pipeline node IDs of all nodes connected for a given
        control class type (e.g. ``"tool"``, ``"llm"``).
        """
        pass

    def control(self, filter: str, control: IControl, nodeId: str = '') -> None:
        """Control the instance using the parameters in control.

        When *nodeId* is provided, the control is dispatched directly to that
        specific node instead of walking the full chain.
        """
        pass

    def open(self, obj: Entry) -> None:
        """Open an object."""
        pass

    def writeTag(self, tag: Any) -> None:
        """
        Write the object to the TARGET service.
        """
        pass

    def writeTagBeginObject(self) -> None:
        """
        Send a signal to begin processing an object.
        """
        pass

    def writeTagBeginStream(self) -> None:
        """
        Send a signal to begin a data stream.
        """
        pass

    def writeTagData(self, data: Any) -> None:
        """
        Send a chunk of tagged data.
        """
        pass

    def writeText(self, text: str) -> None:
        """Send a text string."""
        pass

    def writeTable(self, table: str) -> None:
        """Send a table structure."""
        pass

    def writeAudio(self, action: int, mimeType: str, buffer: bytes) -> None:
        """Send an audio buffer with the given action and MIME type."""
        pass

    def writeVideo(self, action: int, mimeType: str, buffer: bytes) -> None:
        """Send a video buffer with the given action and MIME type."""
        pass

    def writeImage(self, action: int, mimeType: str, buffer: bytes) -> None:
        """Send an image buffer with the given action and MIME type."""
        pass

    def writeQuestions(self, question: Question) -> None:
        """Send a question to the engine."""
        pass

    def writeAnswers(self, answer: List[Answer]) -> None:
        """Send a list of answers to the engine."""
        pass

    def writeDocuments(self, documents: List[Doc]) -> None:
        """Send a list of documents."""
        pass

    def writeClassifications(
        self, classifications: Dict[str, Any], classificationPolicy: Dict[str, Any], classificationRules: Dict[str, Any]
    ) -> None:
        """Send classification data."""
        pass

    def writeClassificationContext(self, classifications: Dict[str, Any]) -> None:
        """Send classification context data."""
        pass

    def writeTagEndStream(self) -> None:
        """
        Send a signal to end a data stream.
        """
        pass

    def writeTagEndObject(self) -> None:
        """
        Send a signal to end processing an object.
        """
        pass

    def closing(self) -> None:
        """Perform any actions required before closing."""
        pass

    def close(self) -> None:
        """Close the instance."""
        pass


class IServiceFilterPipe(IServiceFilterInstance, Protocol):
    pass


class IFilterInstance(IServiceFilterInstance, Protocol):
    targetObjectPath: str  #: The target object path as a string.
    targetObjectUrl: str  #: The target object URL as a string.

    def invoke(self, classType: str, *args, **kwargs) -> Any:
        """Send a control to invoke a process on another filter.

        This is a convenience wrapper around self.control
        """
        ...

    def sendSSE(self, type: str, **data) -> None:
        """Send a real-time SSE event to the UI for this pipe."""
        ...


class IInstanceBase:
    """
    Base class for all IInstances.

    These calls may all be overridden in derived
    classes. The engine will call these functions.
    """

    IEndpoint: IEndpointBase = None  #: Endpoint instance for communication.
    IGlobal: IGlobalBase = None  #: Global instance for shared data.
    instance: IFilterInstance = None  #: Instance data reference.

    """
    These are all the overrides to provide
    the driver funtionality.
    """

    def preventDefault(self) -> None:
        """Prevent the default action from occurring."""
        raise APERR(Ec.PreventDefault, 'No default to prevent')

    def invoke(self, *args, **kwargs) -> Any:
        """Handle an incoming invoke call from the engine control-plane.

        The engine calls control() -> invoke() on each driver in the chain
        until one handles the request (returns without raising) or all raise
        PreventDefault.

        This base implementation auto-dispatches using decorator metadata:

        1. ``tool.*`` ops — routed to ``@tool_function`` decorated methods.
           These are the tool entry points that agents discover and call.
           tool.query returns descriptors; tool.invoke calls the method.

        2. Any other op — routed to ``@invoke_function`` decorated methods.
           The method name IS the op name (e.g. ``def ask(self, param)``
           handles ``op='ask'``).

        3. No match — raises PreventDefault so the engine tries the next
           driver in the chain.

        Subclasses can still override invoke() directly for custom routing.
        If no decorators are present, the behaviour is identical to the
        original: raise InvalidParam.
        """
        param = args[0] if args else None
        op = self._get_op(param)

        if isinstance(op, str):
            # Tool ops get special handling: tool.query aggregates
            # descriptors across nodes; tool.invoke dispatches by
            # tool_name.  See _dispatch_tool() for the full protocol.
            if op.startswith('tool.'):
                return self._dispatch_tool(param, op)

            # Simple invoke dispatch: op name maps directly to method
            # name.  e.g. op='ask' dispatches to @invoke_function 'ask'.
            invoke_methods = self._collect_invoke_methods()
            if op in invoke_methods:
                return invoke_methods[op](param)

        # Nothing matched — tell the engine to try the next driver.
        driver_name = getattr(getattr(self.IGlobal, 'glb', None), 'logicalType', type(self).__name__)
        raise APERR(Ec.InvalidParam, f'Driver {driver_name} does not accept invoke calls')

    # ------------------------------------------------------------------
    # Decorator introspection
    #
    # These walk the class MRO looking for methods stamped by
    # @invoke_function or @tool_function and return them as dicts
    # keyed by their dispatch name (op name or tool name).
    # ------------------------------------------------------------------

    def _collect_invoke_methods(self) -> Dict[str, Callable]:
        """Find all @invoke_function methods on this instance.

        Returns: { op_name: bound_method }
        e.g. { 'ask': <bound method ask>, 'getContextLength': <bound method ...> }
        """
        methods: Dict[str, Callable] = {}
        for name in dir(type(self)):
            attr = getattr(type(self), name, None)
            if attr is not None and hasattr(attr, '__invoke_op__'):
                methods[attr.__invoke_op__] = getattr(self, name)
        return methods

    def _collect_tool_methods(self) -> Dict[str, Callable]:
        """Find all @tool_function methods on this instance.

        Returns: { tool_name: bound_method }
        e.g. { 'get_data': <bound method get_data>, 'get_schema': <bound method ...> }
        """
        methods: Dict[str, Callable] = {}
        for name in dir(type(self)):
            attr = getattr(type(self), name, None)
            if attr is not None and hasattr(attr, '__tool_meta__'):
                methods[name] = getattr(self, name)
        return methods

    # ------------------------------------------------------------------
    # Tool descriptor building
    #
    # Reads the __tool_meta__ stamped by @tool_function on each method
    # and assembles ToolDescriptor dicts for tool.query responses.
    #
    # Each @tool_function parameter (input_schema, description, etc.)
    # can be either a static value or a callable(self) that is resolved
    # here at query time — this lets descriptors reference runtime config
    # like self.IGlobal.db_description or self._db_display_name().
    # ------------------------------------------------------------------

    def _build_tool_descriptors(self, methods: Dict[str, Callable]) -> List[ToolDescriptor]:
        """Build ToolDescriptor dicts from @tool_function metadata.

        The user-entered tool description (from the node's "tool" config
        field) is auto-prepended to every tool's description so the LLM
        sees context like "Database of world cities" before the fixed
        tool description.
        """
        # The user-entered description from the node config panel.
        # e.g. "This is a database of world cities and populations"
        user_desc = self._tool_config_description()
        descriptors: List[ToolDescriptor] = []

        for tool_name, method in methods.items():
            meta = method.__tool_meta__

            # --- Description ---
            # Resolve: static string, callable(self), or fall back to docstring.
            raw_desc = meta['description']
            raw_desc = raw_desc(self) if callable(raw_desc) else raw_desc
            if raw_desc is None:
                raw_desc = (method.__doc__ or '').strip()

            # Prepend the user's config description if present.
            # Result: "Database of world cities Accepts natural language..."
            if user_desc:
                full_desc = f'{user_desc} {raw_desc}'
            else:
                full_desc = raw_desc

            # --- Input schema ---
            # Resolve: static dict or callable(self) for dynamic schemas.
            input_schema = meta['input_schema']
            input_schema = input_schema(self) if callable(input_schema) else input_schema

            descriptor: ToolDescriptor = {
                'name': tool_name,
                'description': full_desc,
                'inputSchema': input_schema,
            }

            # --- Output schema (optional) ---
            output_schema = meta['output_schema']
            output_schema = output_schema(self) if callable(output_schema) else output_schema
            if output_schema:
                descriptor['outputSchema'] = output_schema

            descriptors.append(descriptor)
        return descriptors

    # ------------------------------------------------------------------
    # Tool dispatch
    #
    # Handles the tool.* control-plane protocol:
    #
    # - tool.query: Every tool node in the chain appends its descriptors
    #   to param.tools, then raises PreventDefault so the engine continues
    #   to the next node. The caller collects the full catalog.
    #
    # - tool.invoke: Finds the @tool_function method matching tool_name
    #   and calls it with the input payload. If this node doesn't own the
    #   tool, raises PreventDefault so the next node can try.
    # ------------------------------------------------------------------

    def _dispatch_tool(self, param: Any, op: str) -> Any:
        """Route tool.query and tool.invoke to the appropriate handler."""
        methods = self._collect_tool_methods()
        has_dynamic = type(self)._tool_query_dynamic is not IInstanceBase._tool_query_dynamic

        # Nothing to dispatch — let the next node in the chain try.
        if not methods and not has_dynamic:
            raise APERR(Ec.PreventDefault, 'no tool methods')

        if op == 'tool.query':
            # Build descriptors from all @tool_function methods on this node,
            # plus any dynamically discovered tools (e.g. MCP).
            descriptors = self._build_tool_descriptors(methods)
            descriptors.extend(self._tool_query_dynamic())

            # Cache by name for invoke-time schema walks.
            # We need the per-tool inputSchema at tool.invoke time to know
            # which top-level properties are declared as
            # ``format: 'rocketride-attachment'`` and therefore need their
            # string path swapped for a ``{path, mime, bytes}`` dict.
            self._rr_tool_descriptors = {d['name']: d for d in descriptors if 'name' in d}

            # Add our descriptors to the shared param.tools list.
            # The engine walks every tool node in the chain — each one
            # appends here, building the full catalog.
            existing = self._get_param_field(param, 'tools')
            if isinstance(existing, list):
                existing.extend(descriptors)
                self._set_param_field(param, 'tools', existing)

            # PreventDefault tells the engine to continue to the next
            # tool node in the chain (every node contributes).
            raise APERR(Ec.PreventDefault, 'tool.query: continue chain')

        elif op == 'tool.invoke':
            tool_name = self._get_param_field(param, 'tool_name')
            input_obj = self._get_param_field(param, 'input')

            if not isinstance(tool_name, str) or not tool_name.strip():
                raise ValueError('tool_name must be a non-empty string')
            tool_name = tool_name.strip()

            # Pre-resolve any format: 'rocketride-attachment' string paths
            # to {path, mime, bytes} dicts before the tool method sees them
            # (top-level properties only).
            self._resolve_attachment_inputs(tool_name, input_obj)

            # Try static @tool_function methods first
            if tool_name in methods:
                output = methods[tool_name](input_obj)

            # Then try dynamic tools (MCP etc.)
            elif has_dynamic:
                output = self._tool_invoke_dynamic(tool_name=tool_name, input_obj=input_obj)

            # This node doesn't own this tool — let the next node try.
            else:
                raise APERR(Ec.PreventDefault, f'tool.invoke: {tool_name} not owned')

            # Write the output back into the param object so the caller
            # can read it from param.output after the invoke returns.
            self._set_param_field(param, 'output', output)
            return param

        raise ValueError(f'tools: invoke operation {op} is not defined')

    # ------------------------------------------------------------------
    # Attachment input resolution
    #
    # Tools whose @tool_function input_schema declares a top-level
    # property as ``{type: 'string', format: 'rocketride-attachment'}``
    # accept a FileStore path string from the agent. The dispatcher
    # transparently reads the bytes and rewrites that property to
    # ``{path, mime, bytes}`` before the tool method runs, so tool
    # authors never write FileStore boilerplate.
    #
    # Only top-level properties are walked. Nested objects,
    # arrays of attachments, oneOf/anyOf/$ref are silently NOT
    # resolved — keep the surface narrow until we have real demand.
    # ------------------------------------------------------------------

    def _resolve_attachment_inputs(self, tool_name: str, input_obj: Any) -> None:
        """In-place: swap top-level attachment paths for {path, mime, bytes}.

        Looks up the cached descriptor for ``tool_name`` (populated at
        ``tool.query``), walks ``inputSchema.properties`` at depth 1, and
        for every string property declared ``format: 'rocketride-attachment'``
        replaces the path string in ``input_obj`` with the resolved dict.

        No-ops if the descriptor cache is missing (tool.invoke arrived
        without a preceding tool.query — legal for some control flows),
        if the schema isn't a top-level object schema, or if the value
        in ``input_obj`` isn't a string (already resolved / null / wrong
        shape — let the tool method validate).
        """
        descriptors = getattr(self, '_rr_tool_descriptors', None) or {}
        descriptor = descriptors.get(tool_name)
        if not descriptor or not isinstance(input_obj, dict):
            return

        input_schema = descriptor.get('inputSchema') or {}
        props = input_schema.get('properties') or {}
        if not isinstance(props, dict):
            return

        file_store = None
        for prop_name, prop_schema in props.items():
            if not isinstance(prop_schema, dict):
                continue
            if prop_schema.get('type') != 'string':
                continue
            if prop_schema.get('format') != 'rocketride-attachment':
                continue
            path = input_obj.get(prop_name)
            if not isinstance(path, str):
                continue

            # Lazy-resolve the FileStore on first matching property.
            if file_store is None:
                file_store = self._get_attachment_file_store()
                if file_store is None:
                    # No file store available — leave the raw path in
                    # place so the tool method can surface a clear error
                    # (rather than us masking it as a missing-key).
                    return

            data = file_store.read_bytes(path)
            # Derive the concrete MIME from the path, NOT from the schema's
            # ``x-rocketride-mimes`` accept-list (which may be a wildcard
            # like ``image/*`` or list several patterns).
            mime, _ = mimetypes.guess_type(path)
            input_obj[prop_name] = {'path': path, 'mime': mime, 'bytes': data}
            # METRIC tool.attachment_resolved — one line per resolved
            # attachment-typed slot, for log-based observability.
            # Privacy: tool + property name only, never the path itself.
            from .engine import debug

            debug(f'METRIC tool.attachment_resolved tool_name={tool_name} prop={prop_name}')

    def _get_attachment_file_store(self) -> Any:
        """Return a sync FileStore-like object exposing ``read_bytes(path)``.

        Resolution order:

        1. ``self._file_store`` — explicitly injected by the wiring layer
           (LLM/agent nodes; the engine instance in production).
        2. ``self.instance.fileStore`` — engine-provided handle, if any.
        3. ``None`` — caller must handle gracefully; see
           ``_resolve_attachment_inputs`` for the contract.

        We deliberately do NOT auto-construct a per-account FileStore here
        (no env-var sniffing), which keeps the rocketlib base dependency-free.
        A tool node that accepts attachments builds its own store in
        ``beginGlobal()`` and exposes it as ``self._file_store`` — see
        ``tool_filesystem`` for the canonical pattern (it imports
        ``ai.account.store`` directly, which node code is free to do).
        """
        injected = getattr(self, '_file_store', None)
        if injected is not None:
            return injected
        instance = getattr(self, 'instance', None)
        if instance is not None:
            fs = getattr(instance, 'fileStore', None) or getattr(instance, '_file_store', None)
            if fs is not None:
                return fs
        return None

    # ------------------------------------------------------------------
    # Dynamic tool overrides
    #
    # Most tool nodes define tools statically with @tool_function.
    # MCP is the exception — it discovers tools at runtime from an
    # external server. These two methods provide the escape hatch:
    # override them in a subclass to provide dynamic tool discovery
    # and invocation.
    # ------------------------------------------------------------------

    def _tool_query_dynamic(self) -> list:
        """Override to return dynamically discovered tool descriptors.

        Called during tool.query after static @tool_function descriptors
        are collected. Return a list of ToolDescriptor dicts.
        """
        return []

    def _tool_invoke_dynamic(self, *, tool_name: str, input_obj: Any) -> Any:  # noqa: ARG002
        """Override to dispatch dynamically discovered tools.

        Called during tool.invoke when tool_name doesn't match any
        @tool_function method. Raise ValueError if not recognized.
        """
        raise ValueError(f'Unknown dynamic tool: {tool_name}')

    def _tool_config_description(self) -> str:
        """Return the user-entered tool description from the node config.

        This is the "tool" field from the node definition, written by the
        user in the UI (e.g. "This is a database of world cities").
        It is auto-prepended to every @tool_function's description during
        tool.query so the LLM sees the user context first.

        Override in a subclass or set self.IGlobal.tool_description.
        """
        return (getattr(self.IGlobal, 'tool_description', None) or '').strip()

    # ------------------------------------------------------------------
    # Param field helpers
    #
    # Invoke params can be either plain dicts or pydantic BaseModel
    # objects (e.g. IInvokeTool, IInvokeLLM). These helpers abstract
    # the access pattern so dispatch code doesn't care which it gets.
    # ------------------------------------------------------------------

    @staticmethod
    def _get_op(param: Any) -> Any:
        """Extract the op field from a param (dict or object)."""
        if param is None:
            return None
        if isinstance(param, dict):
            return param.get('op')
        return getattr(param, 'op', None)

    @staticmethod
    def _get_param_field(param: Any, name: str) -> Any:
        """Read a named field from a param (dict or object)."""
        if param is None:
            return None
        if isinstance(param, dict):
            return param.get(name)
        return getattr(param, name, None)

    @staticmethod
    def _set_param_field(param: Any, name: str, value: Any) -> None:
        """Write a named field to a param (dict or object)."""
        if param is None:
            return
        if isinstance(param, dict):
            param[name] = value
            return
        try:
            setattr(param, name, value)
        except Exception:
            pass

    def control(self, control: IControl) -> None:
        """
        Process called by someone in our pipeline.

        Normally, you do not need to override this. It is the dispatcher, which
        usually calls invoke. If you do override, make sure you call super.control
        if it is an invoke call.
        """
        if control.control == 'invoke':
            control.result = self.invoke(control.param)
        else:
            raise APERR(
                Ec.InvalidParam, f'Unrecognized control {control.control} sent to {self.IGlobal.glb.logicalType}'
            )

    def beginInstance(self) -> None:
        """Begin the instance lifecycle."""
        pass

    def endInstance(self) -> None:
        """End the instance lifecycle."""
        pass

    def checkChanged(self, obj: Entry) -> None:
        """Check if the given object has changed."""
        pass

    def removeObject(self, obj: Entry) -> None:
        """Remove an object."""
        pass

    def renderObject(self, obj: Entry) -> None:
        """Render an object."""
        pass

    def getPermissions(self, obj: Entry) -> None:
        """Retrieve permissions for an object."""
        pass

    def stat(self, obj: Entry) -> None:
        """Retrieve status information for an object."""
        pass

    def open(self, obj: Entry) -> None:
        """Open an object."""
        pass

    def writeText(self, text: str) -> None:
        """Send a text string."""
        pass

    def writeTable(self, table: str) -> None:
        """Send a table structure."""
        pass

    def writeAudio(self, action: int, mimeType: str, buffer: bytes) -> None:
        """Send an audio buffer with the given action and MIME type."""
        pass

    def writeVideo(self, action: int, mimeType: str, buffer: bytes) -> None:
        """Send a video buffer with the given action and MIME type."""
        pass

    def writeImage(self, action: int, mimeType: str, buffer: bytes) -> None:
        """Send an image buffer with the given action and MIME type."""
        pass

    def writeQuestions(self, question: Question) -> None:
        """Send a question to the engine."""
        pass

    def writeAnswers(self, answer: List[Answer]) -> None:
        """Send a list of answers to the engine."""
        pass

    def writeDocuments(self, documents: List[Doc]) -> None:
        """Send a list of documents."""
        pass

    def writeClassifications(
        self, classifications: Dict[str, Any], classificationPolicy: Dict[str, Any], classificationRules: Dict[str, Any]
    ) -> None:
        """Send classification data."""
        pass

    def writeClassificationContext(self, classifications: Dict[str, Any]) -> None:
        """Send classification context data."""
        pass

    def closing(self) -> None:
        """Perform any actions required before closing."""
        pass

    def close(self) -> None:
        """Close the instance."""
        pass


class ILoader(Protocol):
    """
    Creates a new loader task.

    The loader class is used to create/destroy pipes.
    """

    target: IEndpointBase  #: The target endpoint.

    def beginLoad(self, pipeConfig: Dict) -> None:
        """
        Begin the loading operation by creating an endpoint.
        """
        pass

    def endLoad(self) -> None:
        """
        Begins the loading operation by destroying the endpoint.
        """
        pass


"""
Monkey patch the C++ methods as needed
"""


def _patch_classes():
    """Add Python methods to C++ classes.

    These are monkey patched on to the C++ so we can maintain our
    pattern of calling into the engine's self.instance.*.
    """

    def invoke(self, param, component_id: str = '') -> Any:
        control = IInvoke(param=param, result=None)
        self.control(param.lane, control, nodeId=component_id)
        return control.result

    def sendSSE(self, type: str, **data) -> None:
        from .engine import monitorSSE

        monitorSSE(self.pipeId, type, data or None)

    # Add to the actual C++ class
    from engLib import IFilterInstance as Impl_IFilterInstance

    Impl_IFilterInstance.invoke = invoke
    Impl_IFilterInstance.sendSSE = sendSSE


# Apply patches
_patch_classes()
