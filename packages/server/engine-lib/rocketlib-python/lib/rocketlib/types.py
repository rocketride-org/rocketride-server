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

from enum import Enum
from typing import Any, Dict, List
import uuid

from depends import depends

depends()

from pydantic import BaseModel, ConfigDict, Field, computed_field

from engLib import PROTOCOL_CAPS as _PROTOCOL_CAPS
from engLib import TAG_ID as _TAG_ID, TAG as _TAG
from engLib import Entry as Impl_Entry
from engLib import IJson as Impl_IJson
from engLib import FLAGS as Impl_FLAGS
from engLib import OPEN_MODE as Impl_OPEN_MODE
from engLib import SERVICE_MODE as Impl_SERVICE_MODE
from engLib import ENDPOINT_MODE as Impl_ENDPOINT_MODE
from engLib import AVI_ACTION as Impl_AVI_ACTION


class PROTOCOL_CAPS:
    SECURITY = _PROTOCOL_CAPS.SECURITY
    FILESYSTEM = _PROTOCOL_CAPS.FILESYSTEM
    SUBSTREAM = _PROTOCOL_CAPS.SUBSTREAM
    NETWORK = _PROTOCOL_CAPS.NETWORK
    DATANET = _PROTOCOL_CAPS.DATANET
    SYNC = _PROTOCOL_CAPS.SYNC
    INTERNAL = _PROTOCOL_CAPS.INTERNAL
    CATALOG = _PROTOCOL_CAPS.CATALOG
    NOMONITOR = _PROTOCOL_CAPS.NOMONITOR
    NOINCLUDE = _PROTOCOL_CAPS.NOINCLUDE
    INVOKE = _PROTOCOL_CAPS.INVOKE
    REMOTING = _PROTOCOL_CAPS.REMOTING
    GPU = _PROTOCOL_CAPS.GPU

    @staticmethod
    def getProtocolCaps(protocol: str) -> int:
        pass


globals()['PROTOCOL_CAPS'] = _PROTOCOL_CAPS


class FLAGS:
    """
    Entry.flags values.
    """

    NONE: int = Impl_FLAGS.NONE
    INDEX: int = Impl_FLAGS.INDEX
    CLASSIFY: int = Impl_FLAGS.CLASSIFY
    OCR: int = Impl_FLAGS.OCR
    MAGICK: int = Impl_FLAGS.MAGICK
    SIGNING: int = Impl_FLAGS.SIGNING
    OCR_DONE: int = Impl_FLAGS.OCR_DONE
    PERMISSIONS: int = Impl_FLAGS.PERMISSIONS
    VECTORIZE: int = Impl_FLAGS.VECTORIZE


class OPEN_MODE:
    """
    Declare the IEndpoint.openMode values.
    """

    NONE: int = Impl_OPEN_MODE.NONE
    TARGET: int = Impl_OPEN_MODE.TARGET
    SOURCE: int = Impl_OPEN_MODE.SOURCE
    SOURCE_INDEX: int = Impl_OPEN_MODE.SOURCE_INDEX
    SCAN: int = Impl_OPEN_MODE.SCAN
    CONFIG: int = Impl_OPEN_MODE.CONFIG
    INDEX: int = Impl_OPEN_MODE.INDEX
    CLASSIFY: int = Impl_OPEN_MODE.CLASSIFY
    INSTANCE: int = Impl_OPEN_MODE.INSTANCE
    CLASSIFY_FILE: int = Impl_OPEN_MODE.CLASSIFY_FILE
    HASH: int = Impl_OPEN_MODE.HASH
    STAT: int = Impl_OPEN_MODE.STAT
    REMOVE: int = Impl_OPEN_MODE.REMOVE
    TRANSFORM: int = Impl_OPEN_MODE.TRANSFORM
    PIPELINE: int = Impl_OPEN_MODE.PIPELINE
    PIPELINE_CONFIG: int = Impl_OPEN_MODE.PIPELINE_CONFIG


