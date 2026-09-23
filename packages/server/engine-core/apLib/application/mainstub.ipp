// =============================================================================
// MIT License
//
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

namespace ap::application {

// When using the mainstub, you declare your main entry as follows,
// with the main ipp file included once in the translation unit declaring
// the Main api. It is ok to throw here as the main stub will handle
// that translation automatically. Access to commandline is available
// via the global application api.
// @returns
// The integer number to return back to main
extern ErrorCode Main();

}  // namespace ap::application

#if ROCKETRIDE_PLAT_WIN
#include <apLib/application/win/winmain.ipp>
#elif ROCKETRIDE_PLAT_LIN
#include <apLib/application/lin/linmain.ipp>
#elif ROCKETRIDE_PLAT_MAC
#include <apLib/application/mac/macmain.ipp>
#endif
