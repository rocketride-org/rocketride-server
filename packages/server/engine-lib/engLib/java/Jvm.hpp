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

namespace engine::java {
// Forward declaration of utility functions
Text renderJniError(jint error) noexcept;
void onJvmCrash(TextView reason) noexcept;
bool hasDebugArg() noexcept;

//-------------------------------------------------------------------------
/// @details
///		Define the jvm controller. This is the main interface into
///		into the jvm
///------------------------------------------------------------------------
class Jvm {
public:
    _const auto LogLevel = Lvl::Jvm;

    //-----------------------------------------------------------------
    /// @details
    ///		Initialize the jvm
    ///	@param[in]	jarPaths
    ///		The defaults jars to load. These should be the common
    ///		jars that all java code uses
    ///----------------------------------------------------------------
    Jvm(const std::vector<file::Path>& jarPaths,
        TextView javaDebug = ""_tv) noexcept(false) {
        // Get out temp directory
        auto tempDir = config::paths().cache;

        // The JVM can only be created once per process
        if (m_jvmCreated)
            APERRT_THROW(Ec::Java,
                         "Creation of multiple JVM's in a single process is "
                         "not supported");

        // Construct JVM options
        std::vector<Text> optionStrings;

        // The dbg class we stop at
        const Text mainClass = "com.rocketride.dbgconn";

        // Paths to .jars to load
        if (!jarPaths.empty())
            optionStrings.emplace_back(
                _fmt("-Djava.class.path={}",
                     string::concat(jarPaths, plat::IsWindows ? ";" : ":")));

        // If an agent lib is passed over, start it
        if (javaDebug) optionStrings.emplace_back(javaDebug);

        // Set heap size at 5GB (defaults to 256MB)
        optionStrings.emplace_back("-Xmx5000m");

        // Reduces the use of operating system signals by the JVM
        optionStrings.emplace_back("-Xrs");

        // Log fatal errors to configured log directory (falls back to system
        // temp)
        file::Path errorUri;
        if (dev::crashDumpPrefix())
            errorUri = dev::crashDumpLocation() /
                       (dev::crashDumpPrefix() + ".java_error.log");
        else
            errorUri = dev::crashDumpLocation() / "java_error%p.log";
        optionStrings.emplace_back("-XX:ErrorFile=" + errorUri.plat(false));

        // Override temp directory (defaults to system temp)
        optionStrings.emplace_back("-Djava.io.tmpdir=" + tempDir.plat(false));

        // Suppress warnings about using reflection to access file descriptors
        // see
        // https://docs.oracle.com/javase/9/migrate/toc.htm#JSMIG-GUID-7BB28E4D-99B3-4078-BDC4-FC24180CE82B
        optionStrings.emplace_back("--add-opens=java.base/java.io=ALL-UNNAMED");

        // Enable additional JNI diagnostics if indicated (verbose)
        if (log::isLevelExplicitlyEnabled(Lvl::Jni)) {
            optionStrings.emplace_back("-Xcheck:jni");
            optionStrings.emplace_back("-verbose:jni");
        }

        // Enable detailed JVM heap diagnostics if indicated
        if (log::isLevelExplicitlyEnabled(Lvl::JavaHeap)) {
            // see
            // https://docs.oracle.com/javase/8/docs/technotes/guides/troubleshoot/tooldescr007.html
            optionStrings.emplace_back("-XX:NativeMemoryTracking=detail");

            // The jcmd tool won't work without this environment variable being
            // defined (just for this process) see
            // https://blogs.oracle.com/poonam/using-nmt-with-custom-jvm-launcher
            auto pid = async::processId();
            plat::setEnv(_fmt("NMT_LEVEL_{}", pid), "detail");

            LOG(JavaHeap, "Enabled Java heap diagnostics for process", pid);
        }

        // Log the option strings before we add the hooks
        LOGTT(Java, "Creating JVM\n", optionStrings);

        std::vector<JavaVMOption> options;
        // Convenience function because options are char* instead of const char*
        auto addOption = [&](const char* option, void* extra = nullptr) {
            options.push_back({const_cast<char*>(option), extra});
        };

        for (auto& option : optionStrings) {
            addOption(option);
        }

        // Add hooks for JNI's vfprintf, abort, and exit
        // Clang won't allow the lambdas to be converted to e.g. decltype(&exit)
        // because of exit's [[noreturn]] attribute, so typedef the C functions
        using jvmVfprintf = int (*)(FILE*, const char*, va_list);
        addOption("vfprintf",
                  _reCast<void*>(_cast<jvmVfprintf>(
                      [](FILE* fp, const char* format, va_list args) noexcept {
                          char buffer[1_kb] = {'\0'};
                          auto retval =
                              vsnprintf(buffer, sizeof(buffer), format, args);
                          LOG(Java, "JNI: ", buffer);
                          return retval;
                      })));

        using jvmAbort = void (*)(void);
        addOption("abort", _reCast<void*>(_cast<jvmAbort>([]() noexcept {
                      const auto reason = string::format(
                          "JNI called abort on thread {}", async::threadId());
                      java::onJvmCrash(reason);
                      dev::fatality(_location, reason);
                  })));

        using jvmExit = void (*)(int);
        addOption("exit",
                  _reCast<void*>(_cast<jvmExit>([](int status) noexcept {
                      const auto reason = string::format(
                          "JNI called exit with status {} on thread {}", status,
                          async::threadId());
                      java::onJvmCrash(reason);
                      dev::fatality(_location, reason);
                  })));

        JavaVMInitArgs vm_args = {};
        vm_args.version = JNI_VERSION_1_8;
        vm_args.options = &options.front();
        vm_args.nOptions = static_cast<jint>(options.size());
        vm_args.ignoreUnrecognized =
            JNI_FALSE;  // Fail on unrecognized VM options

        // Before you go looking further about the 0xC0000005 exception,
        // aparently this is normal:
        // https://stackoverflow.com/questions/36250235/exception-0xc0000005-from-jni-createjavavm-jvm-dll
        // Under Visual Studio, this stops the debugger when running, but under
        // VS Code, it continues on without stopping.
        if (auto result =
                ::JNI_CreateJavaVM(&m_jvm, _reCast<void**>(&m_env), &vm_args);
            result != JNI_OK)
            APERRT_THROW(Ec::Java, "Failed to initialize JVM",
                         renderJniError(result));
        m_jvmCreated = true;

        // Record the thread we were initialized on so we don't reattach this
        // thread to the JVM
        m_owningThreadId = async::threadId();
        LOGTT(Java, "Successfully created JVM with owning thread id",
              m_owningThreadId);
        return;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Deinitialize the jvm
    ///----------------------------------------------------------------
    ~Jvm() noexcept {
        // If the static JVM object is allowed to deconstruct as the program
        // is terminating, any LOG statements below will cause a crash; ensure
        // that java::deinit is explicitly called during program exit
        if (!m_jvm) return;

        try {
            // Invoke any configured deinit callbacks
            LOGT("Invoking deinit callbacks");
            for (auto& callback : m_deinitCallbacks) {
                try {
                    auto jni = getInterface();
                    callback(jni);
                } catch (const Error& e) {
                    LOG(Always,
                        "Caught exception while invoking JVM deinit callback",
                        e);
                }
            }

            LOGT("Destroying JVM");
            m_jvm->DestroyJavaVM();
            LOGT("JVM destroyed");
        } catch (const std::exception& e) {
            LOG(Always, "Caught exception while destroying JVM", e);
        }
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Initializes the calling thread to be able to call jni
    ///		functions
    ///----------------------------------------------------------------
    JNIEnv* initThread(bool detachable = false) noexcept(false) {
        LOGT("Initializing thread, detachable:", detachable);

        // If the calling thread is also the thread that initialized the JVM
        // (e.g. a unit test), just return our interface
        if (async::threadId() == m_owningThreadId) {
            LOGT("initThread called from JVM thread; not re-attaching");
            return m_env;
        }

        LOGT("Attaching thread to JVM");
        JNIEnv* env = nullptr;

        // Depending on how the caller is using this context, attach as a daemon
        // thread or normal thread
        if (detachable) {
            if (auto result =
                    m_jvm->AttachCurrentThread(_reCast<void**>(&env), nullptr);
                result != JNI_OK)
                APERRT_THROW(Ec::Java, "Failed to attach thread to JVM",
                             renderJniError(result));
        } else {
            if (auto result = m_jvm->AttachCurrentThreadAsDaemon(
                    _reCast<void**>(&env), nullptr);
                result != JNI_OK)
                APERRT_THROW(Ec::Java, "Failed to attach thread to JVM",
                             renderJniError(result));
        }

        LOGT("Initialized thread, detachable:", detachable);
        return env;
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Denitializes (or detaches) the calling thread
    ///----------------------------------------------------------------
    void deinitThread() noexcept {
        if (async::threadId() != m_owningThreadId) {
            LOGT("Deinitializing thread");

            ASSERTD_MSG(m_jvm->DetachCurrentThread() == JNI_OK,
                        "Failed to detach JNI thread");
        } else {
            LOGT("deinitThread called from JVM thread; not detaching");
        }
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Registers a native method within a class
    ///	@param[in] clazz
    ///		The java class to register within
    ///	@param[in]	method
    ///		The method information to register
    ///----------------------------------------------------------------
    void registerNativeCallback(jclass clazz,
                                const JNINativeMethod& method) noexcept(false) {
        if (auto result = m_env->RegisterNatives(clazz, &method, 1);
            result != JNI_OK)
            APERRT_THROW(Ec::Java, "Failed to register native callback",
                         getInterface().getClassName(clazz), method.name,
                         renderJniError(result));
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Registers a global class by name within the jvm
    ///	@param[in] className
    ///		The java class name to register within
    ///	@param[in]	method
    ///		The method information to register
    ///----------------------------------------------------------------
    void registerNativeCallback(const char* className,
                                const JNINativeMethod& method) noexcept(false) {
        auto clazz = m_env->FindClass(className);
        if (!clazz) APERRT_THROW(Ec::Java, "Java class not found", className);
        registerNativeCallback(clazz, method);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Registers a series of native callbacks by name
    ///	@param[in] className
    ///		The java class name to register within
    ///	@param[in]	method
    ///		Ptr to the method information table
    ///	@param[in]	functionCount
    ///		The number of methods to register
    ///----------------------------------------------------------------
    void registerNativeCallbacks(const char* className,
                                 const JNINativeMethod* functionTable,
                                 size_t functionCount) noexcept(false) {
        auto clazz = m_env->FindClass(className);
        if (!clazz) APERRT_THROW(Ec::Java, "Java class not found", className);

        // Register individually to make errors more easily identifiable
        for (size_t i = 0; i < functionCount; ++i) {
            registerNativeCallback(clazz, functionTable[i]);
        }
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Returns the JNI interface that the caller can utilize
    ///----------------------------------------------------------------
    Jni getInterface() noexcept {
        ASSERT_MSG(m_env, "Not initialized");
        ASSERT_MSG(async::threadId() == m_owningThreadId,
                   "Can only access JVM's JNI interface from the JVM thread "
                   "(call initThread)");
        return Jni(m_env);
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Add a callback that will be called when the JVM is
    ///		deinitialized
    ///	@param[in]	callback
    ///		The callback to call
    ///----------------------------------------------------------------
    typedef std::function<void(Jni&)> DeinitCallback;
    void addDeinitCallback(DeinitCallback callback) noexcept {
        m_deinitCallbacks.emplace_back(_mv(callback));
    }

protected:
    //-----------------------------------------------------------------
    /// @details
    ///		The ptr to the loaded jvm
    ///----------------------------------------------------------------
    JavaVM* m_jvm = nullptr;

    //-----------------------------------------------------------------
    /// @details
    ///		The ptr to the initialize env
    ///----------------------------------------------------------------
    JNIEnv* m_env = nullptr;

    //-----------------------------------------------------------------
    /// @details
    ///		The owning thread the create the jvm
    ///----------------------------------------------------------------
    async::Tid m_owningThreadId;

    //-----------------------------------------------------------------
    /// @details
    ///		List of callbacks to call during deinit
    ///----------------------------------------------------------------
    std::vector<DeinitCallback> m_deinitCallbacks;

    //-----------------------------------------------------------------
    /// @details
    ///		Flag indicating whether we have create the jvm
    ///----------------------------------------------------------------
    inline static bool m_jvmCreated = {};
};

//-------------------------------------------------------------------------
/// @details
///		Utility function to convert a numeric java error code to a string
///	@param[in] error
///		The error code to convert
///------------------------------------------------------------------------
inline Text renderJniError(jint error) noexcept {
    switch (error) {
        case JNI_OK:
            return "Success";
        case JNI_ERR:
            return "Unspecified error";
        case JNI_EDETACHED:
            return "Thread detached from the VM";
        case JNI_EVERSION:
            return "JNI version error";
        case JNI_ENOMEM:
            return "Not enough memory";
        case JNI_EEXIST:
            return "VM already created";
        case JNI_EINVAL:
            return "Invalid arguments";
        default:
            return _fmt("Unknown JNI error: {}", error);
    };
}

//-------------------------------------------------------------------------
/// @details
///		Log diagnostic data on JVM crash
///	@param[in] reason
///		The reason why we are doing this
///------------------------------------------------------------------------
inline void onJvmCrash(TextView reason) noexcept {
    // Log the reason so that subsequently logged diagnostics make some sense
    LOG(Always, reason);

    // Dump the process (only on Windows)
    dev::dumpProcess();

    // Log JVM heap usage (if available)
    if (log::options().additionalMemoryUsed)
        LOG(Always, "Current JVM heap usage: {,s}",
            log::options().additionalMemoryUsed);
}
}  // namespace engine::java
