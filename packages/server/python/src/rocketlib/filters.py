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
import functools
import json
from typing import TYPE_CHECKING, Dict, Any, List, Optional, TypedDict, Callable, Protocol
from .types import AVI_ACTION, OPEN_MODE, ENDPOINT_MODE, SERVICE_MODE, Entry, IControl, IInvoke, IJson
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

    def sendJson(self, data: IJson) -> None:
        """Send a JSON object."""
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

    def sendAnswers(self, answer: 'Answer') -> None:
        """Send a single answer to the engine."""
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

    def writeJson(self, data: IJson) -> None:
        """Send a JSON object."""
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

    def writeAnswers(self, answer: Answer) -> None:
        """Send a single answer to the engine."""
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


# =========================================================================
# Media lane normalization
#
# A media lane delivers BEGIN / WRITE... / END, and the call carries no stream
# identifier — only the lane and the MIME type. A consumer therefore keeps one
# slot of state per lane, and reads a fresh BEGIN as proof the previous stream
# ended. When a single object emits several streams on one lane, that next
# BEGIN can arrive while the previous stream's END is still outstanding even
# though every byte has already been delivered, and the consumer throws away a
# complete stream.
#
# The wrapper below closes that for every node at once. It counts the bytes a
# stream receives, compares them against the size the stream's own BEGIN
# declared, and calls the node's own END handler for a stream that got
# everything it promised — before letting the next BEGIN through. Consumers see
# whole streams and need no bookkeeping of their own.
# =========================================================================

#: Doc.type values marking a media BEGIN payload as a stream descriptor. Mirrors
#: ai.common.avi.descriptor.STREAM_TYPES and testdata/contracts/descriptor_keys.json;
#: kept as a literal because rocketlib must not import ai at runtime.
_AVI_STREAM_TYPES = ('VideoStream', 'AudioStream', 'ImageStream')

#: Media handlers wrapped on every subclass, mapped to the lane they serve.
_AVI_MEDIA_METHODS = {'writeImage': 'image', 'writeAudio': 'audio', 'writeVideo': 'video'}


