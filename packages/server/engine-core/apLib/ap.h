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

//
//	Top level engine header
//
#pragma once
#include <cstddef>  // For size_t used in Size_t below

#if !defined(NDEBUG)
#define ROCKETRIDE_BUILD_DEBUG 1
#endif

// Start the rocketride namespace, if apLib itself is being built use it
namespace ap {
class Error;
template <typename ResultT>
class ErrorOr;

// Normalize size_t ambiguity usage between osx and others
// osx uses the LP64 vs LLP64 models of size_t definitions
// use in places where u need to exchange size_t between
// uint64_t
#if ROCKETRIDE_PLAT_MAC
using Size_t = unsigned long long;
#else
using Size_t = size_t;
#endif
}  // namespace ap
#if BUILD_APLIB
using namespace ap;
#endif
// Use JSON exceptions
#define JSON_USE_EXCEPTION 1

// Include the basic system headers
#include <apLib/headers.h>

#include <apLib/memory/pmr.hpp>
#include <apLib/global.h>
#include <apLib/factory/types.h>
#include <apLib/traits.hpp>
#include <apLib/string/macros.h>
#include <apLib/string/charTypes.h>
#include <apLib/string/packTraits.h>
#include <apLib/string/Format.h>
#include <apLib/util/numericCast.h>
#include <apLib/string/StrApi.hpp>
#include <apLib/memory/ShortAllocator.hpp>
#include <apLib/memory/small.h>
#include <apLib/Location.h>
#include <apLib/async/Tls.h>
#include <apLib/util/typeName.h>
#include <apLib/string/FormatOptions.hpp>
#include <apLib/util/enum.hpp>
#include <apLib/util/hash.h>
#include <apLib/log/macros.h>
#include <apLib/async/types.h>
#include <apLib/async/work/types.h>
#include <apLib/util/macros.h>
#include <apLib/string/NoCase.hpp>
#include <apLib/string/Case.hpp>
#include <apLib/memory/forwards.h>
#include <apLib/memory/types.h>
#include <apLib/string/StrView.hpp>
#include <apLib/string/cast.h>
#include <apLib/string/viewTokenize.hpp>
#include <apLib/error/Ec.h>

#if ROCKETRIDE_PLAT_WIN
#include <apLib/error/win/Win32Errc.h>
#elif ROCKETRIDE_PLAT_LIN
#include <apLib/error/unx/ErrnoErrc.h>
#elif ROCKETRIDE_PLAT_MAC
#include <apLib/error/unx/ErrnoErrc.h>
#endif

#include <apLib/file/pathForwards.h>

#include <apLib/log/Lvl.hpp>
#include <apLib/transform.h>
#include <apLib/traitMacros.h>
#include <apLib/string/PackAdapter.h>
#include <apLib/string/traits.hpp>
#include <apLib/dev/macros.h>
#include <apLib/dev/api.h>
#include <apLib/memory/BucketArray.hpp>
#include <apLib/ChildOf.hpp>
#include <apLib/string/stdTraits.hpp>
#include <apLib/memory/dataTypes.h>
#include <apLib/string/Str.hpp>
#include <apLib/string/strTraits.hpp>
#include <apLib/traits2.hpp>
#include <apLib/string/global.hpp>
#include <apLib/string/types.h>
#include <apLib/plat/types.h>
#include <apLib/plat/init.h>

#if ROCKETRIDE_PLAT_WIN
// On Windows, use Boost stacktrace as our Backtrace class (supports toString
// via operator <<)
namespace ap::dev {
typedef boost::stacktrace::stacktrace Backtrace;
}
#elif ROCKETRIDE_PLAT_LIN
   // On Linux, use libbacktrace for stacktraces
#include <apLib/dev/lin/Backtrace.h>
#elif ROCKETRIDE_PLAT_MAC
   // Don't support stacktraces on OSX
// libbacktrace doesn't compile reliably and is reporting no symbols for OSX
// binaries anyway
namespace ap::dev {
typedef Text Backtrace;
}
#else
   // nothing
#endif

