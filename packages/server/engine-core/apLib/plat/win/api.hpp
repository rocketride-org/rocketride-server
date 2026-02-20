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
#pragma comment(lib, "wbemuuid.lib")

namespace ap::plat {

inline Text hostName() noexcept {
    Array<WCHAR, MAX_COMPUTERNAME_LENGTH + 1> name;

    auto size = _cast<DWORD>(name.size());
    ASSERTD(::GetComputerNameW(&name.front(), &size));

    return Text{&name.front()};
}

inline uint32_t cpuCount() noexcept {
    return systemInfo().dwNumberOfProcessors;
}

inline uint32_t gpuSize() noexcept {
    uint32_t gpuMemoryMB = 0;

    // Initialize COM library
    if (FAILED(::CoInitializeEx(nullptr, COINIT_MULTITHREADED))) {
        return 0;  // COM initialization failed
    }

    CComPtr<IWbemLocator> wbemLocator;
    if (FAILED(::CoCreateInstance(CLSID_WbemLocator, nullptr,
                                  CLSCTX_INPROC_SERVER, IID_IWbemLocator,
                                  reinterpret_cast<void**>(&wbemLocator)))) {
        ::CoUninitialize();
        return 0;  // Unable to create WbemLocator
    }

    CComPtr<IWbemServices> wbemServices;
    if (FAILED(wbemLocator->ConnectServer(_bstr_t(L"ROOT\\CIMV2"), nullptr,
                                          nullptr, nullptr, 0, nullptr, nullptr,
                                          &wbemServices))) {
        ::CoUninitialize();
        return 0;  // Unable to connect to WMI server
    }

    if (FAILED(::CoSetProxyBlanket(
            wbemServices, RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, nullptr,
            RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, nullptr,
            EOAC_NONE))) {
        ::CoUninitialize();
        return 0;  // Unable to set security levels
    }

    // Query WMI for GPU information
    CComPtr<IEnumWbemClassObject> enumerator;
    if (FAILED(wbemServices->ExecQuery(
            bstr_t("WQL"),
            bstr_t(L"SELECT Name, AdapterRAM FROM Win32_VideoController"),
            WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY, nullptr,
            &enumerator))) {
        ::CoUninitialize();
        return 0;  // Query failed
    }

    ULONG returned = 0;
    CComPtr<IWbemClassObject> obj;

    while (SUCCEEDED(enumerator->Next(WBEM_INFINITE, 1, &obj, &returned)) &&
           returned > 0) {
        variant_t name, adapterRAM;

        // Get GPU name
        if (SUCCEEDED(obj->Get(L"Name", 0, &name, nullptr, nullptr)) &&
            name.vt == VT_BSTR) {
            std::wstring gpuName = name.bstrVal;

            // Skip Intel GPUs
            if (gpuName.find(L"Intel") == std::wstring::npos) {
                // Get GPU memory
                if (SUCCEEDED(obj->Get(L"AdapterRAM", 0, &adapterRAM, nullptr,
                                       nullptr)) &&
                    (adapterRAM.vt == VT_I4 || adapterRAM.vt == VT_UI4)) {
                    gpuMemoryMB = static_cast<uint32_t>(
                        adapterRAM.uintVal /
                        (1024 * 1024));  // Convert bytes to MB
                    break;  // Stop after finding the first non-Intel GPU
                }
            }
        }
        obj.Release();
    }

    ::CoUninitialize();
    return gpuMemoryMB;  // Return 0 if no non-Intel GPU was found
}

inline const SYSTEM_INFO& systemInfo() noexcept {
    static SYSTEM_INFO info = {};
    if (!info.dwAllocationGranularity) ::GetSystemInfo(&info);
    return info;
}

inline ErrorOr<uint32_t> fileVersion(const file::Path& path) noexcept {
    DWORD versionInfoSize = ::GetFileVersionInfoSizeW(path.plat(), nullptr);
    if (versionInfoSize == 0)
        return APERR(::GetLastError(), "Unable to get file version info size",
                     path);

    // Allocate memory on the stack for it
    auto versionInfo = alloca(versionInfoSize);
    if (!::GetFileVersionInfoW(path.plat(), 0, versionInfoSize, versionInfo))
        return APERR(::GetLastError(), "Unable to get file version info", path);

    LPVOID buffer;
    UINT bufferLength;
    if (!::VerQueryValueW(versionInfo, L"\\", &buffer, &bufferLength))
        return APERR(::GetLastError(), "VerQueryValue in getFileVersion", path);

    return _reCast<VS_FIXEDFILEINFO*>(buffer)->dwProductVersionMS;
}

inline TextView architecture() noexcept {
    SYSTEM_INFO system;
    GetNativeSystemInfo(&system);
    switch (system.wProcessorArchitecture) {
        case PROCESSOR_ARCHITECTURE_AMD64:
            return "x64";
        case PROCESSOR_ARCHITECTURE_INTEL:
            return "x86";
        default:
            return "??";
    }
}

inline ErrorOr<Text> osVersion() noexcept {
    // Get the version number of kernel32.dll
    //
    // Believe it or not, it is almost impossible to find out what version
    // of windows you are actually running on. This is because Windows lies
    // quite a bit based on application manifest and compatibility. So, we
    // are going to query the version of kernel32.dll which is the primary
    // dll in windows.
    auto version = fileVersion("kernel32.dll");
    if (version.check()) return version.ccode();

    return string::format("Windows {} {}.{}", architecture(), HIWORD(*version),
                          LOWORD(*version));
}

struct DiskUtilization {
    int systemDiskUtilization = {};
    std::map<file::Path, int> diskUtilization;
};

inline ErrorOr<DiskUtilization> diskUtilization(
    bool forceRefresh = false) noexcept {
    // Disk utilization is queried per path, but it's easier to query the OS for
    // everything in one pass, so cache the values
    static async::MutexLock mutex;
    static Opt<DiskUtilization> cached;
    static Atomic<time::PreciseStamp> cacheLastUpdated = {};
    _const auto cacheUpdateInterval = 5s;

    // Lock the mutex
    auto lock = mutex.acquire();

    // Update the cached values when requested or every 5 seconds (WMI queries
    // are expensive)
    if (!forceRefresh && cached &&
        time::now() - cacheLastUpdated.load() < cacheUpdateInterval)
        return *cached;

    if (auto ccode = plat::ComInit::init()) return ccode;

    CComPtr<IWbemLocator> wbemLocator;
    if (auto hr = ::CoCreateInstance(CLSID_WbemLocator, 0, CLSCTX_INPROC_SERVER,
                                     IID_IWbemLocator,
                                     _reCast<LPVOID*>(&wbemLocator));
        FAILED(hr))
        return APERR(hr, "CoCreateInstance(CLSID_WbemLocator)");

    CComPtr<IWbemServices> wbemServices;
    if (auto hr = wbemLocator->ConnectServer(_bstr_t(L"ROOT\\CIMV2"), nullptr,
                                             nullptr, nullptr, 0, nullptr,
                                             nullptr, &wbemServices);
        FAILED(hr))
        return APERR(hr, "IWbemServices::ConnectServer");

    if (auto hr = ::CoSetProxyBlanket(
            wbemServices, RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, nullptr,
            RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, nullptr,
            EOAC_NONE);
        FAILED(hr))
        return APERR(hr, "CoSetProxyBlanket");

    CComPtr<IEnumWbemClassObject> enumerator;
    _const auto wqlQuery =
        L"SELECT Name, PercentIdleTime FROM "
        L"Win32_PerfFormattedData_PerfDisk_LogicalDisk";
    if (auto hr = wbemServices->ExecQuery(
            bstr_t("WQL"), bstr_t(wqlQuery),
            WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY, nullptr,
            &enumerator);
        FAILED(hr))
        return APERR(hr, "IWbemServices::ExecQuery(\"", wqlQuery, "\")");

    auto getUtilization = [](int percentIdleTime) noexcept {
        // PercentIdleTime is 100 if the disk is idle or 0 if it's busy; ensure
        // it's within the range of 0 to 100
        percentIdleTime = std::min(percentIdleTime, 100);
        percentIdleTime = std::max(percentIdleTime, 0);

        // Calculate utilization by subtracting PercentIdleTime from 100
        return 100 - percentIdleTime;
    };

    DiskUtilization du;
    _forever() {
        CComPtr<IWbemClassObject> obj;
        ULONG returned = {};
        if (auto hr = enumerator->Next(WBEM_INFINITE, 1, &obj, &returned);
            FAILED(hr))
            return APERR(hr, "IEnumWbemClassObject::Next");
        if (!returned) break;

        auto getProperty = [&](LPCWSTR name) noexcept -> ErrorOr<variant_t> {
            variant_t prop;
            if (auto hr = obj->Get(name, 0, &prop, nullptr, nullptr);
                FAILED(hr))
                return APERR(hr, "IWbemClassObject::Get(\"", name, "\")");
            return prop;
        };

        Text name;
        _using(auto nameProp = getProperty(L"Name")) {
            if (nameProp)
                name = _cast<bstr_t>(*nameProp);
            else
                return nameProp.ccode();
        }
        if (!name) continue;

        int percentIdleTime = {};
        _using(auto pitProp = getProperty(L"PercentIdleTime")) {
            if (pitProp)
                percentIdleTime = _nc<int>(_cast<uint64_t>(*pitProp));
            else
                return pitProp.ccode();
        }

        if (name.back() == ':')
            du.diskUtilization[name] = getUtilization(percentIdleTime);
        else if (name == "_Total")
            du.systemDiskUtilization = getUtilization(percentIdleTime);
    }

    if (!du.systemDiskUtilization && du.diskUtilization.empty())
        return APERR(Ec::Unexpected, "No disk utilization statistics found");

    cached = _mv(du);
    cacheLastUpdated = time::now();
    return *cached;
}

inline ErrorOr<int> plat::systemDiskUtilization(bool forceRefresh) noexcept {
    auto du = diskUtilization(forceRefresh);
    if (du)
        return du->systemDiskUtilization;
    else
        return du.ccode();
}

inline ErrorOr<DiskUsage> diskUsage(const file::Path& path) noexcept {
    ULARGE_INTEGER sizeIgnore, sizeFree, sizeTotal;
    if (!::GetDiskFreeSpaceExW(path.plat(), &sizeFree, &sizeTotal, &sizeIgnore))
        return APERR(::GetLastError(), "GetDiskFreeSpaceEx failed", path);

    int utilization = {};
    if (auto res = diskUtilization(path); !res.check()) utilization = *res;

    return DiskUsage{.spaceTotal = sizeTotal.QuadPart,
                     .spaceFree = sizeFree.QuadPart,
                     .utilization = utilization};
}

inline ErrorOr<int> diskUtilization(const file::Path& path,
                                    bool forceRefresh) noexcept {
    auto du = diskUtilization(forceRefresh);
    if (!du) return du.ccode();

    for (auto& [drive, utilization] : du->diskUtilization) {
        if (drive.isParentOf(path)) return utilization;
    }

    return APERR(Ec::NotFound, path);
}

template <typename MethodT>
inline ErrorOr<MethodT*> dynamicBind(const file::Path& libPath,
                                     const char* methodName,
                                     bool changeDir = false) noexcept {
    if (changeDir) {
        if (!SetCurrentDirectory(libPath.parent().plat()))
            return APERR(::GetLastError(), "Failed to change working dir",
                         libPath);
    }

    auto hLib = ::LoadLibraryW(libPath.plat());
    if (!hLib) return APERR(::GetLastError(), "Failed to load", libPath);

    auto method = _reCast<MethodT*>(::GetProcAddress(hLib, methodName));
    if (!method)
        return APERR(::GetLastError(), "Failed to bind method", libPath,
                     methodName);

    return method;
}

inline TextView renderSignal(int signal) noexcept {
    switch (signal) {
        case SIGINT:
            return "SIGINT";
        case SIGILL:
            return "SIGILL";
        case SIGFPE:
            return "SIGFPE";
        case SIGSEGV:
            return "SIGSEGV";
        case SIGTERM:
            return "SIGTERM";
        case SIGBREAK:
            return "SIGBREAK";
        case SIGABRT:
            return "SIGABRT";
        case SIGABRT_COMPAT:
            return "SIGABRT_COMPAT";
        default:
            return {};
    }
}

inline TextView renderSignalDescription(int signal) noexcept {
    switch (signal) {
        case SIGINT:
            return "Interrupt";
        case SIGILL:
            return "Illegal instruction - invalid function image";
        case SIGFPE:
            return "Floating point exception";
        case SIGSEGV:
            return "Segment violation";
        case SIGTERM:
            return "Software termination signal from kill";
        case SIGBREAK:
            return "Ctrl-Break sequence";
        case SIGABRT:
            return "Abnormal termination triggered by abort call";
        case SIGABRT_COMPAT:
            return "SIGABRT compatible with other platforms, same as SIGABRT";
        default:
            return {};
    }
}

inline TextView renderConsoleEvent(DWORD eventType) noexcept {
    switch (eventType) {
        case CTRL_C_EVENT:
            return "CTRL_C_EVENT";
        case CTRL_BREAK_EVENT:
            return "CTRL_BREAK_EVENT";
        case CTRL_CLOSE_EVENT:
            return "CTRL_CLOSE_EVENT";
        case CTRL_LOGOFF_EVENT:
            return "CTRL_LOGOFF_EVENT";
        case CTRL_SHUTDOWN_EVENT:
            return "CTRL_SHUTDOWN_EVENT";
        default:
            return "Unknown";
    }
}

inline BOOL WINAPI consoleEventHandler(DWORD eventType) noexcept {
    LOG(Always, "Received console event: {} ({})",
        renderConsoleEvent(eventType), eventType);
    switch (eventType) {
        case CTRL_C_EVENT:
        case CTRL_BREAK_EVENT:
        case CTRL_CLOSE_EVENT:
            if (async::globalCancelFlag()) {
                // The cancel flat was already set; exit
                LOG(Always, "Process was already cancelled; exiting");
                dev::fatality(
                    _location,
                    "Received Ctrl+C while waiting for process to cancel");
            } else {
                // Set the cancel flag and hope for graceful exit
                LOG(Always, "Cancelling");
                async::globalCancel();
            }
            return TRUE;

        default:
            return FALSE;
    }
}

template <typename HandleType>
inline ErrorOr<HandleType> duplicateHandle(HANDLE handle,
                                           HANDLE hTargetProcess) noexcept {
    HandleType duplicated;
    if (::DuplicateHandle(::GetCurrentProcess(), handle, hTargetProcess,
                          &duplicated, 0, FALSE, DUPLICATE_SAME_ACCESS))
        return duplicated;
    else
        return APERR(::GetLastError(), "DuplicateHandle failed");
}

inline ErrorOr<wil::unique_hfile> duplicateStreamHandle(
    const file::FileStream& stream) noexcept {
    if (!stream) return APERR(Ec::InvalidParam);

    return duplicateHandle<wil::unique_hfile>(stream.platHandle());
}

inline Error setFileAccessTime(const file::Path& path,
                               const FILETIME& atime) noexcept {
    // Open the file with FILE_WRITE_ATTRIBUTES so we can set its atime
    wil::unique_hfile hFile(::CreateFileW(path.plat(), FILE_WRITE_ATTRIBUTES,
                                          FILE_SHARE_READ, nullptr,
                                          OPEN_EXISTING, 0, nullptr));
    if (!hFile)
        return APERR(::GetLastError(),
                     "Unable to open file to set access time");

    if (!::SetFileTime(hFile.get(), nullptr, &atime, nullptr))
        return APERR(::GetLastError(), "Unable to set file access time");

    return {};
}

inline ErrorOr<IShellLinkPtr> loadShortcut(const file::Path& path) noexcept {
    if (auto ccode = plat::ComInit::init()) return ccode;

    IShellLinkPtr link;
    if (auto hr = link.CreateInstance(CLSID_ShellLink); FAILED(hr))
        return APERR(hr);

    IPersistFilePtr pf = link;
    if (!pf) return APERR(E_NOINTERFACE);

    if (auto hr = pf->Load(path.plat(), STGM_READ); FAILED(hr))
        return APERR(hr);

    return link;
}

inline bool isShortcut(const file::Path& path) noexcept {
    if (auto res = loadShortcut(path)) return true;
    return false;
}

inline ErrorOr<file::Path> getShortcutTarget(const file::Path& path) noexcept {
    // Load shortcut file
    auto shortcut = loadShortcut(path);
    if (!shortcut) return shortcut.ccode();

    // Resolve link
    if (auto hr = shortcut->Resolve(nullptr, SLR_NO_UI); FAILED(hr))
        return APERR(hr);

    // Get target path
    std::array<Utf16Chr, MAX_PATH + 1> target = {};
    if (auto hr = shortcut->GetPath(&target[0], _cast<int>(target.size()),
                                    nullptr, 0);
        FAILED(hr))
        return APERR(hr);

    return Text{&target[0]};
}

inline Error createShortcut(const file::Path& path,
                            const file::Path& target) noexcept {
    if (auto ccode = plat::ComInit::init()) return ccode;

    // Create link object
    IShellLinkPtr link;
    if (auto hr = link.CreateInstance(CLSID_ShellLink); FAILED(hr))
        return APERR(hr);

    // Set target path
    if (auto hr = link->SetPath(_cast<const Utf16Chr*>(target)); FAILED(hr))
        return APERR(hr);

    // Save shortcut file
    IPersistFilePtr pf = link;
    if (!pf) return APERR(E_NOINTERFACE);

    if (auto hr = pf->Save(_cast<const Utf16Chr*>(path), TRUE); FAILED(hr))
        return APERR(hr);

    return {};
}

inline ErrorOr<file::Path> getModulePath(const Text& moduleName) noexcept {
    // Don't free the module handle
    auto hModule = ::GetModuleHandleW(moduleName);
    if (!hModule)
        return APERR(::GetLastError(), "Module not loaded", moduleName);

    std::array<Utf16Chr, MAX_PATH + 1> path = {};
    if (!::GetModuleFileNameW(hModule, &path[0], _cast<DWORD>(path.size())))
        return APERR(::GetLastError(), "Unable to determine module path",
                     moduleName);

    return &path[0];
}

// Parse the PROCESSOR_IDENTIFIER environment variable
inline ErrorOr<ProcessorIdentifier> processorIdentifier() noexcept {
    // E.g. PROCESSOR_IDENTIFIER=AMD64 Family 23 Model 49 Stepping 0,
    // AuthenticAMD
    const Text pi = env("PROCESSOR_IDENTIFIER");
    if (!pi)
        return APERR(Ec::NotFound,
                     "PROCESSOR_IDENTIFIER environment variable does not exist "
                     "or is empty");

    ProcessorIdentifier res;
    // Split the CPU info from the vendor, which is delimited by a ,
    // Text::slice returns a pair of std::string_view; coerce into TextViews for
    // ease of use
    Pair<TextView, TextView> piComps = pi.slice(',');
    if (!piComps.first || !piComps.second)
        return APERR(
            Ec::InvalidSyntax,
            "Unable to parse PROCESSOR_IDENTIFIER environment variable", pi);

    auto cpuComps = piComps.first.split<std::vector<Text>>(' ');
    // Hopefully, these tags aren't localized!
    if (cpuComps.size() != 7 || cpuComps[1] != "Family" ||
        cpuComps[3] != "Model" || cpuComps[5] != "Stepping" ||
        !string::isNumeric(cpuComps[2]) || !string::isNumeric(cpuComps[4]) ||
        !string::isNumeric(cpuComps[6]))
        return APERR(Ec::InvalidSyntax,
                     "Unable to parse CPU information from "
                     "PROCESSOR_IDENTIFIER environment variable",
                     piComps.first);

    res.architecture = _mv(cpuComps[0]);
    res.family = _fs<uint32_t>(cpuComps[2]);
    res.model = _fs<uint32_t>(cpuComps[4]);
    res.stepping = _fs<uint32_t>(cpuComps[6]);

    res.vendor = piComps.second;
    res.vendor.trim();

    return res;
}

}  // namespace ap::plat
