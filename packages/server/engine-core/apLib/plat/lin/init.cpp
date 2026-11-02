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

#include <apLib/ap.h>

namespace ap::plat::lin {

void init() noexcept {
    // Crashpad starts once, as early as possible, so a fault during startup is
    // still caught. Recovering the previous run's dumps is plat::minidumpSweep(),
    // called once the monitor and the per-task location exist -- no re-register
    // on location change (unlike Breakpad).
    minidumpRegister();

    // Claim the system libstdc++ before anything else can. Its locale facet ids
    // (std::num_put<char>::id and the other 159) are STB_GNU_UNIQUE, which glibc
    // binds process-wide to the first definer, RTLD_LOCAL or not. The engine runs
    // on libc++, so nothing claims them until a JNI library with a statically
    // linked libstdc++ of its own arrives -- Tika's prebuilt lib7-Zip-JBinding.so
    // exports 398 such symbols -- and then that copy's numbering wins. The system
    // runtime's facet table is left renumbered, and the next GCC-built code to
    // format a number through std::ostream (torch, on import) reaches a facet
    // that is not there and faults at 0x20.
    //
    // Fails open: a host without libstdc++.so.6 cannot load GCC-built code either,
    // so there is nothing to protect.
    if (!::dlopen("libstdc++.so.6", RTLD_NOW | RTLD_GLOBAL))
        LOG(Init, "libstdc++.so.6 not preloaded:", ::dlerror());
}

void deinit() noexcept { minidumpDeregister(); }

}  // namespace ap::plat::lin