#include <apLib/util/tuple.hpp>
#include <apLib/util/algorithm.hpp>
#include <apLib/string/api.h>
#include <apLib/crypto/hex.h>
#include <apLib/memory/DataView.hpp>
#include <apLib/memory/cast.hpp>
#include <apLib/memory/literals.hpp>
#include <apLib/string/PackAdapter.hpp>
#include <apLib/memory/traits.hpp>
#include <apLib/memory/iteratorTraits.hpp>
#include <apLib/memory/global.hpp>
#include <apLib/log/api.h>
#include <apLib/string/chrApi.hpp>
#include <apLib/string/StrVector.hpp>
#include <apLib/string/toString.h>
#include <apLib/plat/api.hpp>
#include <apLib/util/Vars.hpp>
#include <apLib/util/api.hpp>
#include <apLib/util/ComboIter.hpp>
#include <apLib/string/FormatStr.hpp>
#include <apLib/string/formatApi.h>
#include <apLib/string/literals.hpp>
#include <apLib/time/types.h>
#include <apLib/log/write.h>
#include <apLib/error/traits.hpp>
#include <apLib/error/Error.h>
#include <apLib/error/makeError.h>
#include <apLib/error/macros.h>
#include <apLib/error/ErrorOr.hpp>
#include <apLib/error/ErrorOr_Void.hpp>
#include <apLib/error/ErrorOr_Bool.hpp>
#include <apLib/deref.hpp>
#include <apLib/file/Mode.h>
#include <apLib/application/readLine.h>
#include <apLib/application/stdinMonitor.h>
#include <apLib/memory/toData.h>
#include <apLib/memory/fromData.h>
#include <apLib/memory/PaginatedVector.hpp>
#include <apLib/error/dispatch.hpp>
#include <apLib/util/Guard.hpp>
#include <apLib/dev/bugCheckScope.hpp>
#include <apLib/time/transform.h>
#include <apLib/time/Duration.hpp>
#include <apLib/async/api.h>
#include <apLib/async/traits.hpp>
#include <apLib/async/lockTraits.hpp>
#include <apLib/async/work/init.h>
#include <apLib/async/Event.hpp>
#include <apLib/async/Semaphore.hpp>
#include <apLib/async/Mutex.hpp>
#include <apLib/async/LockApi.hpp>
#include <apLib/time/global.hpp>
#include <apLib/time/api.h>
#include <apLib/time/toData.hpp>
#include <apLib/string/fromString.h>
#include <apLib/time/format.h>
#include <apLib/time/api.hpp>
#include <apLib/time/transform.hpp>
#include <apLib/time/Duration_Pack.hpp>
#include <apLib/async/AtomicFlag.hpp>
#include <apLib/async/Lock.hpp>
#include <apLib/async/Lock_Shared.hpp>
#include <apLib/async/lockTypes.h>
#include <apLib/async/Condition.hpp>
#include <apLib/log/consoleLock.hpp>

#include <apLib/file/fsType.h>

#include <apLib/json/jsonCpp.h>
#include <apLib/time/toJson.hpp>
#include <apLib/json/types.h>
#include <apLib/json/traits.hpp>
#include <apLib/json/parse.h>
#include <apLib/string/toStringCheck.hpp>
#include <apLib/json/toJson.h>
#include <apLib/json/toData.h>
#include <apLib/json/Schema.hpp>
#include <apLib/json/fromJson.h>

#ifdef ROCKETRIDE_PLAT_UNX
#include <apLib/file/unx/types.h>
#endif

#if ROCKETRIDE_PLAT_WIN
#include <apLib/plat/win/ComInit.hpp>
#include <apLib/file/win/types.h>
#include <apLib/file/win/transform.h>
#include <apLib/application/win/readLine.hpp>
#elif ROCKETRIDE_PLAT_LIN
#include <apLib/file/lin/types.h>
#endif
#ifdef ROCKETRIDE_PLAT_UNX
#include <apLib/application/unx/readLine.hpp>
#ifndef ROCKETRIDE_PLAT_MAC
#include <apLib/application/unx/readLine.hpp>
#endif
#endif

#include <apLib/file/StatInfo.hpp>
#include <apLib/file/MntEntInfo.hpp>