class SERVICE_MODE:
    """
    Declare the IEndpoint.serviceMode values.
    """

    NONE: int = Impl_SERVICE_MODE.NONE
    SOURCE: int = Impl_SERVICE_MODE.SOURCE
    TARGET: int = Impl_SERVICE_MODE.TARGET
    NEITHER: int = Impl_SERVICE_MODE.NEITHER


class ENDPOINT_MODE:
    """
    Declare the IEndpoint.endpointMode values.
    """

    NONE: int = Impl_ENDPOINT_MODE.NONE
    SOURCE: int = Impl_ENDPOINT_MODE.SOURCE
    TARGET: int = Impl_ENDPOINT_MODE.TARGET


class TAG_ID(Enum):
    INVALID = _TAG_ID.INVALID
    OBEG = _TAG_ID.OBEG
    OMET = _TAG_ID.OMET
    OENC = _TAG_ID.OENC
    SBGN = _TAG_ID.SBGN
    SDAT = _TAG_ID.SDAT
    SEND = _TAG_ID.SEND
    OSIG = _TAG_ID.OSIG
    OEND = _TAG_ID.OEND
    ENCK = _TAG_ID.ENCK
    ENCR = _TAG_ID.ENCR
    CMPR = _TAG_ID.CMPR
    HASH = _TAG_ID.HASH


class TAG:
    """
    Begin a stream.
    """

    tagId: str
    asBytes: bytes
    size: int
    data: bytes
    value: str

    @staticmethod
    def fromBytes(data: bytes) -> 'TAG':
        raise NotImplementedError()


globals()['TAG_ID'] = _TAG_ID
globals()['TAG'] = _TAG


class AVI_ACTION:
    """
    Define action codes associated with media calls.
    """

    BEGIN: int = Impl_AVI_ACTION.BEGIN  #: Action code for beginning a media call.
    WRITE: int = Impl_AVI_ACTION.WRITE  #: Action code for writing media data.
    END: int = Impl_AVI_ACTION.END  #: Action code for ending a media call.


class IControl(BaseModel):
    """
    Data model for the control channel.

    This is used to send any control to a driver, but usually will be 'invoke'.
    """

    control: str  # Required field
    result: Any = None  # Optional field for the result of the control operation

    model_config = ConfigDict(extra='allow')  # Pydantic v2 way to allow extra fields


class IInvoke(IControl):
    """
    Envelope for invoke control-plane messages.

    Used as the transport wrapper around an IInvokeOp operation object.
    The ``param`` field carries the typed operation (e.g. IInvokeLLM.Ask).
    """

    control: str = 'invoke'

    model_config = ConfigDict(extra='allow')


class IInvokeOp(BaseModel):
    """
    Base class for invoke operation inner classes.

    Provides:
    - ``type``: computed from ``__qualname__`` (e.g. ``"IInvokeLLM.Ask"``)
    - ``lane``: routing target (e.g. ``"llm"``, ``"tool"``, ``"memory"``)
    - ``extra='allow'``: accepts additional fields
    """

    lane: str = ''

    model_config = ConfigDict(extra='allow')

    @computed_field
    @property
    def type(self) -> str:
        """Returns the qualified class name (e.g. 'IInvokeLLM.Ask') for trace rendering."""
        return type(self).__qualname__


class IInvokeLLM(IInvoke):
    """
    LLM invoke operations. Pure namespace — construct via inner classes.

    Usage::

        param = IInvokeLLM.Ask(question=q)
        result = instance.invoke(param, component_id=llm_node)
    """

    class Ask(IInvokeOp):
        """Ask the LLM a question. Requires a Question object."""

        lane: str = 'llm'
        op: str = Field(default='ask', frozen=True)
        question: Any  # Required — client SDK's Question object

    class GetContextLength(IInvokeOp):
        """Get the maximum context length for the model."""

        lane: str = 'llm'
        op: str = Field(default='getContextLength', frozen=True)

    class GetOutputLength(IInvokeOp):
        """Get the maximum output length for the model."""

        lane: str = 'llm'
        op: str = Field(default='getOutputLength', frozen=True)

    class GetTokenCounter(IInvokeOp):
        """Get a token counter function for the model."""

        lane: str = 'llm'
        op: str = Field(default='getTokenCounter', frozen=True)


