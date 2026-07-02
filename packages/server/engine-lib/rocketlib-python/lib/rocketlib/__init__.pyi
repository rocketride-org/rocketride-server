# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
# rocketlib/__init__.pyi
# Auto-generated type stub — mirrors the public API declared in __init__.py,
# engine.py, error.py, filters.py, types.py, and the C++ engLib bindings.
# =============================================================================

from __future__ import annotations

from enum import Enum
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Protocol, TypedDict, overload

# ---------------------------------------------------------------------------
# Re-exports — everything listed in __all__
# ---------------------------------------------------------------------------

# ---- error.py ----

class Ec:
    """Standard engine error codes (backed by C++ enum)."""

    NoErr: int
    AccessDenied: int
    AlreadyOpened: int
    BatchExceeded: int
    BatchThreshold: int
    BlobImmutable: int
    Bug: int
    Cancelled: int
    Cipher: int
    Classify: int
    ClassifyContent: int
    CoInit: int
    Completed: int
    ElevationRequired: int
    Empty: int
    End: int
    Error: int
    Exception: int
    Excluded: int
    Exists: int
    ExpiredAuthentication: int
    FactoryNotFound: int
    Failed: int
    Fatality: int
    FileChanged: int
    FileNotChanged: int
    Fuse: int
    Icu: int
    InvalidAuthentication: int
    InvalidCipher: int
    InvalidCommand: int
    InvalidDocument: int
    InvalidFormat: int
    InvalidJson: int
    InvalidKeyToken: int
    InvalidName: int
    InvalidParam: int
    InvalidRpc: int
    InvalidSchema: int
    InvalidSelection: int
    InvalidState: int
    InvalidSyntax: int
    InvalidUrl: int
    InvalidXml: int
    Java: int
    Json: int
    Locked: int
    MaxWords: int
    NoMatch: int
    NoPermissions: int
    NotFound: int
    NotOpen: int
    NotSupported: int
    OutOfMemory: int
    OutOfRange: int
    Overflow: int
    Read: int
    Recursion: int
    RemoteException: int
    RequestFailed: int
    ResultBufferTooSmall: int
    SQLite: int
    ShortRead: int
    Skipped: int
    PreventDefault: int
    StringParse: int
    TestFailure: int
    Timeout: int
    Unexpected: int
    Warning: int
    Write: int
    HandleInvalid: int
    HandleInvalidSeq: int
    HandleInvalidState: int
    HandleOutOfSlots: int
    TagInvalidClass: int
    TagInvalidFileSig: int
    TagInvalidHdr: int
    TagInvalidSig: int
    TagInvalidSize: int
    TagInvalidType: int
    PackInvalidSig: int
    PackInvalid: int
    Lz4Inflate: int
    Lz4Deflate: int
    LicenseLimit: int
    Retry: int
    InvalidFilename: int

class APERR(Exception):
    """Raised when an engine error occurs."""

    ec: Ec
    msg: str

    def __init__(self, ec: Ec = ..., msg: str = '') -> None: ...
    def check_raise(self) -> None: ...
    def toDict(self) -> Dict[str, str]: ...
    @staticmethod
    def fromDict(data: Dict[str, str]) -> 'APERR': ...

# ---- types.py ----

class PROTOCOL_CAPS:
    """Protocol capability flags (backed by C++ enum)."""

    SECURITY: int
    FILESYSTEM: int
    SUBSTREAM: int
    NETWORK: int
    DATANET: int
    SYNC: int
    INTERNAL: int
    CATALOG: int
    NOMONITOR: int
    NOINCLUDE: int
    INVOKE: int
    REMOTING: int
    GPU: int
    DEPRECATED: int
    EXPERIMENTAL: int

    @staticmethod
    def getProtocolCaps(protocol: str) -> int: ...

class FLAGS:
    """Entry.flags bitmask values."""

    NONE: int
    INDEX: int
    CLASSIFY: int
    OCR: int
    MAGICK: int
    SIGNING: int
    OCR_DONE: int
    PERMISSIONS: int
    VECTORIZE: int

class OPEN_MODE:
    """IEndpoint.openMode values."""

    NONE: int
    TARGET: int
    SOURCE: int
    SOURCE_INDEX: int
    SCAN: int
    CONFIG: int
    INDEX: int
    CLASSIFY: int
    INSTANCE: int
    CLASSIFY_FILE: int
    HASH: int
    STAT: int
    REMOVE: int
    TRANSFORM: int
    PIPELINE: int
    PIPELINE_CONFIG: int