#include <apLib/file/types.h>
#include <apLib/string/fromString.h>
#include <apLib/file/sep.hpp>
#include <apLib/file/PathTrait.hpp>
#include <apLib/file/PathType.h>
#include <apLib/file/pathTypes.h>
#include <apLib/string/StackStr.h>
#include <apLib/string/toData.h>
#include <apLib/log/Color.h>
#include <apLib/log/Options.h>
#if ROCKETRIDE_PLAT_WIN
#include <apLib/file/win/WinPathApi.hpp>
#else
#include <apLib/file/unx/UnxPathApi.hpp>
#endif
#include <apLib/file/pathApiTypes.h>

#include <apLib/file/traits.hpp>
#include <apLib/file/FilePath.hpp>

#include <apLib/url/types.h>
#include <apLib/url/api.hpp>
#include <apLib/url/Builder.hpp>
#include <apLib/url/build.hpp>
#include <apLib/url/Url.hpp>

#include <apLib/file/toData.hpp>
#include <apLib/file/pathLiterals.hpp>
#include <apLib/memory/adapter/concepts.hpp>
#include <apLib/memory/adapter/Input.hpp>
#include <apLib/memory/adapter/Output.hpp>
#include <apLib/memory/adapter/NullOutput.hpp>
#include <apLib/memory/adapter/make.hpp>
#include <apLib/crypto/Hash.h>
#include <apLib/file/api.h>
#include <apLib/application/api.h>
#include <apLib/application/CmdLine.h>
#include <apLib/util/Singleton.hpp>
#include <apLib/application/Opt.h>
#include <apLib/application/Options.h>
#include <apLib/application/Opt.hpp>
#include <apLib/application/Options.hpp>
#if ROCKETRIDE_PLAT_UNX
#include <apLib/application/unx/signal.h>
#endif
#include <apLib/application/init.h>
#include <apLib/factory/Ptr.h>
#include <apLib/util/algorithm2.hpp>
#include <apLib/util/del.h>
#include <apLib/log/Color.hpp>
#include <apLib/log/toString.h>
#include <apLib/error/call.hpp>
#include <apLib/error/translate.hpp>
#include <apLib/async/Callback.hpp>
#include <apLib/async/RunCtx.hpp>
#include <apLib/async/ThreadCtx.hpp>
#include <apLib/async/ThreadApi.hpp>
#include <apLib/async/ThreadCtx.hpp>
#include <apLib/async/Thread.hpp>
#include <apLib/async/Queue.hpp>
#include <apLib/Uuid.hpp>
#include <apLib/match/Glob_Api.hpp>
#include <apLib/match/Glob.h>
#include <apLib/match/Group.hpp>
#include <apLib/match/types.h>
#include <apLib/match/api.h>
#include <apLib/log/toString.hpp>
#include <apLib/log/api.hpp>
#include <apLib/memory/Data.hpp>

#include <apLib/crypto/transform.hpp>
#include <apLib/crypto/hex.hpp>
#include <apLib/crypto/base64.h>
#include <apLib/crypto/random.hpp>
#include <apLib/crypto/crc.hpp>
#include <apLib/crypto/types.h>
#include <apLib/crypto/Cipher.hpp>
#include <apLib/crypto/api.h>
#include <apLib/crypto/Key.hpp>
#include <apLib/crypto/KeyApi.hpp>
#include <apLib/crypto/CipherCtx.h>
#include <apLib/crypto/EncryptCtx.h>
#include <apLib/crypto/DecryptCtx.h>

#include <apLib/compress/types.h>
#include <apLib/compress/api.hpp>
#include <apLib/compress/lz4.hpp>
#include <apLib/compress/uint32.hpp>
#include <apLib/compress/FastPFor.h>
#include <apLib/compress/FastPFor.hpp>

#include <apLib/string/api.hpp>
#include <apLib/util/typeName.hpp>
#include <apLib/Count.hpp>
#include <apLib/async/api.hpp>
#include <apLib/error/Error.hpp>
#include <apLib/dev/api.hpp>
#include <apLib/util/SharedFromThis.hpp>
#include <apLib/async/work/itemState.h>
#include <apLib/async/work/Executor.h>
#include <apLib/async/work/global.h>
#include <apLib/async/work/ItemCtx.hpp>
#include <apLib/async/work/Item.hpp>
#include <apLib/async/work/Group.hpp>
#include <apLib/async/work/api.hpp>

