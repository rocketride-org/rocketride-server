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
//	Older libc abi fix
//
#include <apLib/ap.h>

extern "C" {

typedef void (*dtor_func)(void *);

// This function defines a weak symbol which will be bound if the
// libc on the target system does not contain a 2.18 GLIBC export
// for it. We define it as weak so on newer libc's it gets out of the way.
// This function is what gets called when a thread exits, and there
// are thread local storage items which need to be destructed. For
// our engine app its not critical that we really destruct things
// when threads exit as it is typical for the engine to fully exit
// when that occurs (it just lives long enough to run some commands etc.).
[[gnu::weak]] int __cxa_thread_atexit_impl(dtor_func func, void *obj,
                                           void *dso_symbol) {
    return 0;
}

// This is another problematic function which has an easy implementation
// this was introduced in glibc-2.2 or somewhere abouts:
// https://lwn.net/Articles/711013/
ssize_t getrandom(void *buffer, size_t length, unsigned int flags) {
    return syscall(SYS_getrandom, buffer, length, flags);
}
}