def _avi_declared_size(payload: Any) -> Optional[int]:
    """
    Read the byte count a media BEGIN payload declares.

    Only the size is wanted, so this deliberately accepts payloads that
    ``ai.common.avi.descriptor.descriptor_from_payload`` rejects: that parser also
    demands ``metadata.objectId``, which the C++ builder emits only when the entry
    carries one. A stream can declare a perfectly usable size without it.

    A ``type`` marker is required, though. With ``ROCKETRIDE_STREAM_DESCRIPTOR=0``
    the engine forwards the producer's own enrichment unwrapped, and that carries a
    ``size`` but never a ``type`` — reading it would make the kill switch quietly
    change behaviour instead of disabling the feature.

    Args:
        payload (Any): The raw BEGIN byte slot.

    Returns:
        Optional[int]: The declared size, or None when the payload is not a stream
        descriptor or declares no usable size.
    """
    if not payload:
        return None
    try:
        data = json.loads(bytes(payload).decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(data, dict) or data.get('type') not in _AVI_STREAM_TYPES:
        return None
    metadata = data.get('metadata')
    if not isinstance(metadata, dict):
        return None
    size = metadata.get('size')
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        return None
    return size


def _avi_object_failed(obj: Any) -> bool:
    """
    Report whether an object is explicitly marked failed.

    Compared with ``is True`` rather than tested for truth on purpose: test harnesses
    build ``currentObject`` from a MagicMock, where every unset attribute is a truthy
    Mock, and a plain truthiness test would read each of them as failed and disable
    the settle everywhere while the tests still passed.

    Args:
        obj (Any): The object to inspect, never None here.

    Returns:
        bool: True only when the flag is genuinely set.
    """
    return getattr(obj, 'objectFailed', False) is True


class _AviLane:
    """One media lane's view of the stream currently travelling over it."""

    __slots__ = ('open', 'mime', 'owner', 'declared', 'written', 'late')

    def __init__(self):
        self.reset()

    def reset(self) -> None:
        """Forget everything about this lane, including any outstanding END debt."""
        self.open = False
        self.mime = ''
        self.owner = None
        self.declared = None
        self.written = 0
        self.late = 0


def _avi_media_wrapper(method: Callable, lane: str) -> Callable:
    """
    Wrap one media handler so the node sees whole streams.

    Args:
        method (Callable): The subclass's own handler.
        lane (str): The lane it serves — 'image', 'audio' or 'video'.

    Returns:
        Callable: The wrapping handler, stamped so it is never wrapped twice.
    """

    @functools.wraps(method)
    def wrapper(self, action, mimeType, buffer=b''):
        # A sub-subclass calling super() reaches a second live wrapper; the inner one
        # delegates so the bytes are counted once.
        if getattr(self, '_avi_reentrant', False):
            return method(self, action, mimeType, buffer)

        self._avi_reentrant = True
        try:
            state = self._avi_lane(lane)

            if action == AVI_ACTION.BEGIN:
                if state.open:
                    self._avi_settle(lane, state, method)
                    # The displaced stream may still send its own END; owe one swallow.
                    state.late += 1
                state.open = True
                state.mime = mimeType
                state.owner = self._avi_owner()
                state.declared = _avi_declared_size(buffer)
                state.written = 0

            elif action == AVI_ACTION.WRITE:
                state.written += len(buffer) if buffer else 0

            elif action == AVI_ACTION.END:
                if state.open:
                    state.open = False
                elif state.late > 0:
                    state.late -= 1
                    return None

            return method(self, action, mimeType, buffer)
        finally:
            self._avi_reentrant = False

    wrapper.__avi_normalized__ = True
    return wrapper


def _avi_open_wrapper(method: Callable) -> Callable:
    """Wrap open() so media state never crosses an object boundary.

    Takes the node's arguments through untouched: nodes spell this parameter several
    ways, and the wrapper has no interest in it.
    """

    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        self._avi_reset_lanes()
        return method(self, *args, **kwargs)

    wrapper.__avi_normalized__ = True
    return wrapper


def _avi_close_wrapper(method: Callable) -> Callable:
    """Wrap close() so a stream the producer never ended is still settled."""

    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        self._avi_settle_lanes()
        return method(self, *args, **kwargs)

    wrapper.__avi_normalized__ = True
    return wrapper


class IInstanceBase:
    """
    Base class for all IInstances.

    These calls may all be overridden in derived
    classes. The engine will call these functions.

    Media lanes are normalized for every subclass (see the block above). A handler
    for ``writeImage``/``writeAudio``/``writeVideo`` receives, per stream, exactly
    one BEGIN, zero or more WRITEs, and at most one END. That END is either the
    producer's own, forwarded exactly as it arrives, or one this base supplies in its
    place — when the next stream begins on the lane, or as the object closes.

    The base supplies one only for a stream that received every byte its BEGIN
    declared, so the guarantee is this and no more: a stream displaced by the next
    BEGIN, or still open when the object closes, is either ended or reported — never
    dropped in silence. One case is deliberately left out of that: a stream that
    neither promised bytes nor delivered any goes without an END and without a word,
    having lost nothing. A producer's own END is never checked against the declared
    size, so a handler that must know its bytes are whole still checks them itself.

    A displaced stream that carried no bytes, fell short of what it declared, or
    declared nothing at all gets no END; the handler learns of it from the next BEGIN
    on that lane, or from ``open()``, and must release whatever it holds there. A
    handler owning an external resource (a write handle, a decoder) should also sweep
    in its own ``closing()``.
    """

    IEndpoint: IEndpointBase = None  #: Endpoint instance for communication.
    IGlobal: IGlobalBase = None  #: Global instance for shared data.
    instance: IFilterInstance = None  #: Instance data reference.

    """
    These are all the overrides to provide
    the driver funtionality.
    """

    # ------------------------------------------------------------------
    # Media lane normalization
    #
    # Wrapping every subclass, rather than offering a mixin or a hook to
    # inherit from, is the point: a node that merely defines writeImage()
    # would silently miss any scheme it had to remember to join, and that
    # silence is the failure this exists to remove.
    # ------------------------------------------------------------------

    def __init_subclass__(cls, **kwargs):
        """Wrap the subclass's media and per-object handlers with the AVI normalization."""
        super().__init_subclass__(**kwargs)

        for name, lane in _AVI_MEDIA_METHODS.items():
            fn = cls.__dict__.get(name)
            if callable(fn) and not getattr(fn, '__avi_normalized__', False):
                setattr(cls, name, _avi_media_wrapper(fn, lane))

        for name, wrap in (('open', _avi_open_wrapper), ('close', _avi_close_wrapper)):
            fn = cls.__dict__.get(name)
            if callable(fn) and not getattr(fn, '__avi_normalized__', False):
                setattr(cls, name, wrap(fn))

    def _avi_lane(self, lane: str) -> '_AviLane':
        """
        Return this lane's stream state, created on first use.

        Built lazily because not every node calls ``super().__init__()`` — several
        define no ``__init__`` at all — so there is no constructor to rely on.

        Args:
            lane (str): The media lane.

        Returns:
            _AviLane: The lane's state, owned by this instance alone.
        """
        lanes = getattr(self, '_avi_lanes', None)
        if lanes is None:
            lanes = {}
            self._avi_lanes = lanes
        state = lanes.get(lane)
        if state is None:
            state = lanes[lane] = _AviLane()
        return state

    def _avi_current_object(self) -> Any:
        """
        Return the object a stream should be attributed to, or None.

        Both hops are genuinely nullable: ``instance`` defaults to None on this
        class, and the engine clears ``currentEntry`` again when an object fails
        to open.

        Returns:
            Any: The current object, or None when there is not one.
        """
        return getattr(getattr(self, 'instance', None), 'currentObject', None)

    def _avi_owner(self) -> Optional[str]:
        """
        Return a label for the object owning a stream, for the log line.

        Captured at BEGIN and kept on the lane, never read back later: by the time
        ``open()`` reports a lost stream the current object has already advanced to
        the next one, and naming that one would send a reader to the wrong input.

        Returns:
            Optional[str]: The object's name, else its id, else None.
        """
        obj = self._avi_current_object()
        if obj is None:
            return None
        if getattr(obj, 'hasName', False):
            name = getattr(obj, 'name', None)
            if name:
                return str(name)
        objectId = getattr(obj, 'objectId', None)
        return str(objectId) if objectId else None

    def _avi_invoke(self, method: Callable, action: int, mimeType: str, buffer: bytes) -> None:
        """
        Call a media handler for a stream the engine is not waiting on.

        Handlers commonly end in ``preventDefault()``, which raises; nothing is
        waiting on a synthesized call, so that signal is swallowed. Every other
        error propagates exactly as it would from a real END — a decoder reporting
        a failure off its background thread still fails the object.

        Args:
            method (Callable): The subclass's own (unwrapped) handler.
            action (int): The AVI action to deliver.
            mimeType (str): The MIME type of the stream being closed out.
            buffer (bytes): The payload slot, empty for a synthesized END.
        """
        # Held for the whole call: a node subclassing another node reaches the parent's
        # wrapper through super(), and that wrapper must pass straight through rather
        # than run the state machine a second time for an END this code already handled.
        previous = getattr(self, '_avi_reentrant', False)
        self._avi_reentrant = True
        try:
            method(self, action, mimeType, buffer)
        except APERR as e:
            if e.ec != Ec.PreventDefault:
                raise
        finally:
            self._avi_reentrant = previous

    def _avi_warn_lost(self, lane: str, state: '_AviLane', reason: str = 'it could not be settled') -> None:
        """
        Report a pending stream that was dropped.

        Silent for a stream that promised nothing and delivered nothing: that is an
        empty stream rather than a loss, and a line firing on ordinary traffic is
        one nobody reads.

        Args:
            lane (str): The media lane.
            state (_AviLane): The lane's state, still holding the lost stream.
            reason (str): Why the stream went unsettled. Named rather than assumed:
                a complete stream held back because its object failed reads as a
                truncated one otherwise, and sends the reader hunting for a cut-off
                that never happened.
        """
        if not state.written and not state.declared:
            return

        # Imported here: engine.py imports this module, so a module-level import
        # would be circular.
        from .engine import warning

        warning(
            f'media lane {lane}: dropped a stream, {reason} '
            f'(object={state.owner}, mime={state.mime}, '
            f'declared={state.declared}, written={state.written})'
        )

    def _avi_settle(self, lane: str, state: '_AviLane', method: Callable) -> None:
        """
        Close out a pending stream that received every byte it declared.

        Delivers the END the producer never sent, so the commit path the stream
        would have taken anyway is the one that runs. A stream that fell short,
        carried no bytes, or declared no size gets no END and is reported instead:
        the declared size is the only completeness signal available, so nothing is
        committed on a guess.

        Args:
            lane (str): The media lane.
            state (_AviLane): The lane's state.
            method (Callable): The subclass's own (unwrapped) handler.
        """
        if state.declared is not None and state.written == state.declared and state.written > 0:
            self._avi_invoke(method, AVI_ACTION.END, state.mime, b'')
            return
        self._avi_warn_lost(lane, state)

    def _avi_handler(self, lane: str) -> Optional[Callable]:
        """
        Return the subclass's own handler for a lane, unwrapped.

        Args:
            lane (str): The media lane.

        Returns:
            Optional[Callable]: The underlying function, or None when this node does
            not consume the lane.
        """
        for name, served in _AVI_MEDIA_METHODS.items():
            if served != lane:
                continue
            fn = getattr(type(self), name, None)
            return getattr(fn, '__wrapped__', fn)
        return None

    def _avi_settle_lanes(self) -> None:
        """
        Settle whatever is still open as the object closes.

        ``close()`` is the last point at which ``currentObject`` is still the
        stream's own object: ``open()`` has already advanced it and ``closing()``
        runs after it is cleared, so this is the only per-object place a synthesized
        END can be attributed correctly. A failed object settles nothing — it must
        not publish output it would never otherwise have produced — and its pending
        streams are reported with that as the stated reason.

        Every open lane is marked closed here, whichever way it went, so ``open()``
        does not report the same loss a second time.
        """
        lanes = getattr(self, '_avi_lanes', None)
        if not lanes:
            return

        obj = self._avi_current_object()
        reason = None
        if obj is None:
            reason = 'its object is no longer current'
        elif _avi_object_failed(obj):
            reason = 'its object failed'

        for lane, state in lanes.items():
            if not state.open:
                continue
            if reason is not None:
                self._avi_warn_lost(lane, state, reason)
            else:
                method = self._avi_handler(lane)
                if method is not None:
                    self._avi_settle(lane, state, method)
            state.open = False

    def _avi_reset_lanes(self) -> None:
        """
        Report and clear whatever the finished object left pending.

        Runs from ``open()``, which reports but never commits: the current object is
        already the next one by then. The reset matters in its own right — an object
        can end still owing trailing ENDs, and carrying that debt across the boundary
        would swallow the next object's genuine ones.
        """
        for lane, state in (getattr(self, '_avi_lanes', None) or {}).items():
            if state.open:
                self._avi_warn_lost(lane, state)
            state.reset()

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
        """Open an object.

        A subclass defining its own ``open()`` gets the same sweep wrapped around it;
        this body carries it for the nodes that define none.
        """
        self._avi_reset_lanes()

    def writeText(self, text: str) -> None:
        """Send a text string."""
        pass

    def writeTable(self, table: str) -> None:
        """Send a table structure."""
        pass

    def writeJson(self, data: IJson) -> None:
        """Send a JSON object."""
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

    def writeAnswers(self, answer: Answer) -> None:
        """Send a single answer to the engine."""
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
        """Perform any actions required before closing.

        Nothing is settled here: this runs after the final ``close()``, when the
        engine has already cleared the current object, so a stream committed from
        here would have no object to belong to. A node holding an external resource
        still sweeps it here — releasing a handle needs no object.
        """
        pass

    def close(self) -> None:
        """Close the instance.

        A subclass defining its own ``close()`` gets the same settle wrapped around
        it; this body carries it for the nodes that define none.
        """
        self._avi_settle_lanes()


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