#include <apLib/file/snap/types.h>
#if ROCKETRIDE_PLAT_WIN
#include <apLib/file/snap/win/VssClient.h>
#include <apLib/time/win/zone.hpp>
#include <apLib/time/win/transform.hpp>
#elif ROCKETRIDE_PLAT_UNX
#include <apLib/time/unx/zone.hpp>
#if ROCKETRIDE_PLAT_LIN
#include <apLib/file/snap/lin/LvmClient.hpp>
#endif
#endif
#include <apLib/file/snap/Context.h>
#include <apLib/file/snap/api.h>

#include <apLib/xml/types.h>
#include <apLib/xml/api.hpp>

#include <apLib/Location.hpp>
#include <apLib/Size.hpp>
#include <apLib/CountSize.hpp>
#include <apLib/literals.hpp>
#include <apLib/memory/adapter/api.hpp>
#include <apLib/plat/pageSize.hpp>

#include <apLib/util/bitmask.hpp>
#include <apLib/util/numericCast.hpp>
#include <apLib/id.hpp>
#include <apLib/memory/PackHdr.hpp>
#include <apLib/memory/toData.hpp>
#include <apLib/memory/fromData.hpp>
#include <apLib/memory/pack.hpp>
#include <apLib/string/toData.hpp>
#include <apLib/string/StrPack.hpp>
#include <apLib/memory/Stats.hpp>
#include <apLib/factory/api.h>
#include <apLib/string/utf8/checked.h>
#include <apLib/string/utf8/unchecked.h>
#include <apLib/string/unicode/types.h>
#include <apLib/string/unicode/api.hpp>
#include <apLib/log/write.hpp>
#include <apLib/util/Throughput.hpp>
#include <apLib/async/ResultQueue.hpp>
#include <apLib/async/ThreadedQueue.hpp>
#include <apLib/async/ThreadedQueues.hpp>
#include <apLib/async/Buffers.hpp>
#include <apLib/string/icu/types.h>
#include <apLib/string/icu/TextSink.hpp>
#include <apLib/string/icu/api.hpp>
#include <apLib/string/icu/transform.hpp>
#include <apLib/string/icu/MultibyteCaseCollator.hpp>
#include <apLib/string/icu/MultibyteNoCaseCollator.hpp>
#include <apLib/string/CaseCollator.hpp>
#include <apLib/string/NoCaseCollator.hpp>
#include <apLib/string/icu/rules.h>
#include <apLib/string/icu/Normalizer.hpp>
#include <apLib/string/icu/BoundaryIterator.hpp>
#include <apLib/string/icu/iterTypes.h>
#include <apLib/factory/Factory.h>
#include <apLib/string/transform.hpp>
#include <apLib/memory/ViewAllocator.hpp>
#include <apLib/string/cast.hpp>

#include <apLib/string/urlEncode.hpp>

// Platform api declarations
#include <apLib/plat/DiskUsage.h>
#if ROCKETRIDE_PLAT_WIN
#include <apLib/plat/win/api.h>
#elif ROCKETRIDE_PLAT_LIN
#include <apLib/plat/lin/api.h>
#elif ROCKETRIDE_PLAT_MAC
#include <apLib/plat/mac/api.h>
#endif
#ifdef ROCKETRIDE_PLAT_UNX
#include <apLib/plat/unx/api.h>
#endif

// Stream api
#include <apLib/file/stream/Stream.hpp>
#include <apLib/file/stream/adapters.hpp>
#include <apLib/plat/DiskUsage.h>
#if ROCKETRIDE_PLAT_WIN
#include <apLib/file/stream/win/File.hpp>
#elif ROCKETRIDE_PLAT_UNX
#include <apLib/file/stream/unx/File.hpp>
#endif
#include <apLib/file/stream/types.h>
#include <apLib/memory/InputStreamBuf.hpp>

// Scanning api (file/vol)
#include <apLib/file/scan/Scanner.hpp>
#if ROCKETRIDE_PLAT_WIN
#include <apLib/file/scan/win/File.hpp>
#include <apLib/file/scan/win/Volume.hpp>
#include <apLib/file/scan/win/VolumeMountPoint.hpp>
#include <apLib/file/scan/win/DriveLetter.hpp>
#else
#include <apLib/file/scan/unx/File.hpp>
#if ROCKETRIDE_PLAT_LIN

