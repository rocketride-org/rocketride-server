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
#include <sys/statvfs.h>
#include "api.h"
namespace ap::plat {

inline Text hostName() noexcept {
    Array<char, 256> name = {};
    ASSERTD(!::gethostname(&name.front(), name.size()));
    return Text{&name.front()};
}

inline uint32_t cpuCount() noexcept {
    // Retrieve the number of online processors using sysconf
#if ROCKETRIDE_PLAT_MAC
    return macCPUCount();
#else
    long nCPUCores = sysconf(_SC_NPROCESSORS_ONLN);
    if (nCPUCores <= 0) {
        // If the query fails, return 0 as a fallback
        return 0;
    }
    return static_cast<uint32_t>(nCPUCores);
#endif
}

inline uint32_t gpuSize() noexcept {
#if ROCKETRIDE_PLAT_MAC
    return macGPUSize();
#else
    const char* cmd =
        "nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits";
    FILE* pipe = popen(cmd, "r");
    if (!pipe) {
        return 0;  // nvidia-smi unavailable or no GPU detected
    }

    char buffer[128];
    uint32_t gpuMemoryMB = 0;

    // Read the command output
    if (fgets(buffer, sizeof(buffer), pipe)) {
        try {
            // Convert buffer content (string) to uint32_t
            gpuMemoryMB = std::stoi(buffer);
        } catch (const std::exception& e) {
            std::cerr << "Error parsing GPU memory: " << e.what() << std::endl;
            gpuMemoryMB = 0;  // Fallback to 0 if parsing fails
        }
    } else {
        std::cerr << "Error reading output from nvidia-smi." << std::endl;
    }

    pclose(pipe);

    return gpuMemoryMB;
#endif
}

inline ErrorOr<int> systemDiskUtilization() noexcept {
    return APERR(Ec::NotSupported);
}

inline ErrorOr<DiskUsage> diskUsage(const file::Path& path) noexcept {
    struct statvfs fsInfo;
    if (statvfs(path.plat(), &fsInfo))
        return APERR(errno, "statvfs failed", path);

    // Verify it is a valid mount point that has a size
    if (fsInfo.f_blocks == 0 || fsInfo.f_frsize == 0)
        return APERR(Ec::InvalidParam,
                     "Disk is either not a valid mount point or has no size",
                     path);

    // Total size is f_blocks (size of fs in f_frsize units) * f_frsize;
    // (fragment size) Free size is f_bsize (file system block size) * f_bavail
    // (Number of free blocks for unprivileged users)
    auto spaceTotal = Size(fsInfo.f_blocks) * Size(fsInfo.f_frsize);
    auto spaceFree = Size(fsInfo.f_bavail) * Size(fsInfo.f_frsize);
    if (!spaceTotal)
        return APERR(Ec::Unexpected, "Unable to calculate total disk space",
                     path);

    return DiskUsage{spaceTotal, spaceFree};
}

template <typename MethodT>
inline ErrorOr<MethodT*> dynamicBind(const file::Path& libPath,
                                     const char* methodName,
                                     bool changeDir) noexcept {
    if (changeDir) {
        if (::chdir(libPath.parent().plat()))
            return APERR(errno, "Failed to change dir", libPath);
    }

    auto hLib = ::dlopen(libPath.plat(), RTLD_LAZY);
    if (!hLib) return APERR(Ec::Read, "Failed to load", libPath, ::dlerror());

    auto method = _reCast<MethodT*>(::dlsym(hLib, methodName));
    if (!method)
        return APERR(Ec::Read, "Failed to bind method", libPath, methodName,
                     ::dlerror());

    return method;
}

// Checks if this platform is running on wsl v1 (windows subsystem for linux)
inline bool isWsl1() noexcept(false) {
#if ROCKETRIDE_PLAT_LIN
    // WSL1 - Microsoft, WSL2 - microsoft
    static auto wslFlag =
        file::fetchString("/proc/version")->contains("Microsoft");
    return wslFlag;
#else
    return false;
#endif
}

inline ErrorOr<timespec> getFileAccessTime(int fd) noexcept {
    struct ::stat info;
    if (::fstat(fd, &info)) return APERR(errno, "fstat");
#if ROCKETRIDE_PLAT_MAC
    return info.st_atimespec;
#else
    return info.st_atim;
#endif
}

inline Error setFileAccessTime(int fd, const timespec& atime) noexcept {
    const timespec times[2] = {atime, {0, UTIME_OMIT}};
    if (::futimens(fd, times)) return APERR(errno, "futimens");
    return {};
}

inline Error setFileAccessAndModificationTimes(const file::Path& path,
                                               const timeval& atime,
                                               const timeval& mtime) noexcept {
    const timeval times[2] = {
        atime,
        mtime,
    };
    if (::utimes(path.plat(), times)) return APERR(errno, "utimes");
    return {};
}

inline ErrorOr<timespec> getFileAccessTime(const file::Path& path) noexcept {
    struct ::stat info;
    if (::stat(path.plat(), &info)) return APERR(errno, "stat", path);
#if ROCKETRIDE_PLAT_MAC
    return info.st_atimespec;
#else
    return info.st_atim;
#endif
}

inline Error setFileAccessTime(const file::Path& path,
                               const timespec& atime) noexcept {
    const timespec times[2] = {atime, {0, UTIME_OMIT}};
    if (::utimensat(-1, path.plat(), times, 0))
        return APERR(errno, "utimensat");
    return {};
}

inline TextView renderSignal(int signal) noexcept {
    switch (signal) {
        // ISO C99 signals
        case SIGINT:
            return "SIGINT";
        case SIGILL:
            return "SIGILL";
        case SIGABRT:
            return "SIGABRT";
        case SIGFPE:
            return "SIGFPE";
        case SIGSEGV:
            return "SIGSEGV";
        case SIGTERM:
            return "SIGTERM";

        // Historical signals specified by POSIX
        case SIGHUP:
            return "SIGHUP";
        case SIGQUIT:
            return "SIGQUIT";
        case SIGTRAP:
            return "SIGTRAP";
        case SIGKILL:
            return "SIGKILL";
        case SIGBUS:
            return "SIGBUS";
        case SIGSYS:
            return "SIGSYS";
        case SIGPIPE:
            return "SIGPIPE";
        case SIGALRM:
            return "SIGALRM";

        // New(er) POSIX signals (1003.1-2008, 1003.1-2013)
        case SIGURG:
            return "SIGURG";
        case SIGSTOP:
            return "SIGSTOP";
        case SIGTSTP:
            return "SIGTSTP";
        case SIGCONT:
            return "SIGCONT";
        case SIGCHLD:
            return "SIGCHLD";
        case SIGTTIN:
            return "SIGTTIN";
        case SIGTTOU:
            return "SIGTTOU";
        case SIGXCPU:
            return "SIGXCPU";
        case SIGXFSZ:
            return "SIGXFSZ";
        case SIGVTALRM:
            return "SIGVTALRM";
        case SIGPROF:
            return "SIGPROF";
        case SIGUSR1:
            return "SIGUSR1";
        case SIGUSR2:
            return "SIGUSR2";

        default:
            return {};
    }
}

inline TextView renderSignalDescription(int signal) noexcept {
    switch (signal) {
        // ISO C99 signals
        case SIGINT:
            return "Interactive attention signal";
        case SIGILL:
            return "Illegal instruction";
        case SIGABRT:
            return "Abnormal termination";
        case SIGFPE:
            return "Erroneous arithmetic operation";
        case SIGSEGV:
            return "Invalid access to storage";
        case SIGTERM:
            return "Termination request";

        // Historical signals specified by POSIX
        case SIGHUP:
            return "Hangup";
        case SIGQUIT:
            return "Quit";
        case SIGTRAP:
            return "Trace/breakpoint trap";
        case SIGKILL:
            return "Killed";
        case SIGBUS:
            return "Bus error";
        case SIGSYS:
            return "Bad system call";
        case SIGPIPE:
            return "Broken pipe";
        case SIGALRM:
            return "Alarm clock";

        // New(er) POSIX signals (1003.1-2008, 1003.1-2013)
        case SIGURG:
            return "Urgent data is available at a socket";
        case SIGSTOP:
            return "Stop, unblockable";
        case SIGTSTP:
            return "Keyboard stop";
        case SIGCONT:
            return "Continue";
        case SIGCHLD:
            return "Child terminated or stopped";
        case SIGTTIN:
            return "Background read from control terminal";
        case SIGTTOU:
            return "Background write to control terminal";
        case SIGXCPU:
            return "CPU time limit exceeded";
        case SIGXFSZ:
            return "File size limit exceeded";
        case SIGVTALRM:
            return "Virtual timer expired";
        case SIGPROF:
            return "Profiling timer expired";
        case SIGUSR1:
            return "User-defined signal 1";
        case SIGUSR2:
            return "User-defined signal 2";

        default:
            return {};
    }
}

// Render the versionless soname of a given library
inline Text renderSoname(TextView libName) noexcept {
    // e.g. libsmbclient.so or libsmbclient.dylib
    return _fmt("{}.{}", libName, LibraryExtension);
}

inline ErrorOr<std::vector<Processor>> getProcessors() noexcept {
    // The cpuinfo file can be quite long on systems with many processors; fetch
    // up to 1 MB
    auto cpuinfo = file::fetchStringEx("/proc/cpuinfo", 1_mb);
    if (!cpuinfo) return cpuinfo.ccode();

    auto toBool = [](auto& text) { return text == "yes"; };

    std::vector<Processor> res;
    Opt<Processor> current;
    for (auto& line : cpuinfo->split('\n', true)) {
        // If we found an empty line, end the current processor
        if (!line) {
            if (current) {
                res.emplace_back(_mv(*current));
                current.reset();
            }
            continue;
        }

        Pair<TextView, TextView> comps = line.slice(':');
        auto name = comps.first.trim<Text>();
        if (!name)
            return APERR(Ec::InvalidSyntax,
                         "Unable to parse /proc/cpuinfo line", line);

        auto value = comps.second.trim<Text>();
        // Ignore empty values
        if (!value) continue;

        // Initialize the new processor if needed
        if (!current) current = Processor{};

        // Parse value
        if (name == "processor")
            current->id = _fs<uint32_t>(value);
        else if (name == "vendor_id")
            current->vendor = _mv(value);
        else if (name == "cpu family")
            current->family = _fs<uint32_t>(value);
        else if (name == "model")
            current->model = _fs<uint32_t>(value);
        else if (name == "model name")
            current->modeName = value;
        else if (name == "stepping")
            current->stepping = _fs<uint32_t>(value);
        else if (name == "microcode")
            current->microcode = _fsh<uint32_t>(value);
        else if (name == "cpu MHz")
            current->mhz = _fs<double>(value);
        else if (name == "cache size")
            current->cacheSize = _fs<Size>(value);
        else if (name == "physical id")
            current->physicalId = _fs<uint32_t>(value);
        else if (name == "siblings")
            current->siblings = _fs<uint32_t>(value);
        else if (name == "core id")
            current->coreId = _fs<uint32_t>(value);
        else if (name == "cpu cores")
            current->cores = _fs<uint32_t>(value);
        else if (name == "apicid")
            current->apicId = _fs<uint32_t>(value);
        else if (name == "initial apicid")
            current->initialApicId = _fs<uint32_t>(value);
        else if (name == "fpu")
            current->fpu = toBool(value);
        else if (name == "fpu_exception")
            current->fpuException = toBool(value);
        else if (name == "cpuid level")
            current->cpuidLevel = _fs<uint32_t>(value);
        else if (name == "wp")
            current->wp = toBool(value);
        else if (name == "flags")
            current->flags = value.split(' ');
        else if (name == "bugs")
            current->bugs = value.split(' ');
        else if (name == "bogomips")
            current->bogoMips = _fs<double>(value);
        else if (name == "TLB size")
            current->tlbSize = value;
        else if (name == "clflush size")
            current->clFlushSize = _fs<uint32_t>(value);
        else if (name == "cache_alignment")
            current->cacheAlignment = _fs<uint32_t>(value);
        else if (name == "power management")
            current->powerManagement = value.split(' ');
        else
            current->additionalInfo.emplace(_mv(name), _mv(value));
    }

    // Add the final processor
    if (current) res.emplace_back(_mv(*current));

    // Make sure we got at least one
    if (res.empty())
        return APERR(Ec::InvalidSyntax, "Unable to parse /proc/cpuinfo");

    return res;
}

}  // namespace ap::plat
