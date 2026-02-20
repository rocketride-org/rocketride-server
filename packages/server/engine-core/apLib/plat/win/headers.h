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

// Standard headers
#include <WinSock2.h>
#include <WS2tcpip.h>
#include <windows.h>
#include <tchar.h>
#include <cstdlib>
#include <io.h>
#include <winioctl.h>
#include <conio.h>
#include <dbghelp.h>
#include <signal.h>
#include <winnetwk.h>

// VSS
#include <vss.h>
#include <vswriter.h>
#include <vsbackup.h>

// COM/ADSI/WMI
#include <comdef.h>
#include <atlbase.h>
#include <lm.h>
#include <adserr.h>
#include <Wbemidl.h>

// Windows Implementation Libraries
#include <wil\Resource.h>

// Shell
#include "shobjidl.h"
#include "shlguid.h"

// Boost
#include <boost/stacktrace.hpp>

// Shell COM interfaces
namespace ap::plat {
_COM_SMARTPTR_TYPEDEF(IShellLinkW, __uuidof(IShellLinkW));
using IShellLinkPtr = IShellLinkWPtr;
_COM_SMARTPTR_TYPEDEF(IPersistFile, __uuidof(IPersistFile));
}  // namespace ap::plat

// Undefine/rename symbols from Windows.h
#define kbhit _kbhit
#undef SetVolumeLabel
#undef SetFileAttributes
#undef DeleteFile
#undef CreateFile
#undef RELATIVE
#undef ABSOLUTE
#undef ERROR
#undef GetObject
#undef readLine