#include <apLib/file/scan/lin/MountPoint.hpp>
#elif ROCKETRIDE_PLAT_MAC
#include <apLib/file/scan/mac/MountPoint.hpp>
#endif
#endif
#include <apLib/file/scan/types.h>

// SMB
#include <apLib/file/smb/Share.hpp>

#ifdef ROCKETRIDE_PLAT_WIN
#include <apLib/file/smb/win/api.hpp>
#else
#include <apLib/file/smb/unx/api.h>
#ifdef ROCKETRIDE_PLAT_LIN
#include <apLib/file/smb/lin/ClientApi.hpp>
#include <apLib/file/smb/lin/Client.hpp>
#else
#include <apLib/file/smb/mac/ClientApi.hpp>
#include <apLib/file/smb/mac/Client.hpp>
#endif
#include <apLib/file/smb/unx/api.hpp>
#include <apLib/file/scan/unx/SmbFile.hpp>
#include <apLib/file/stream/unx/SmbFile.hpp>
#endif

#if ROCKETRIDE_PLAT_WIN
#include <apLib/file/win/api.hpp>
#include <apLib/file/win/transform.hpp>
#else
#include <apLib/file/unx/api.hpp>
#include <apLib/file/unx/transform.hpp>
#include <apLib/file/unx/transform.h>

#endif

#include <apLib/entry.hpp>
#include <apLib/file/Selections.hpp>

// Include transformation, string conversions, we add these at the end to
// ensure adl lookup just works
#include <apLib/transform.hpp>
#include <apLib/string/packTypes.h>

#include <apLib/string/packSelector.h>
#include <apLib/string/packString.hpp>
#include <apLib/string/packNumber.hpp>
#include <apLib/string/packContainer.hpp>
#include <apLib/string/packUser.hpp>
#include <apLib/string/packMisc.hpp>
#include <apLib/string/packSelector.hpp>

#include <apLib/string/PackAdapter_In.hpp>

#include <apLib/string/packTraits.hpp>
#include <apLib/string/unpackNumber.hpp>
#include <apLib/string/unpackString.hpp>
#include <apLib/string/unpackUser.hpp>
#include <apLib/string/unpackMisc.hpp>

#include <apLib/string/formatApi.hpp>
#include <apLib/string/toString.hpp>
#include <apLib/string/fromString.hpp>
#include <apLib/json/toJson.hpp>
#include <apLib/json/toData.hpp>
#include <apLib/json/fromJson.hpp>
#include <apLib/json/jsonCpp_Ext.hpp>
#include <apLib/factory/Factory.hpp>
#include <apLib/factory/api.hpp>
#include <apLib/factory/Ptr.hpp>
#include <apLib/util/del.hpp>
#include <apLib/string/deductions.hpp>
#include <apLib/memory/deductions.hpp>
#include <apLib/util/ConfigFile.hpp>
#include <apLib/log/Options.hpp>
#include <apLib/async/Tls.hpp>
#include <apLib/json/parse.hpp>
#include <apLib/init.hpp>
#include <apLib/error/makeError.hpp>

#include <apLib/crypto/api.hpp>
#include <apLib/crypto/Keyring.hpp>
#include <apLib/crypto/overloads.hpp>
#include <apLib/crypto/Hash.hpp>
#include <apLib/crypto/base64.hpp>

#include <apLib/plat/CpuInfo.hpp>

#if ROCKETRIDE_PLAT_WIN
#include <apLib/plat/win/api.hpp>
#include <apLib/plat/win/privilege.hpp>
#include <apLib/plat/win/minidump.hpp>
#include <apLib/dev/win/api.hpp>
#include <apLib/plat/win/Usn.hpp>
#elif ROCKETRIDE_PLAT_LIN
#include <apLib/plat/lin/api.hpp>
#include <apLib/plat/lin/minidump_lifetime.h>
#elif ROCKETRIDE_PLAT_MAC
#include <apLib/plat/mac/api.hpp>

#endif

#ifdef ROCKETRIDE_PLAT_UNX
#include <apLib/dev/unx/api.hpp>
#include <apLib/plat/unx/api.hpp>
#endif

#include <apLib/file/api.hpp>
