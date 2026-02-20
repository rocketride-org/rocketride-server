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

// Include the Azure definitions

#include <cpprest/rawptrstream.h>
#include <cpprest/asyncrt_utils.h>
#ifdef dllimport
// cpprest SDK is leaking #define dllimport which causes issues with unicode
// platform.h on osx
#undef dllimport
#endif  // dllimport

// Compression support
#include <zlib.h>

// Minizip support
#include <minizip-ng/mz.h>
#include <minizip-ng/mz_os.h>
#include <minizip-ng/mz_strm.h>
#include <minizip-ng/mz_strm_mem.h>
#include <minizip-ng/mz_strm_os.h>
#ifndef ROCKETRIDE_PLAT_MAC
#include <minizip-ng/mz_strm_zlib.h>
#endif
#include <minizip-ng/mz_zip.h>
#include <minizip-ng/zip.h>

// Boost logging support, used in Azure SDK logging
#include <boost/log/core.hpp>
#include <boost/log/trivial.hpp>
#include <boost/log/expressions.hpp>
#include <boost/log/utility/setup/file.hpp>
#include <boost/log/utility/setup/common_attributes.hpp>

// Boost lambda -> output iterator utility class
#include <boost/iterator/function_output_iterator.hpp>

// Include the Azure definitions
#include <cpprest/rawptrstream.h>
#include <cpprest/asyncrt_utils.h>

#ifdef ROCKETRIDE_PLAT_WIN
// Include atlbase.h header
// AWS undefines Windows marco GetMessage (aws/core/client/AWSError.h).
// atlbase.h uses marco GetMessage. So, atlbase.h would fail if it was included
// after AWS headers.
// @see APPLAT-6668
#include <atlbase.h>
#endif

// Include the Aws/S3 definitions
// AWS defines JSON_USE_EXCEPTION in SDKConfig.h, and it conflicts with our
// definition Note that this has been fixed in upstream AWS:
// https://github.com/aws/aws-sdk-cpp/pull/1189
#pragma push_macro("JSON_USE_EXCEPTION")
#undef JSON_USE_EXCEPTION
#include <aws/core/Aws.h>
#include <aws/core/auth/AWSCredentialsProvider.h>
#include <aws/core/http/Scheme.h>
#include <aws/core/utils/memory/stl/AWSSet.h>
#include <aws/core/utils/logging/DefaultLogSystem.h>
#include <aws/core/utils/logging/AWSLogging.h>
#pragma pop_macro("JSON_USE_EXCEPTION")

#if ROCKETRIDE_PLAT_WIN
#include <Lm.h>
#else
#include <pwd.h>
#include <grp.h>
#endif

// ICU conversion
#include <unicode/ucnv.h>
#include <unicode/errorcode.h>

// JNI (Java)
#include <jni.h>

#include <signal.h>

// Python
#define WITH_THREAD
#include <Python.h>          // The python interpreter
#include <pybind11/embed.h>  // everything needed for embedding
#include <pybind11/pytypes.h>
#include <pybind11/numpy.h>
#include <pybind11/stl.h>

#if ROCKETRIDE_PLAT_WIN
#include <engLib/plat/win/headers.h>
#elif ROCKETRIDE_PLAT_UNX
#include <engLib/plat/unx/headers.h>
#ifdef ROCKETRIDE_PLAT_LIN
// #include <engLib/plat/lin/headers.h>
#elif ROCKETRIDE_PLAT_MAC
// #include <engLib/plat/mac/headers.h>
#endif
#endif

// Azure SDK
#include <azure/storage/blobs.hpp>