class SERVICE_MODE:
    """IEndpoint.serviceMode values."""

    NONE: int
    SOURCE: int
    TARGET: int
    NEITHER: int

class ENDPOINT_MODE:
    """IEndpoint.endpointMode values."""

    NONE: int
    SOURCE: int
    TARGET: int

class TAG_ID(Enum):
    """Stream tag identifiers."""

    INVALID = ...
    OBEG = ...
    OMET = ...
    OENC = ...
    SBGN = ...
    SDAT = ...
    SEND = ...
    OSIG = ...
    OEND = ...
    ENCK = ...
    ENCR = ...
    CMPR = ...
    HASH = ...

class TAG:
    """Represents a binary stream tag."""

    tagId: str
    asBytes: bytes
    size: int
    data: bytes
    value: str

    @staticmethod
    def fromBytes(data: bytes) -> 'TAG': ...

class AVI_ACTION:
    """Action codes for media (audio/video/image) calls."""

    BEGIN: int
    WRITE: int
    END: int

class IJson:
    """
    C++ json::Value wrapper exposed to Python via PyBind11.
    Supports dict-like and list-like access patterns.
    """

    @overload
    def __init__(self) -> None: ...
    @overload
    def __init__(self, data: Dict[str, Any]) -> None: ...
    @overload
    def __init__(self, data: List[Any]) -> None: ...
    @overload
    def __init__(self, data: 'IJson') -> None: ...
    def keys(self) -> List[str]: ...
    def values(self) -> List[Any]: ...
    def items(self) -> List[tuple[str, Any]]: ...
    def get(self, key: str, default: Any = None) -> Any: ...
    def __contains__(self, item: Any) -> bool: ...
    def __iter__(self) -> Iterator[Any]: ...
    def __len__(self) -> int: ...
    def __getitem__(self, key: Any) -> Any: ...
    def __setitem__(self, key: Any, value: Any) -> None: ...
    def __delitem__(self, key: Any) -> None: ...
    def __repr__(self) -> str: ...
    def __dir__(self) -> List[str]: ...
    def __getattr__(self, key: str) -> Any: ...
    def append(self, value: Any) -> None: ...
    def insert(self, index: int, value: Any) -> None: ...
    def remove(self, index: int) -> None: ...
    def clear(self) -> None: ...
    def toDict(self) -> Dict[str, Any] | List[Any] | Any: ...

class IDict(dict[str, Any]):
    """Engine-managed dictionary (subclass of Python dict)."""

    ...

class Entry:
    """
    Metadata record for a single object passing through the pipe.
    The actual runtime type is the C++ Entry exposed via PyBind11.
    """

    accessTime: int
    attrib: int
    changeKey: str
    changeTime: int
    componentId: str
    completionError: Dict[str, Any]
    createTime: int
    fileName: str
    flags: int
    hasAccessTime: bool
    hasAttrib: bool
    hasChangeKey: bool
    hasChangeTime: bool
    hasComponentId: bool
    hasCreateTime: bool
    hasFileName: bool
    hasFlags: bool
    hasInstanceId: bool
    hasInstanceTags: bool
    hasKeyId: bool
    hasMetadata: bool
    hasModifyTime: bool
    hasName: bool
    hasObjectId: bool
    hasObjectTags: bool
    hasPath: bool
    hasPermissionId: bool
    hasResponse: bool
    hasServiceId: bool
    hasSize: bool
    hasStoreSize: bool
    hasUniqueName: bool
    hasUniquePath: bool
    hasUniqueUrl: bool
    hasUrl: bool
    hasVectorBatchId: bool
    hasVersion: bool
    hasWordBatchId: bool
    instanceId: str
    instanceTags: IJson
    keyId: str
    metadata: IJson
    modifyTime: int
    name: str
    objectFailed: bool
    objectSkipped: bool
    objectId: str
    objectTags: IJson
    path: str
    permissionId: int
    response: IJson
    serviceId: int
    size: int
    storeSize: int
    uniqueName: str
    uniquePath: str
    uniqueUrl: str
    url: str
    vectorBatchId: int
    version: int
    wordBatchId: int

    @overload
    def __init__(self) -> None: ...
    @overload
    def __init__(self, url: str) -> None: ...
    def completionCode(self, msg: str) -> None: ...
    def markChanged(self, msg: str) -> None: ...
    def toDict(self) -> Dict[str, Any]: ...
    def fromDict(self, data: Dict[str, Any]) -> None: ...