class IInvokeTool(IInvoke):
    """
    Tool invoke operations. Pure namespace — construct via inner classes.

    Usage::

        param = IInvokeTool.Query()
        param = IInvokeTool.Invoke(tool_name='search', input={...})
        param = IInvokeTool.Validate(tool_name='search', input={...})
    """

    class Query(IInvokeOp):
        """Discover available tools. Each tool node appends its descriptors to ``tools``."""

        lane: str = 'tool'
        op: str = Field(default='tool.query', frozen=True)
        tools: List[Any] = Field(default_factory=list)

    class Invoke(IInvokeOp):
        """Invoke a tool with the provided input parameters."""

        lane: str = 'tool'
        op: str = Field(default='tool.invoke', frozen=True)
        tool_name: str
        input: Any
        output: Any = Field(default=None)

    class Validate(IInvokeOp):
        """Validate tool input parameters without executing."""

        lane: str = 'tool'
        op: str = Field(default='tool.validate', frozen=True)
        tool_name: str
        input: Any


class IInvokeMemory(IInvokeTool):
    """
    Memory invoke operations. Derives from IInvokeTool so memory ops
    route through the tool dispatch protocol.

    Usage::

        param = IInvokeMemory.Put(input={'key': 'user_pref', 'value': {...}})
        param = IInvokeMemory.Get(input={'key': 'user_pref'})
    """

    class Put(IInvokeTool.Invoke):
        """Store a value in memory."""

        lane: str = 'memory'
        tool_name: str = Field(default='put', frozen=True)

    class Get(IInvokeTool.Invoke):
        """Retrieve a value from memory."""

        lane: str = 'memory'
        tool_name: str = Field(default='get', frozen=True)

    class List(IInvokeTool.Invoke):
        """List all keys in memory."""

        lane: str = 'memory'
        tool_name: str = Field(default='list', frozen=True)

    class Clear(IInvokeTool.Invoke):
        """Clear entries from memory. If key is provided, clears only that entry."""

        lane: str = 'memory'
        tool_name: str = Field(default='clear', frozen=True)


class IInvokeCrew(IInvoke):
    """
    Control-plane type for CrewAI sub-agent discovery (crewai.describe fan-out).

    Each sub-agent connected on the 'crewai' channel appends a DescribeResponse
    to Describe.agents when the orchestrator fans out a Describe request.
    """

    op: str = 'crewai.describe'
    model_config = ConfigDict(extra='allow')

    class Describe(BaseModel):
        """Fan-out request: each connected sub-agent appends its descriptor."""

        op: str = Field(default='crewai.describe', frozen=True)
        agents: List[Any] = Field(default_factory=list)
        model_config = ConfigDict(extra='allow')

    class DescribeResponse(BaseModel):
        """Sub-agent descriptor returned in response to crewai.describe."""

        op: str = Field(default='crewai.describe', frozen=True)
        role: str
        task_description: str
        goal: str = ''
        backstory: str = ''
        expected_output: str = ''
        instructions: List[str] = Field(default_factory=list)
        node_id: str = ''  # pSelf.instance.pipeType['id'] — used to filter sub-agents from tool list
        invoke: Any = Field(default=None)  # full pSelf IInstance — passed to AgentHostServices(d.invoke)
        model_config = ConfigDict(extra='allow')


class IJson(Impl_IJson):
    """
    A wrapper class for IJson that provides utility methods for handling JSON-like structures.
    """

    @staticmethod
    def toDict(obj):
        """
        Recursively converts an IJson object or a dictionary, ensuring all IJson values are converted to dicts.

        Args:
            obj: The object to be converted. Can be an IJson instance, a dictionary, or a list.

        Returns:
            The converted object, where all IJson instances are replaced with standard Python dictionaries.
        """
        if isinstance(obj, Impl_IJson):  # Use the correctly imported class name
            return IJson.toDict(obj.toDict())  # Convert IJson to dict and recurse

        if isinstance(obj, dict):
            return {key: IJson.toDict(value) for key, value in obj.items()}  # Recursively process dictionary

        if isinstance(obj, list):
            return [IJson.toDict(item) for item in obj]  # Recursively process lists

        return obj


