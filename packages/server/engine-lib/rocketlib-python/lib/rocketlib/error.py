# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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

from engLib import Ec as _Ec


class Ec:
    """
    Standard error codes.
    """

    NoErr = _Ec.NoErr
    AccessDenied = _Ec.AccessDenied
    AlreadyOpened = _Ec.AlreadyOpened
    BatchExceeded = _Ec.BatchExceeded
    BatchThreshold = _Ec.BatchThreshold
    BlobImmutable = _Ec.BlobImmutable
    Bug = _Ec.Bug
    Cancelled = _Ec.Cancelled
    Cipher = _Ec.Cipher
    Classify = _Ec.Classify
    ClassifyContent = _Ec.ClassifyContent
    CoInit = _Ec.CoInit
    Completed = _Ec.Completed
    ElevationRequired = _Ec.ElevationRequired
    Empty = _Ec.Empty
    End = _Ec.End
    Error = _Ec.Error
    Exception = _Ec.Exception
    Excluded = _Ec.Excluded
    Exists = _Ec.Exists
    ExpiredAuthentication = _Ec.ExpiredAuthentication
    FactoryNotFound = _Ec.FactoryNotFound
    Failed = _Ec.Failed
    Fatality = _Ec.Fatality
    FileChanged = _Ec.FileChanged
    FileNotChanged = _Ec.FileNotChanged
    Fuse = _Ec.Fuse
    Icu = _Ec.Icu
    InvalidAuthentication = _Ec.InvalidAuthentication
    InvalidCipher = _Ec.InvalidCipher
    InvalidCommand = _Ec.InvalidCommand
    InvalidDocument = _Ec.InvalidDocument
    InvalidFormat = _Ec.InvalidFormat
    InvalidJson = _Ec.InvalidJson
    InvalidKeyToken = _Ec.InvalidKeyToken
    InvalidName = _Ec.InvalidName
    InvalidParam = _Ec.InvalidParam
    InvalidRpc = _Ec.InvalidRpc
    InvalidSchema = _Ec.InvalidSchema
    InvalidSelection = _Ec.InvalidSelection
    InvalidState = _Ec.InvalidState
    InvalidSyntax = _Ec.InvalidSyntax
    InvalidUrl = _Ec.InvalidUrl
    InvalidXml = _Ec.InvalidXml
    Java = _Ec.Java
    Json = _Ec.Json
    Locked = _Ec.Locked
    MaxWords = _Ec.MaxWords
    NoMatch = _Ec.NoMatch
    NoPermissions = _Ec.NoPermissions
    NotFound = _Ec.NotFound
    NotOpen = _Ec.NotOpen
    NotSupported = _Ec.NotSupported
    OutOfMemory = _Ec.OutOfMemory
    OutOfRange = _Ec.OutOfRange
    Overflow = _Ec.Overflow
    Read = _Ec.Read
    Recursion = _Ec.Recursion
    RemoteException = _Ec.RemoteException
    RequestFailed = _Ec.RequestFailed
    ResultBufferTooSmall = _Ec.ResultBufferTooSmall
    SQLite = _Ec.SQLite
    ShortRead = _Ec.ShortRead
    Skipped = _Ec.Skipped
    PreventDefault = _Ec.PreventDefault
    StringParse = _Ec.StringParse
    TestFailure = _Ec.TestFailure
    Timeout = _Ec.Timeout
    Unexpected = _Ec.Unexpected
    Warning = _Ec.Warning
    Write = _Ec.Write
    HandleInvalid = _Ec.HandleInvalid
    HandleInvalidSeq = _Ec.HandleInvalidSeq
    HandleInvalidState = _Ec.HandleInvalidState
    HandleOutOfSlots = _Ec.HandleOutOfSlots
    TagInvalidClass = _Ec.TagInvalidClass
    TagInvalidFileSig = _Ec.TagInvalidFileSig
    TagInvalidHdr = _Ec.TagInvalidHdr
    TagInvalidSig = _Ec.TagInvalidSig
    TagInvalidSize = _Ec.TagInvalidSize
    TagInvalidType = _Ec.TagInvalidType
    PackInvalidSig = _Ec.PackInvalidSig
    PackInvalid = _Ec.PackInvalid
    Lz4Inflate = _Ec.Lz4Inflate
    Lz4Deflate = _Ec.Lz4Deflate
    LicenseLimit = _Ec.LicenseLimit


globals()['Ec'] = _Ec


class APERR(Exception):
    """
    Create error which can be thrown.
    """

    def __init__(self, ec: Ec = Ec.NoErr, msg=''):
        """Initialize the custom exception. Leave default args to initialize 'No Error'."""
        self.ec = ec
        self.msg = msg
        super().__init__(f'Error {ec}: {msg}')

    def check_raise(self):
        """Raise if this is exception, pass otherwise."""
        if self.ec != Ec.NoErr:
            raise self

    def toDict(self) -> dict:
        """Convert to dict."""
        return {
            'code': str(self.ec).split('.')[1],  # e.g. 'Ec.NoErr' -> 'NoErr'
            'message': self.msg,
        }

    @staticmethod
    def fromDict(data: dict) -> 'APERR':
        """Parse from dict."""
        if hasattr(Ec, data['code']):
            return APERR(getattr(Ec, data['code']), data['message'])
        return APERR(Ec.InvalidParam, data['message'])
