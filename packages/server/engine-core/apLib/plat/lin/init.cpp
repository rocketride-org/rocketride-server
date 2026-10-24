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

#include <sys/prctl.h>

namespace ap::plat::lin {

namespace {

// Closes this process to the other processes of its user. Reading its
// /proc/<pid>/environ and memory, and ptrace, need its dumpable flag at 1, and
// the engine and the tasks of every caller can run as one user. So the flag
// goes to 0, unless RR_ENABLE_DEBUGGER_CONNECTION keeps a debugger's way in.
// It only keeps one: a 0 from the kernel (an execute-only binary) stays 0, or
// the variable would open what the kernel closed.
//
// A flag of 2 goes to 0 either way. The kernel gives 2 to an execute-only
// binary where fs.suid_dumpable is 2: no debugger of the user attaches to it,
// and Crashpad cannot dump it, since it lifts the flag for a dump only from 0.
//
// A process that should be closed and is not must not run: fatal.
void closeProcess() noexcept {
    // The variable asks with 1, true, yes or on, in any case. Anything else,
    // a typo included, does not
    auto debuggerWanted = []() noexcept {
        auto value = plat::env("RR_ENABLE_DEBUGGER_CONNECTION");
        value.trim();
        for (auto yes : {"1"_tv, "true"_tv, "yes"_tv, "on"_tv}) {
            if (value.equalsNoCase(yes))
                return true;
        }
        return false;
    };

    // Kept as the kernel gave it only when that is 0 or 1: a failed query (-1)
    // is no state to keep, and goes on to be closed and checked
    const int flag = ::prctl(PR_GET_DUMPABLE);
    if ((flag == 0 || flag == 1) && debuggerWanted())
        return;

    if (::prctl(PR_SET_DUMPABLE, 0) != 0 || ::prctl(PR_GET_DUMPABLE) != 0)
        dev::fatality(_location, "Could not clear the process's dumpable flag");
}

}  // namespace

void init() noexcept {
    // Before Crashpad, which finds the flag as it is when a crash comes
    closeProcess();

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