def getObject(
    filename: Optional[str] = None,
    defaultUrl: Optional[str] = None,
    obj: Optional[Dict[str, Any]] = None,
) -> Entry:
    """Create a fully-initialised Entry object ready to inject into a pipe."""
    ...

# ---- Pydantic control-plane models ----

class IControl:
    """Base model for engine control-channel messages."""

    control: str
    result: Any

class IInvokeOp:
    """Base class for invoke operation inner classes."""

    lane: str
    type: str  # computed from __qualname__

class IInvoke(IControl):
    """Envelope for invoke control-plane messages."""

    control: str

class IInvokeLLM(IInvoke):
    """LLM invoke operations namespace."""

    class Ask(IInvokeOp):
        lane: str
        op: str
        question: Any

    class GetContextLength(IInvokeOp):
        lane: str
        op: str

    class GetOutputLength(IInvokeOp):
        lane: str
        op: str

    class GetTokenCounter(IInvokeOp):
        lane: str
        op: str

class IInvokeTool(IInvoke):
    """Tool invoke operations namespace."""

    class Query(IInvokeOp):
        lane: str
        op: str
        tools: List[Any]

    class Invoke(IInvokeOp):
        lane: str
        op: str
        tool_name: str
        input: Any
        output: Any

    class Validate(IInvokeOp):
        lane: str
        op: str
        tool_name: str
        input: Any

class IInvokeMemory(IInvokeTool):
    """Memory invoke operations namespace (routes through tool lane)."""

    class Put(IInvokeTool.Invoke):
        lane: str
        tool_name: str

    class Get(IInvokeTool.Invoke):
        lane: str
        tool_name: str

    class List(IInvokeTool.Invoke):
        lane: str
        tool_name: str

    class Clear(IInvokeTool.Invoke):
        lane: str
        tool_name: str

class IInvokeCrew(IInvoke):
    """Crew/multi-agent invoke operations namespace."""

    class Describe(IInvokeOp):
        lane: str
        op: str
        agents: List[Any]

    class DescribeResponse:
        role: str
        task_description: str
        goal: str
        backstory: str
        expected_output: str
        instructions: List[str]
        node_id: str
        invoke: Any

class IInvokeDeepagent(IInvoke):
    """DeepAgent invoke operations namespace."""

    class Describe(IInvokeOp):
        lane: str
        op: str
        agents: List[Any]

    class DescribeResponse:
        name: str
        description: str
        system_prompt: str
        instructions: List[str]
        node_id: str
        invoke: Any

# ---- filters.py ----

class ToolDescriptor(TypedDict, total=False):
    """Canonical tool descriptor returned by tool.query."""

    name: str
    description: str
    inputSchema: Dict[str, Any]
    outputSchema: Dict[str, Any]

def invoke_function(fn: Callable) -> Callable:
    """Decorator: mark a method as an invoke handler (op name = method name)."""
    ...

def tool_function(
    *,
    input_schema: Any = None,
    description: Any = None,
    output_schema: Any = None,
) -> Callable:
    """Decorator: mark a method as a tool entry point discoverable by agents."""
    ...

def normalize_tool_input(
    input_obj: Any,
    *,
    extra_envelope_keys: Iterable[str] = (),
    strip_keys: Iterable[str] = ('security_context',),
    parse_json_strings: bool = True,
    unwrap_pydantic: bool = True,
    tool_name: str = 'tool',
) -> Dict[str, Any]:
    """Coerce agent-supplied tool input to a plain args dict."""
    ...

def require_str(args: Dict[str, Any], key: str, *, tool_name: str = '') -> str: ...
def require_int(
    args: Dict[str, Any],
    key: str,
    *,
    lo: Optional[int] = None,
    hi: Optional[int] = None,
    tool_name: str = '',
) -> int: ...
def require_bool(args: Dict[str, Any], key: str, *, tool_name: str = '') -> bool: ...
def optional_str(
    args: Dict[str, Any],
    key: str,
    *,
    default: Any = None,
    tool_name: str = '',
) -> Any: ...
def optional_int(
    args: Dict[str, Any],
    key: str,
    *,
    default: Any = None,
    lo: Optional[int] = None,
    hi: Optional[int] = None,
    tool_name: str = '',
) -> Any: ...
def optional_bool(
    args: Dict[str, Any],
    key: str,
    *,
    default: Any = None,
    tool_name: str = '',
) -> Any: ...
def validate_tool_input_schema(
    input_schema: Dict[str, Any],
    args: Dict[str, Any],
    *,
    tool_name: str = '',
) -> None: ...

