// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
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

namespace ap::log {

// Use the utility macros to declare an enumeration and an associated
// array of strings matching the enumeration values all at compile time.
// This will create a Lvl enumeration, and a LvlStrings array with
// each array item containing the string definition that lines up with
// the levels enumeration offset.
APUTIL_DEFINE_ENUM(
    Lvl, 0, 139,
    // Special levels
    All = _begin,  // Enables all logging (used only in configuration)
    Always,  // Always logged, regardless of config (used only in execution for
             // critical messages)
    Error,   // All errors, both configuration and execution

    // apLib
    Buffer, Compress, Connection, Crypto, Data, Dev, Factory, Fatality, File,
    FileStream, Glob, HandleTable, Heap, Icu, Init, Json, KeyStore,
    KeyStoreFile, KeyStoreNet, Lines, Match, Mount, Perf, PerfD, Permissions,
    Regex, SQLite, Selections, Smb, Snap, Socket, StackTrace, Tag, Test, Thread,
    Tls, Usn, UsnDetails, Volume, Work, WorkExec, Xml,

    // engLib jobs
    Job, JobAction, JobClassify, JobClassifyFiles, JobConfigureService, JobExec,
    JobFileScan, JobScan, JobIndex, JobInstance, JobGenerateKey, JobMonitorTest,
    JobPermissions, JobPipeline, JobSearchBatch, JobServices, JobSign, JobStat,
    JobSysInfo, JobTokenize, JobTransform, JobUpdateScan, JobValidate,
    JobResidentProcess,

    // engLib
    Azure, Classify,
    ClassifyContext,    // Classification evaluation contexts
    ClassifyDetails,    // Classify logging
    ClassifyDoc,        // Classified document text
    ClassifyPolicies,   // Classification policies and rules
    ClassifyResults,    // Classify XML results
    Clr,                // CLR subsystem
    DebugProtocol,      // Debugger DAP/CON protocol logging
    DebugOut,           // Debugger output
    ExtractedMetadata,  // Log metadata extracted by Tika
    ExtractedText,      // Log text extracted by Tika
    FileStat, Framer, GIL, Index,
    Java,         // Info, Warn, and Error logging from Tika
    JavaDetails,  // Debug and Trace logging from Tika (in addition to above
                  // levels)
    JavaHeap,  // No additional logging but enables Java heap diagnostics, see
               // https://docs.oracle.com/javase/8/docs/technotes/guides/troubleshoot/tooldescr007.html
    Jni,       // JNI
    Jvm,       // JVM
    MemoryBuffer,
    Python,  // Python interpeter
    Parse, ParsedDoc, Pipe, Remoting,

    StreamDatafile, StreamDatanet, StreamZipfile, StreamZipnet,

    ServiceObjectDetail,

    Services, ServiceRocketRide, ServiceBottom, ServiceCapture, ServiceClassify,
    ServiceClr, ServiceCollapse, ServiceCompression, ServiceEncryption,
    ServiceEndpoint, ServiceFilesys, ServiceFilter, ServiceSmb, ServiceHash,
    ServiceIndexer, ServiceInput, ServiceLogger, ServiceNative, ServiceNull,
    ServiceObjectStore, ServiceAzureBlob, ServiceObjectStoreDetails,
    ServiceOutput, ServiceParser, ServicePermissions, ServicePipe,
    ServicePython, ServiceScan, ServiceTee, ServiceTokenize, ServiceZip,
    ServiceSharepoint, ServiceOutlook,

    ScanContainers, ScanObjects,

    Search, WordDb, Words);

}  // namespace ap::log

namespace ap {

// Expose Lvl enum in the primary ap namespace for convenience
using Lvl = log::Lvl;

}  // namespace ap
