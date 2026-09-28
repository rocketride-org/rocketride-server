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

// Include from exactly one cpp: keeps crashpad/mini_chromium headers out of the
// rest of the codebase.
#ifndef AP_PLAT_MINIDUMP_CPP_PRIVATE_INCLUDE
#error Must only be included from another cpp
#endif

#undef AP_PLAT_MINIDUMP_CPP_PRIVATE_INCLUDE

#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <sys/stat.h>
#include <unistd.h>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#if ROCKETRIDE_PLAT_MAC
#include <mach/mach.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#include <atomic>
#endif

// mini_chromium's base defines a stream-style LOG macro; shield the engine's.
#pragma push_macro("LOG")
#undef LOG
#include <base/files/file_path.h>
#include <client/crash_report_database.h>
#include <client/crashpad_client.h>
#include <client/settings.h>
#if ROCKETRIDE_PLAT_MAC
#include <client/simulate_crash_mac.h>
#endif
#pragma pop_macro("LOG")

namespace ap::plat {

namespace internal {

inline base::FilePath toFilePath(const file::Path &path) noexcept {
    return base::FilePath{std::string{_ts(path).c_str()}};
}

// Create `dir` 0700 and confirm it is really ours. Linux temp is world-writable,
// so a predictable name lets any local user pre-create the directory -- or leave
// a symlink there -- and quietly divert minidumps, which carry process memory.
// lstat, not stat, is what rejects the symlink.
inline bool ensurePrivateDir(const std::filesystem::path &dir) noexcept {
    if (::mkdir(dir.c_str(), 0700) != 0 && errno != EEXIST) return false;

    struct ::stat st {};
    if (::lstat(dir.c_str(), &st) != 0) return false;

    return S_ISDIR(st.st_mode) && st.st_uid == ::geteuid()
           && (st.st_mode & (S_IRWXG | S_IRWXO)) == 0;
}

inline std::filesystem::path computeCrashDbDir() noexcept {
    std::filesystem::path dir;

    if (auto env = plat::env("ROCKETRIDE_CRASHDB_DIR")) {
        dir = std::filesystem::path{_ts(_cast<file::Path>(env)).c_str()};
    } else {
        std::error_code ec;
        auto base = std::filesystem::temp_directory_path(ec);
        if (ec) {
            LOG(Error, "No usable temp dir; crash reporting disabled",
                ec.message());
            return {};
        }

        // Scoped by uid so another user cannot pre-empt or read the database,
        // and by the executable so two installs on one box stay apart. Never by
        // pid: the next startup has to find the previous run's dumps.
        //
        // Read /proc/self/exe rather than application::execPath(): we run from
        // plat::init(), and bootstrap only resolves the real exec path *after*
        // that, so execPath() would still be argv[0] -- which varies with how
        // the engine was launched and would send each run to a different
        // database. Empty on macOS (no /proc), whose temp is per-user anyway.
        std::error_code exeEc;
        auto exe =
            std::filesystem::read_symlink("/proc/self/exe", exeEc).string();
        auto tag = crypto::crc32({_reCast<const uint8_t *>(exe.data()),
                                  exe.size() * sizeof(exe.data()[0])});

        char suffix[48];
        std::snprintf(suffix, sizeof suffix, "rocketride-crashdb-%u-%08x",
                      static_cast<unsigned>(::geteuid()),
                      static_cast<unsigned>(tag));
        dir = base / suffix;
    }

    std::error_code ec;
    std::filesystem::create_directories(dir.parent_path(), ec);

    if (!ensurePrivateDir(dir)) {
        LOG(Error,
            "Crash DB dir is not private (wrong owner, wrong mode, or a "
            "symlink); crash reporting disabled",
            dir.string());
        return {};
    }
    return dir;
}

// Stable, writable Crashpad database (settings.dat / pending / completed). Kept
// separate from crashDumpLocation(), which is re-pointed per task and may sit in
// a read-only install dir; temp is writable in every deployment. Resolved once
// so the ownership check, and its error log, happen a single time per process.
inline const std::filesystem::path &crashDbDir() noexcept {
    static const std::filesystem::path dir = computeCrashDbDir();
    return dir;
}

// The process a dump was taken from, from its MiscInfo stream. Concurrent
// engines share the DB, so this is how a dump is attributed; the start time
// tells a recycled pid apart from the process that crashed.
struct DumpOwner {
    pid_t pid{};             // 0 if unknown
    int64_t startTime{-1};   // epoch seconds, -1 if unknown
};

inline DumpOwner dumpOwner(const std::filesystem::path &dmp) noexcept {
    std::ifstream in{dmp, std::ios::binary};
    auto read = [&](auto &out, uint64_t rva) {
        return static_cast<bool>(
            in.seekg(rva).read(reinterpret_cast<char *>(&out), sizeof(out)));
    };

    struct {
        uint32_t signature, version, streamCount, streamDirRva;
    } header{};
    if (!read(header, 0) || header.signature != 0x504d444d /* "MDMP" */)
        return {};

    for (uint32_t i = 0; i < header.streamCount; ++i) {
        struct {
            uint32_t type, dataSize, rva;
        } entry{};
        if (!read(entry, header.streamDirRva + uint64_t{i} * sizeof(entry)))
            return {};
        if (entry.type != 15 /* MiscInfoStream */) continue;

        struct {
            uint32_t size, flags, processId, processCreateTime;
        } misc{};
        if (!read(misc, entry.rva) || !(misc.flags & 1 /* MISC1_PROCESS_ID */))
            return {};

        DumpOwner owner{static_cast<pid_t>(misc.processId)};
        if (misc.flags & 2 /* MISC1_PROCESS_TIMES */)
            owner.startTime = misc.processCreateTime;
        return owner;
    }
    return {};
}

// Start time (epoch seconds) of a running process, computed as Crashpad does
// for the dump; -1 if it is gone or a zombie (exited, not yet reaped).
inline int64_t processStartTime(pid_t pid) noexcept {
#if ROCKETRIDE_PLAT_LIN
    char path[32];
    std::snprintf(path, sizeof path, "/proc/%d/stat", static_cast<int>(pid));
    std::ifstream in{path};
    std::string stat;
    if (!std::getline(in, stat)) return -1;

    // Fields follow "(comm)", and comm may itself hold spaces or parens.
    auto close = stat.rfind(')');
    if (close == std::string::npos) return -1;
    std::istringstream fields{stat.substr(close + 1)};

    char state{};
    fields >> state;  // field 3
    if (state == 'Z' || state == 'X') return -1;

    std::string skip;
    for (int i = 4; i < 22; ++i) fields >> skip;
    uint64_t ticks{};
    if (!(fields >> ticks)) return -1;  // field 22: starttime, since boot

    timespec now{}, uptime{};
    ::clock_gettime(CLOCK_REALTIME, &now);
    ::clock_gettime(CLOCK_BOOTTIME, &uptime);
    const int64_t hz = ::sysconf(_SC_CLK_TCK);
    const int64_t bootNs = (now.tv_sec - uptime.tv_sec) * 1'000'000'000LL
                           + (now.tv_nsec - uptime.tv_nsec);
    const int64_t startNs = bootNs + int64_t(ticks / hz) * 1'000'000'000LL
                            + int64_t(ticks % hz) * 1'000'000'000LL / hz;
    return startNs / 1'000'000'000LL;
#elif ROCKETRIDE_PLAT_MAC
    int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
    kinfo_proc info{};
    size_t size = sizeof info;
    if (::sysctl(mib, 4, &info, &size, nullptr, 0) != 0 || size == 0)
        return -1;
    if (info.kp_proc.p_stat == SZOMB) return -1;
    return info.kp_proc.p_starttime.tv_sec;
#else
    return -1;
#endif
}

// Is the dump's process still running? A pid match alone is not enough: the
// pid may since have been recycled by an unrelated process.
inline bool ownerRunning(const DumpOwner &owner) noexcept {
    if (!owner.pid) return false;

    auto started = processStartTime(owner.pid);
    if (started < 0) return false;
    if (owner.startTime < 0) return true;  // no time in the dump: trust the pid

    // Both sides truncate to seconds from separately sampled clocks.
    return std::abs(started - owner.startTime) <= 2;
}

// Move a dump out of the DB into crashDumpLocation() with the app's canonical
// name, then notify. rename() with copy+remove fallback for cross-filesystem.
inline void relocateAndNotify(const std::filesystem::path &src) noexcept {
    auto target = dev::createCrashDumpPath("dmp"_tv);
    std::filesystem::path targetFs{_ts(target).c_str()};

    std::error_code ec;
    std::filesystem::rename(src, targetFs, ec);
    if (ec) {
        // Another engine's sweep got here first and is reporting it.
        if (!std::filesystem::exists(src, ec)) return;

        ec.clear();
        std::filesystem::copy_file(
            src, targetFs, std::filesystem::copy_options::overwrite_existing,
            ec);
        if (ec) {
            LOG(Error, "Failed to relocate minidump", src.string(),
                ec.message());
            return;
        }
        std::filesystem::remove(src, ec);
    }

    LOG(Error, "Minidump recovered:", target);
    if (dev::crashDumpCreatedCallback()) dev::crashDumpCreatedCallback()(target);
}

// Relocate dumps out of the DB. With ownOnly, just this process's dump (the
// crash-time path); otherwise every dump whose process is gone (the per-task
// path), leaving a running sibling's dump for its own crash handler to report.
// Returns how many dumps it took.
inline size_t sweepDumps(const std::filesystem::path &dbDir,
                         bool ownOnly = false) noexcept {
    size_t taken{};
    if (dbDir.empty()) return taken;  // crash reporting is off

    for (const char *sub : {"pending", "completed"}) {
        auto dir = dbDir / sub;
        std::error_code ec;
        if (!std::filesystem::exists(dir, ec)) continue;

        std::filesystem::directory_iterator it{dir, ec}, end;
        for (; !ec && it != end; it.increment(ec)) {
            const auto &p = it->path();
            if (p.extension() != ".dmp") continue;

            // Own: this very process (pid and start time), i.e. the crash
            // being reported. Otherwise leave a running owner's dump to it.
            auto owner = dumpOwner(p);
            bool running = ownerRunning(owner);
            bool own = running && owner.pid == ::getpid();
            if (ownOnly ? !own : running && !own) continue;
            relocateAndNotify(p);
            ++taken;
        }
    }
    return taken;
}

// Crash-time reporting, so crashDumpCreatedCallback reaches the caller before
// the process dies (as Breakpad's in-process callback did) instead of on the
// next run. It runs from a signal handler once the dump is written: Crashpad's
// last-chance handler on Linux, our own handler on macOS. Neither may do the
// sweep itself: it is not async-signal-safe, and on Linux the handler runs on
// Crashpad's ~SIGSTKSZ alternate stack, which the sweep overflows. So the
// handler only wakes this thread over a pipe and waits for it, bounded in case
// the sweep deadlocks on a lock the crashed thread held.
inline int g_reportRequest[2]{-1, -1};
inline int g_reportDone[2]{-1, -1};

inline bool makePipe(int (&fds)[2]) noexcept {
    if (::pipe(fds)) return false;
    ::fcntl(fds[0], F_SETFD, FD_CLOEXEC);
    ::fcntl(fds[1], F_SETFD, FD_CLOEXEC);
    return true;
}

inline void startCrashReporter() noexcept {
    if (!makePipe(g_reportRequest) || !makePipe(g_reportDone)) return;

    std::thread{[] {
#if ROCKETRIDE_PLAT_MAC
        ::pthread_setname_np("Crash Reporter");
#else
        ::pthread_setname_np(::pthread_self(), "Crash Reporter");
#endif

        char c;
        ssize_t n;
        while ((n = ::read(g_reportRequest[0], &c, 1)) < 0 && errno == EINTR) {
        }
        if (n != 1) return;

        c = sweepDumps(crashDbDir(), /*ownOnly=*/true) ? 1 : 0;
        [[maybe_unused]] auto _ = ::write(g_reportDone[1], &c, 1);
    }}.detach();
}

// Async-signal-safe: only write(), poll() and read(). True if the reporter
// found and reported this process's dump.
inline bool reportOwnDump() noexcept {
    char c{};
    if (g_reportDone[0] < 0 || ::write(g_reportRequest[1], &c, 1) != 1)
        return false;

    pollfd done{g_reportDone[0], POLLIN, 0};
    int ready;
    while ((ready = ::poll(&done, 1, 10'000)) < 0 && errno == EINTR) {
    }
    return ready == 1 && ::read(g_reportDone[0], &c, 1) == 1 && c == 1;
}

#if ROCKETRIDE_PLAT_LIN
// Crashpad's last-chance handler: runs once the handler has written the dump.
inline bool onCrashDumped(int, siginfo_t *, ucontext_t *) noexcept {
    reportOwnDump();
    return false;  // chain on to the engine's own signal handler
}
#endif

#if ROCKETRIDE_PLAT_MAC
// Crashpad on macOS dumps on EXC_CRASH, which the kernel raises only once the
// process is dying, so nothing in-process can report it. Instead a fatal signal
// (delivered before EXC_CRASH, while we are alive) has Crashpad dump now via
// SimulateCrash(), which returns once the dump is written. The dump records
// Crashpad's simulated exception, but the faulting thread's real registers.
// Crashes that raise no signal (EXC_GUARD, a resource kill) still dump on
// EXC_CRASH and are reported by the next task run's sweep.
inline constexpr int FatalSignals[] = {SIGABRT, SIGBUS, SIGFPE, SIGILL,
                                       SIGSEGV, SIGSYS, SIGTRAP};
inline struct sigaction g_prevActions[NSIG]{};
inline std::atomic_flag g_crashHandled = ATOMIC_FLAG_INIT;

inline void onFatalSignal(int sig, siginfo_t *info, void *context) noexcept {
    if (!g_crashHandled.test_and_set()) {
        crashpad::NativeCPUContext cpu{};
        auto *uc = static_cast<ucontext_t *>(context);
        if (uc && uc->uc_mcontext) {
#if defined(__x86_64__)
            cpu.tsh.flavor = x86_THREAD_STATE64;
            cpu.tsh.count = x86_THREAD_STATE64_COUNT;
            cpu.uts.ts64 = uc->uc_mcontext->__ss;
#elif defined(__aarch64__)
            cpu.ash.flavor = ARM_THREAD_STATE64;
            cpu.ash.count = ARM_THREAD_STATE64_COUNT;
            cpu.ts_64 = uc->uc_mcontext->__ss;
#endif
        } else {
            crashpad::CaptureContext(&cpu);
        }
        crashpad::SimulateCrash(cpu);

        // Reported: stop Crashpad writing a second dump on EXC_CRASH. If not,
        // keep it as the fallback for the next task run's sweep.
        if (reportOwnDump())
            ::task_set_exception_ports(::mach_task_self(), EXC_MASK_CRASH,
                                       MACH_PORT_NULL, EXCEPTION_DEFAULT,
                                       THREAD_STATE_NONE);
    }

    // Chain to the handler we displaced (normally the engine's). A hardware
    // fault re-raises itself on return; a sent signal (kill, abort) does not.
    ::sigaction(sig, &g_prevActions[sig], nullptr);
    bool fault = info && info->si_code > 0 && info->si_code < SI_USER;
    if (!fault) ::raise(sig);
}

inline void installFatalSignalHandlers() noexcept {
    struct sigaction action {};
    action.sa_sigaction = onFatalSignal;
    action.sa_flags = SA_SIGINFO | SA_ONSTACK;
    sigemptyset(&action.sa_mask);
    for (int sig : FatalSignals) ::sigaction(sig, &action, &g_prevActions[sig]);
}
#endif

}  // namespace internal

// Owns the Crashpad client for the process lifetime. Construction starts the
// out-of-process handler; there is no clean stop API.
class Minidump {
public:
    Minidump() noexcept {
        // Handler ships next to the engine binary in dist/server; an env var
        // overrides for relocated installs / CI.
        file::Path handlerPath;
        if (auto env = plat::env("ROCKETRIDE_CRASHPAD_HANDLER"))
            handlerPath = _cast<file::Path>(env);
        else
            handlerPath = application::execDir() / "crashpad_handler";

        if (!file::exists(handlerPath)) {
            LOG(Error, "crashpad_handler not found; crash reporting disabled",
                handlerPath);
            return;
        }

        const auto &dbDir = internal::crashDbDir();
        if (dbDir.empty()) return;  // computeCrashDbDir() logged the reason

        auto database = crashpad::CrashReportDatabase::Initialize(
            base::FilePath{std::string{dbDir.string()}});
        if (!database)
            // StartHandler below still reports success, so without this the
            // failure is indistinguishable from a healthy start.
            LOG(Error, "Crashpad database unusable; dumps will not be recorded",
                dbDir.string());
        else if (database->GetSettings())
            database->GetSettings()->SetUploadsEnabled(false);

        // Static process context; per-task id is applied to the recovered dump
        // name at sweep time.
        auto str = [](auto &&v) { return std::string{_ts(v).c_str()}; };
        std::map<std::string, std::string> annotations;
        annotations["exe"] = str(application::execPath().fileName(true));
        if (auto version = application::projectVersion())
            annotations["version"] = str(version);
        if (auto hash = application::buildHash()) annotations["build"] = str(hash);
        annotations["host"] = str(plat::hostName());

        // More memory: Crashpad has no full-memory flag; nominate ranges via
        // CrashpadInfo::set_extra_memory_ranges() (gated on Heap/IsDebug like
        // plat/win/minidump.hpp) when a buffer worth capturing exists.

        bool ok = m_client.StartHandler(
            internal::toFilePath(handlerPath),
            base::FilePath{std::string{dbDir.string()}},
            /*metrics_dir=*/base::FilePath{},
            /*url=*/std::string{}, annotations,
            /*arguments=*/std::vector<std::string>{},
            /*restartable=*/true,
            /*asynchronous_start=*/false);

        if (!ok) {
            LOG(Error, "Failed to start Crashpad handler", handlerPath);
            return;
        }

        internal::startCrashReporter();
#if ROCKETRIDE_PLAT_LIN
        crashpad::CrashpadClient::SetLastChanceExceptionHandler(
            internal::onCrashDumped);
#elif ROCKETRIDE_PLAT_MAC
        internal::installFatalSignalHandlers();
#endif
        LOG(Dev, "Crashpad handler started", handlerPath);
    }

    ~Minidump() noexcept = default;

private:
    crashpad::CrashpadClient m_client;
};

}  // namespace ap::plat