class IServiceEndpoint(Protocol):
    """Engine-side endpoint interface (C++ side, accessed via self.endpoint)."""

    class IServiceEndpoint_JobConfig(TypedDict):
        config: str
        nodeId: str
        paths: Dict[str, Any]
        taskId: str
        type: str

    class IServiceEndpoint_ServiceConfig(TypedDict):
        key: str
        mode: str
        name: str
        parameters: Dict[str, Any]
        type: str

    openMode: int
    endpointMode: int
    level: int
    name: str
    key: str
    logicalType: str
    physicalType: str
    protocol: str
    serviceMode: int
    segmentSize: int
    storePath: str
    commonTargetPath: str
    exportUpdateBehavior: int
    exportUpdateBehaviorName: str
    jobConfig: 'IServiceEndpoint.IServiceEndpoint_JobConfig'
    taskConfig: Dict[str, Any]
    serviceConfig: 'IServiceEndpoint.IServiceEndpoint_ServiceConfig'
    parameters: Dict[str, Any]
    bag: Dict[str, Any]
    target: Any
    debugger: Any

    def insertFilter(self, filterName: str, filterConfig: Dict[str, Any]) -> None: ...
    def getToken(self, serviceConfig: 'IServiceEndpoint.IServiceEndpoint_ServiceConfig', key: str) -> str: ...
    def setToken(
        self, serviceConfig: 'IServiceEndpoint.IServiceEndpoint_ServiceConfig', key: str, value: str
    ) -> None: ...
    def getPipe(self) -> 'IServiceFilterPipe': ...
    def putPipe(self, pipe: 'IServiceFilterPipe') -> None: ...

class IServiceFilterPipe(Protocol):
    """Full engine filter-pipe interface (source + target combined)."""

    class IServiceFilterInstance_PipeType(TypedDict):
        id: str
        logicalType: str
        physicalType: str
        capabilities: int
        connConfig: Dict[str, Any]

    currentObject: Entry
    pipeType: 'IServiceFilterPipe.IServiceFilterInstance_PipeType'
    pipeId: int
    next: Optional['IServiceFilterPipe']
    targetObjectPath: str
    targetObjectUrl: str

    # Source-mode helpers
    def sendOpen(self, obj: Entry) -> None: ...
    def sendTagMetadata(self, metadata: Dict[str, Any]) -> None: ...
    def sendTagBeginObject(self) -> None: ...
    def sendTagBeginStream(self) -> None: ...
    def sendTagData(self, data: Any) -> None: ...
    def sendTagEndObject(self) -> None: ...
    def sendTagEndStream(self) -> None: ...
    def sendText(self, text: str) -> None: ...
    def sendTable(self, table: str) -> None: ...
    def sendAudio(self, action: int, mimeType: str, buffer: bytes) -> None: ...
    def sendVideo(self, action: int, mimeType: str, buffer: bytes) -> None: ...
    def sendImage(self, action: int, mimeType: str, buffer: bytes) -> None: ...
    def sendQuestions(self, question: Any) -> None: ...
    def sendAnswers(self, answer: List[Any]) -> None: ...
    def sendDocuments(self, documents: List[Any]) -> None: ...
    def sendClassifications(
        self,
        classifications: Dict[str, Any],
        classificationsPolicies: Dict[str, Any],
        classificationsRules: Dict[str, Any],
    ) -> None: ...
    def sendClassificationContext(self, classifications: Dict[str, Any]) -> None: ...
    def sendClose(self) -> None: ...
    def addPermissions(self, perm: Dict[str, Any], throwOnError: bool) -> None: ...
    def addUserGroupInfo(self, isUser: bool, id: str, authority: str, name: str, local: bool) -> bool: ...
    def addUserInfo(self, id: str, authority: str, name: str, local: bool) -> bool: ...
    def addGroupInfo(self, id: str, authority: str, name: str, local: bool, groupMembers: Any = None) -> bool: ...

    # Target-mode helpers
    def hasListener(self, lane: str) -> bool: ...
    def getListeners(self) -> List[str]: ...
    def getControllerNodeIds(self, classType: str) -> List[str]: ...
    def control(self, filter: str, control: IControl, nodeId: str = '') -> None: ...
    def open(self, obj: Entry) -> None: ...
    def writeTag(self, tag: Any) -> None: ...
    def writeTagBeginObject(self) -> None: ...
    def writeTagBeginStream(self) -> None: ...
    def writeTagData(self, data: Any) -> None: ...
    def writeTagEndStream(self) -> None: ...
    def writeTagEndObject(self) -> None: ...
    def writeText(self, text: str) -> None: ...
    def writeTable(self, table: str) -> None: ...
    def writeAudio(self, action: int, mimeType: str, buffer: bytes) -> None: ...
    def writeVideo(self, action: int, mimeType: str, buffer: bytes) -> None: ...
    def writeImage(self, action: int, mimeType: str, buffer: bytes) -> None: ...
    def writeQuestions(self, question: Any) -> None: ...
    def writeAnswers(self, answer: List[Any]) -> None: ...
    def writeDocuments(self, documents: List[Any]) -> None: ...
    def writeClassifications(
        self,
        classifications: Dict[str, Any],
        classificationsPolicies: Dict[str, Any],
        classificationsRules: Dict[str, Any],
    ) -> None: ...
    def writeClassificationContext(self, classifications: Dict[str, Any]) -> None: ...
    def closing(self) -> None: ...
    def close(self) -> None: ...

    # Monkey-patched by _patch_classes() in filters.py
    def invoke(self, param: Any, component_id: str = '') -> Any: ...
    def sendSSE(self, type: str, **data: Any) -> None: ...

