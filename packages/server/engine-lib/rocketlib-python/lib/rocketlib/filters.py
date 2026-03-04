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
from typing import TYPE_CHECKING, Dict, Any, List, TypedDict, Callable, Protocol
from .types import OPEN_MODE, ENDPOINT_MODE, SERVICE_MODE, Entry, IControl, IInvoke
from .error import APERR, Ec

if TYPE_CHECKING:
    from ai.common.schema import Doc, Question, Answer


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

    def sendClassifications(self, classifications: Dict[str, Any], classificationsPolicies: Dict[str, Any], classificationsRules: Dict[str, Any]) -> None:
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

    def control(self, filter: str, control: IControl) -> None:
        """Control the instance using the parameters in control."""
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

    def writeClassifications(self, classifications: Dict[str, Any], classificationPolicy: Dict[str, Any], classificationRules: Dict[str, Any]) -> None:
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
        """
        Handle an incoming invoke call.

        Throw an error since the driver did not accept this invoke call. Every
        driver will be called, in order, until one of them returns without
        throwing any error. If an error other than preventDefault is thrown,
        then the chain will stop and that error will be thrown to the caller. If
        preventDefault is thrown, the next driver will be called to see if it
        can handle the request.
        """
        raise APERR(Ec.InvalidParam, f'Driver {self.IGlobal.glb.logicalType} does not accept invoke calls')

    def control(self, control: IControl) -> None:
        """
        Process called by someone in our pipeline.

        Normally, you do not need to override this. It is the dispatcher, which
        usually calls invoke. If you do override, make sure you call super.control
        if it is an invoke call.
        """
        if control.control == 'invoke':
            control.result = self.invoke(*control.args, **control.kwargs)
        else:
            raise APERR(Ec.InvalidParam, f'Unrecognized control {control.control} sent to {self.IGlobal.glb.logicalType}')

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

    def writeClassifications(self, classifications: Dict[str, Any], classificationPolicy: Dict[str, Any], classificationRules: Dict[str, Any]) -> None:
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
    """Add Python methods to C++ classes."""

    def invoke(self, classType: str, *args, **kwargs) -> Any:
        control = IInvoke(args=args, kwargs=kwargs, result=None)
        self.control(classType, control)
        return control.result

    # Add to the actual C++ class
    from engLib import IFilterInstance as Impl_IFilterInstance

    Impl_IFilterInstance.invoke = invoke


# Apply patches
_patch_classes()