class IDict(dict):
    """
    Declare the IDict.

    IDict is a standard dictionary but has special
    constructors and destructors on the engine side
    so it needs to be declared here. It is a dictionary.
    """

    pass


class Entry:
    """
    Current object being acted upon in the pipe.

    This defines the shape of it fro the editors, but we will
    replace the implementation with the actual after we defint it
    """

    accessTime: int
    attrib: int
    changeTime: int
    componentId: str
    createTime: int
    fileName: str
    flags: int
    hasAccessTime: bool
    hasAttrib: bool
    hasChangeTime: bool
    hasComponentId: bool
    hasCreateTime: bool
    hasFileName: bool
    hasFlags: bool
    hasInstanceId: bool
    hasKeyId: bool
    hasModifyTime: bool
    hasName: bool
    hasObjectId: bool
    hasPath: bool
    hasPermissionId: bool
    hasServiceId: bool
    hasSize: bool
    hasStorSize: bool
    hasUniqueName: bool
    hasUniquePath: bool
    hasUniqueUrl: bool
    hasUrl: bool
    hasVersion: bool
    hasWordBatchId: bool
    instanceId: str
    keyId: str
    modifyTime: int
    name: str
    objectFailed: bool
    objectSkipped: bool
    objectId: str
    path: str
    permissionId: int
    serviceId: int
    size: int
    storeSize: int
    uniqueName: str
    uniquePath: str
    uniqueUrl: str
    url: str
    version: int
    wordBatchId: int

    def completionCode(self, msg: str) -> None:
        pass

    def markChanged(self, msg: str) -> None:
        pass

    def toDict(self) -> dict:
        pass

    def fromDict(self, data: dict):
        pass


"""
Import the Entry class. We defined it above mainly
for the editors and typing, but we do want to use the actual
implementation from the engine.
"""
# noqa
Entry = Impl_Entry  # noqa: F811


def getObject(filename: str = None, defaultUrl: str = None, obj: Dict[str, Any] = None) -> Entry:
    """
    Create an object Entry.

    Args:
            filename (str, optional): The name of the target file. If not provided, a UUID will be generated.
            defaultUrl (str, optional): The default URL for the object. Defaults to 'null://Stream'.

    Returns:
            obj (Entry): The entry object representing the target resource

    Raises:
            Exception: If an error occurs while opening the target.
    """
    # We are going to file in the object first
    if obj is None:
        obj = {}

    # Add the two optional parameters to the object
    if filename:
        obj['name'] = filename
    if defaultUrl:
        obj['url'] = defaultUrl

    # Generate a unique filename if not provided
    if 'name' not in obj:
        obj['name'] = str(uuid.uuid4())  # Default to a UUID if no filename is given

    # If url was not specified, generate one
    if 'url' not in obj:
        obj['url'] = f'null://Stream/{obj.get("name")}'

    # If an object id is not specified, generate one based on the url
    if 'objectId' not in obj:
        obj['objectId'] = str(uuid.uuid5(uuid.NAMESPACE_URL, obj.get('url')))

    # Create an entry object to hold file metadata
    entry = Entry(obj.get('url'))

    # If we don't set these, some operations may be disabled
    entry.flags = FLAGS.INDEX | FLAGS.CLASSIFY | FLAGS.SIGNING | FLAGS.PERMISSIONS | FLAGS.VECTORIZE

    # Now, copy over all the fields specified in the object. We specifically inhibit
    # the url field as the engine is really picky on that one and, it is already set.
    # Also, flags is forced to the fixed flag values required by the engine
    for key, value in obj.items():
        # Skip url
        if key == 'url' or key == 'flags':
            continue

        # Only set know attributes
        if hasattr(entry, key):
            setattr(entry, key, value)

    # Return the object
    return entry