class IEndpointBase:
    """Base class for all Python endpoint implementations."""

    endpoint: IServiceEndpoint

    def preventDefault(self) -> None: ...
    def beginEndpoint(self) -> None: ...
    def getConfigSubKey(self) -> str: ...
    def validateConfig(self, syntaxOnly: bool) -> None: ...
    def getPipeFilters(self) -> List[str | Dict[str, Any]]: ...
    def scanObjects(self, path: str, callback: Callable[[Dict[str, Any]], int]) -> None: ...
    def endEndpoint(self) -> None: ...

class IGlobalBase:
    """Base class for all Python global driver implementations."""

    IEndpoint: IEndpointBase
    glb: Any  # IFilterGlobal Protocol — logicalType, physicalType, connConfig

    def preventDefault(self) -> None: ...
    def beginGlobal(self) -> None: ...
    def endGlobal(self) -> None: ...

class IInstanceBase:
    """Base class for all Python instance driver implementations."""

    IEndpoint: IEndpointBase
    IGlobal: IGlobalBase
    instance: IServiceFilterPipe

    def preventDefault(self) -> None: ...
    def invoke(self, *args: Any, **kwargs: Any) -> Any: ...
    def control(self, control: IControl) -> None: ...
    def beginInstance(self) -> None: ...
    def endInstance(self) -> None: ...
    def checkChanged(self, obj: Entry) -> None: ...
    def removeObject(self, obj: Entry) -> None: ...
    def renderObject(self, obj: Entry) -> None: ...
    def getPermissions(self, obj: Entry) -> None: ...
    def stat(self, obj: Entry) -> None: ...
    def open(self, obj: Entry) -> None: ...
    def writeText(self, text: str) -> None: ...
    def writeTable(self, table: str) -> None: ...
    def writeAudio(self, action: int, mimeType: str, buffer: bytes) -> None: ...
    def writeVideo(self, action: int, mimeType: str, buffer: bytes) -> None: ...
    def writeImage(self, action: int, mimeType: str, buffer: bytes) -> None: ...
    def writeQuestions(self, question: Any) -> None: ...
    def writeAnswers(self, answer: List[Any]) -> None: ...
    def writeDocuments(self, documents: List[Any]) -> None: ...
    def writeClassifications(
        self,
        classifications: Dict[str, Any],
        classificationsPolicies: Dict[str, Any],
        classificationsRules: Dict[str, Any],
    ) -> None: ...
    def writeClassificationContext(self, classifications: Dict[str, Any]) -> None: ...
    def closing(self) -> None: ...
    def close(self) -> None: ...

    # Internal dispatch helpers (not typically overridden)
    def _collect_invoke_methods(self) -> Dict[str, Callable]: ...
    def _collect_tool_methods(self) -> Dict[str, Callable]: ...
    def _build_tool_descriptors(self, methods: Dict[str, Callable]) -> List[ToolDescriptor]: ...
    def _dispatch_tool(self, param: Any, op: str) -> Any: ...
    def _tool_query_dynamic(self) -> List[ToolDescriptor]: ...
    def _tool_invoke_dynamic(self, *, tool_name: str, input_obj: Any) -> Any: ...
    def _tool_config_description(self) -> str: ...

