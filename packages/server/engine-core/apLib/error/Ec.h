// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

#pragma once

namespace ap {
// Define the error code enum
APUTIL_DEFINE_ENUM(
    Ec, 0, 94, NoErr = _begin, AccessDenied, AlreadyOpened, BatchExceeded,
    BatchThreshold, BlobImmutable, Bug, Cancelled, Cipher, Classify,
    ClassifyContent, ClrError, ClrInit, CoInit, Completed, ElevationRequired,
    Empty, End, Error, Exception, Excluded, Exists, ExpiredAuthentication,
    FactoryNotFound, Failed, Fatality, FileChanged, FileNotChanged, Fuse, Icu,
    InvalidAuthentication, InvalidCipher, InvalidCommand, InvalidDocument,
    InvalidFormat, InvalidJson, InvalidKeyStore, InvalidKeyToken, InvalidModule,
    InvalidName, InvalidParam, InvalidRpc, InvalidSchema, InvalidSelection,
    InvalidState, InvalidSyntax, InvalidUrl, InvalidXml, Java, Json, Locked,
    MaxWords, NoMatch, NoPermissions, NotFound, NotOpen, NotSupported,
    OutOfMemory, OutOfRange, Overflow, Python, Read, Recursion, RemoteException,
    RequestFailed, ResultBufferTooSmall, Retry, SQLite, ShortRead, Skipped,
    PreventDefault, StringParse, TestFailure, Timeout, Unexpected, Warning,
    Write, HandleInvalid, HandleInvalidSeq, HandleInvalidState,
    HandleOutOfSlots, TagInvalidClass, TagInvalidFileSig, TagInvalidHdr,
    TagInvalidSig, TagInvalidSize, TagInvalidType, PackInvalidSig, PackInvalid,
    Lz4Inflate, Lz4Deflate, LicenseLimit, InvalidFilename);

ErrorCode make_error_code(Ec code) noexcept;

}  // namespace ap

namespace std {

// Specialize the is_error_code_enum template to resolve to true for our error
// codes
template <>
struct is_error_code_enum<ap::Ec> : true_type {};

}  // namespace std