class ILoader(Protocol):
    """Creates / destroys pipes; used for loading operations."""

    target: IEndpointBase

    def beginLoad(self, pipeConfig: Dict[str, Any]) -> None: ...
    def endLoad(self) -> None: ...

# ---- engine.py ----

class Lvl(Enum):
    """Engine trace/logging levels."""

    Python = ...
    Remoting = ...
    DebugOut = ...
    DebugProtocol = ...

def args() -> List[str]:
    """Return the original command-line arguments."""
    ...

def monitorStatus(*args: Any) -> None:
    """Emit a monitor status update for long-running operations."""
    ...

def monitorCompleted(size: int) -> None:
    """Increment the completed byte/object counter."""
    ...

def monitorFailed(size: int) -> None:
    """Increment the failed byte/object counter."""
    ...

def monitorDependencyDownload(*args: Any) -> None:
    """Emit a dependency-download progress event."""
    ...

def monitorMetrics(*args: Any) -> None:
    """Emit arbitrary metrics to the monitor."""
    ...

def monitorOther(*args: Any) -> None:
    """Emit any other monitor information."""
    ...

def monitorSSE(pipe_id: int, type: str, data: Optional[Dict[str, Any]] = None) -> None:
    """Send a real-time SSE event to the UI for the current pipe."""
    ...

def isLevelEnabled(level: Lvl) -> bool:
    """Return True if the given engine logging level is active."""
    ...

def isAppMonitor() -> bool:
    """Return True when running with --monitor=app."""
    ...

def debug(*args: Any) -> None:
    """Emit a debug-level log message (shown when trace level is enabled)."""
    ...

def error(*args: Any) -> None:
    """Emit an error log message for a failed object."""
    ...

def warning(*args: Any) -> None:
    """Emit a warning log message."""
    ...

def readLine() -> str:
    """Read a line from the console."""
    ...

def configureLogger(name_: str | tuple[str, ...], level: Lvl) -> None:
    """Attach an engine-level logging handler to the named Python logger(s)."""
    ...

def expand(value: str) -> str:
    """Expand %key% environment tokens in *value* using the engine environment."""
    ...

def validatePipeline(config: Dict[str, Any]) -> Dict[str, Any]:
    """Validate a pipeline configuration dict; returns it annotated with errors."""
    ...

def getServiceDefinition(logicalType: str) -> Dict[str, Any]:
    """Return the service definition for the given logical type name."""
    ...

def getServiceDefinitions() -> Dict[str, Any]:
    """Return all registered service definitions."""
    ...

def getVersion() -> Dict[str, Any]:
    """Return engine version information."""
    ...

def processArguments(args: List[str]) -> None:
    """Process engine command-line arguments."""
    ...

def outputEndpointParameters(endpoint: IEndpointBase) -> None:
    """Log all configuration parameters of the given endpoint (debug helper)."""
    ...

def outputField(object: Entry, item: str) -> None:
    """Log a single Entry field if it has a value."""
    ...

def outputEntry(object: Entry) -> None:
    """Log all set fields of an Entry (debug helper)."""
    ...

def outputException() -> None:
    """Log the current exception in human-readable form."""
    ...

# ---- C++ engLib classes (imported directly in __init__.py) ----

class IPipeType:
    """Pipeline node metadata (C++ class exposed via PyBind11)."""

    id: str
    logicalType: str
    physicalType: str
    connConfig: IJson

class IOBuffer:
    """Target-mode I/O buffer (C++ class exposed via PyBind11)."""

    name: str
    segmentId: int
    data: bytes

class Paths:
    """Static configuration paths (C++ class exposed via PyBind11)."""

    DATA: str
    CACHE: str
    CONTROL: str
    LOG: str

class Filters:
    """
    C++ Filters helper class exposed by engLib.
    Provides utility methods for operating on filter pipelines.
    """

    ...

# ---- Public re-export declarations (mirrors __all__) ----

__all__: List[str]
