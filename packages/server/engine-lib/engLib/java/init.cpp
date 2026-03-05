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

#include <engLib/eng.h>

namespace engine::java {
//-----------------------------------------------------------------------------
/// @details
///		Option to force into java or tika mode
//-----------------------------------------------------------------------------
application::Opt ExecJava{"--java"};
application::Opt ExecTika{"--tika"};

namespace {
//-------------------------------------------------------------------------
/// @details
///		This is the command line parameter to enabled debugging, usually
///		specified as -agentlib:jdwp=...
///------------------------------------------------------------------------
Text g_javaDebug;

//-------------------------------------------------------------------------
/// @details
///		The jars to load
///------------------------------------------------------------------------
std::vector<file::Path> g_javaJars;

//-------------------------------------------------------------------------
/// @details
///		Contains the java args we send to init from the command line
///------------------------------------------------------------------------
TextVector g_javaArgs;

//-------------------------------------------------------------------------
/// @details
///		The ptr to the loaded jvm
///------------------------------------------------------------------------
JavaVM *g_jvm = nullptr;

//-------------------------------------------------------------------------
/// @details
///		The ptr to the initialize env
///------------------------------------------------------------------------
JNIEnv *g_env = nullptr;

//-------------------------------------------------------------------------
/// @details
///		The owning thread the create the jvm
///------------------------------------------------------------------------
async::Tid g_owningThreadId;

//-------------------------------------------------------------------------
/// @details
///		List of callbacks to call during deinit
///------------------------------------------------------------------------
std::vector<DeinitCallback> g_deinitCallbacks;

//-------------------------------------------------------------------------
/// @details
///		Register the above native callbacks
///	@param[in]	jvm
///     The jvm to register with
//-------------------------------------------------------------------------
void processArguments(JNIEnv *env, jobject ins, jobjectArray args) {
    GET_JAVA_JNI_THROW(jni);

    // Build args
    std::vector<Text> execArgs;
    for (auto index = 0; index < env->GetArrayLength(args); index++) {
        // Get the object
        auto obj = env->GetObjectArrayElement(args, _cast<jsize>(index));

        // Get the text from it
        Text arg = jni.jCast<Text>(obj);

        // Save it
        execArgs.push_back(arg);
    }

    // Run the tasks specified on the command line
    auto ccode = engine::task::executeArguments(execArgs);
    return;
}

//-------------------------------------------------------------------------
/// @details
///		Register the above native callbacks
///	@param[in]	jvm
///     The jvm to register with
//-------------------------------------------------------------------------
void debugRegisterCallbacks() noexcept(false) {
    GET_JAVA_JNI_THROW(jni);

    // Register native callbacks
    JNINativeMethod nativeMethodTable[] = {
        {_constCast<char *>("processArguments"),
         _constCast<char *>("([Ljava/lang/String;)V"),
         _reCast<void *>(processArguments)}

    };

    // Get our debug class
    auto main = jni.getClass("com/rocketride/dbgconn");

    // If we don't have it, done
    if (!main) return;

    // Register the callback
    engine::java::registerNativeCallbacks("com/rocketride/dbgconn",
                                          nativeMethodTable,
                                          std::size(nativeMethodTable));
}

//-------------------------------------------------------------------------
/// @details
///		Computes all the jar files in the lib/node paths and
///		adds them to g_javaJars which is passed in init to the classpath
///------------------------------------------------------------------------
Error getJars() {
    // Add all the files we find to the jarPaths list
    const std::function<Error(file::Path &)> scanFiles =
        localfcn(file::Path & parentPath)->Error {
        // Get the search mask
        file::Path scanPath = parentPath / "*";

        // Get the scanner
        file::FileScanner scanner(scanPath);

        if (auto ccode = scanner.open(); ccode)
            return APERRL(Job, Ec::InvalidParam,
                          "Invalid argument, could not find", parentPath,
                          ccode);

        _forever() {
            // Get the next file
            auto entry = scanner.next();
            if (!entry) return {};

            // If this is a directory, walk into it
            if (entry->second.isDir) {
                auto newPath = parentPath / entry->first;
                if (auto ccode = scanFiles(newPath)) return ccode;
                continue;
            }

            // If his is a jar, save it
            if (entry->first.endsWith(".jar"))
                g_javaJars.push_back(parentPath / entry->first);
        }

        return {};
    };

    // Create our path
    file::Path path;

    // Scan for all jars in our general nodes directory
    path = application::execDir() / "nodes";
    scanFiles(path);

    // Scan for all jars in the java lib
    path = java::rootDir() / "lib";
    scanFiles(path);
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Initialize the jvm
///	@param[in]	jarPaths
///		The defaults jars to load. These should be the common
///		jars that all java code uses
///------------------------------------------------------------------------
void initJvm() noexcept(false) {
    Error ccode;

    LOG(Java, "Initializing JVM");

    // Get our temp directory
    auto tempDir = config::paths().cache;

    // The JVM can only be created once per process
    if (g_jvm)
        APERR_THROW(
            Ec::Java,
            "Creation of multiple JVM's in a single process is not supported");

#if ROCKETRIDE_PLAT_WIN
    // Assume that the JRE is installed in a subdirectory beneath the
    // application directory
    auto jvmDirectory = jreDirectory();
    if (!file::exists(jvmDirectory / "jvm.dll"))
        return APERR_THROW(Ec::Java, "jvm.dll not found in ", jvmDirectory);

    // Add directory containing jvm.dll to DLL search path (the DLL must reside
    // in a particular path relative to the Java installation; do not move the
    // DLL to a new path [e.g. the application directory])
    if (!::SetDllDirectoryW(jvmDirectory.plat(false)))
        return APERR_THROW(GetLastError(),
                           "Failed to add JVM directory to DLL path",
                           jvmDirectory);
#endif

    // Get all the standard jar files
    LOG(Java, "Getting built-in jars");
    if (ccode = getJars()) throw ccode;

    // If the JavaDetails log level is enabled but not Java, enable the Java log
    // level as well
    if (log::isLevelEnabled(Lvl::JavaDetails) &&
        !log::isLevelEnabled(Lvl::Java))
        log::enableLevel(Lvl::Java);

    // Construct JVM options
    std::vector<Text> optionStrings;

    // Paths to .jars to load
    if (!g_javaJars.empty())
        optionStrings.emplace_back(
            _fmt("-Djava.class.path={}",
                 string::concat(g_javaJars, plat::IsWindows ? ";" : ":")));

    // Set heap size at 5GB (defaults to 256MB)
    optionStrings.emplace_back("-Xmx5000m");

    // Reduces the use of operating system signals by the JVM
    optionStrings.emplace_back("-Xrs");

    // Log fatal errors to configured log directory (falls back to system temp)
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

    // Build the option list
    std::vector<JavaVMOption> options;
    auto addOption = [&](const char *option, void *extra = nullptr) {
        options.push_back({const_cast<char *>(option), extra});
    };

    // Add all the options strings we generated
    for (auto &option : optionStrings) {
        addOption(option);
    }

    // Add hooks for JNI's vfprintf, abort, and exit
    // Clang won't allow the lambdas to be converted to e.g. decltype(&exit)
    // because of exit's [[noreturn]] attribute, so typedef the C functions
    using jvmVfprintf = int (*)(FILE *, const char *, va_list);
    addOption("vfprintf",
              _reCast<void *>(_cast<jvmVfprintf>(
                  [](FILE *fp, const char *format, va_list args) noexcept {
                      char buffer[1_kb] = {'\0'};
                      auto retval =
                          vsnprintf(buffer, sizeof(buffer), format, args);
                      LOG(Java, "JNI: ", buffer);
                      return retval;
                  })));

    using jvmAbort = void (*)(void);
    addOption("abort", _reCast<void *>(_cast<jvmAbort>([]() noexcept {
                  const auto reason = string::format(
                      "JNI called abort on thread {}", async::threadId());
                  java::onJvmCrash(reason);
                  dev::fatality(_location, reason);
              })));

    using jvmExit = void (*)(int);
    addOption("exit", _reCast<void *>(_cast<jvmExit>([](int status) noexcept {
                  const auto reason = string::format(
                      "JNI called exit with status {} on thread {}", status,
                      async::threadId());
                  java::onJvmCrash(reason);
                  dev::fatality(_location, reason);
              })));

    // Add any opions we specified on the command line (in JavaExec mode)
    for (auto &arg : g_javaArgs) {
        addOption(arg);
    }

    // Build our block of arguments to pass to jni
    JavaVMInitArgs vg_args = {};
    vg_args.version = JNI_VERSION_1_8;
    vg_args.options = &options.front();
    vg_args.nOptions = static_cast<jint>(options.size());
    vg_args.ignoreUnrecognized = JNI_FALSE;  // Fail on unrecognized VM options

    // Log the option strings before we add the hooks
    LOG(Java, "Creating JVM");

    // Before you go looking further about the 0xC0000005 exception, aparently
    // this is normal:
    // https://stackoverflow.com/questions/36250235/exception-0xc0000005-from-jni-createjavavm-jvm-dll
    // Under Visual Studio, this stops the debugger when running, but under VS
    // Code, it continues on without stopping.

    if (auto result =
            ::JNI_CreateJavaVM(&g_jvm, _reCast<void **>(&g_env), &vg_args);
        result != JNI_OK) {
        g_jvm = nullptr;
        APERR_THROW(Ec::Java, "Failed to initialize JVM",
                    renderJniError(result));
    }

    // Get the VM and our JNI interface
    GET_JAVA_JNI_THROW(jni);

    // Register logging callback
    logRegisterCallbacks();

    // Initialize logging
    LOG(Java, "Registering logging callbacks");
    Logging::init(jni);

    // Intializing debugging callbacks
    LOG(Java, "Registering debugging callbacks");
    debugRegisterCallbacks();

    // Record the thread we were initialized on so we don't reattach this thread
    // to the JVM
    g_owningThreadId = async::threadId();
    return;
}

//-------------------------------------------------------------------------
/// @details
///		Deinitialize the jvm
///------------------------------------------------------------------------
void deinitJvm() noexcept {
    Error ccode;

    // If the static JVM object is allowed to deconstruct as the program
    // is terminating, any LOG statements below will cause a crash; ensure
    // that java::deinit is explicitly called during program exit
    if (!g_jvm) return;

    try {
        // Invoke any configured deinit callbacks
        LOG(Java, "Invoking deinit callbacks");
        for (auto &callback : g_deinitCallbacks) {
            try {
                GET_JAVA_JNI_THROW(jni);
                callback(jni);
            } catch (const Error &e) {
                LOG(Always,
                    "Caught exception while invoking JVM deinit callback", e);
            }
        }

        LOG(Java, "Destroying JVM");
        g_jvm->DestroyJavaVM();
        LOG(Java, "JVM destroyed");
    } catch (const std::exception &e) {
        LOG(Always, "Caught exception while destroying JVM", e);
    }

    // Clear it so we can re-init
    g_jvm = nullptr;
}

//-------------------------------------------------------------------------
/// @details
///		Initializes the calling thread to be able to call jni
///		functions
///------------------------------------------------------------------------
JNIEnv *initThread(bool detachable = false) noexcept(false) {
    LOG(Java, "Initializing thread, detachable:", detachable);

    // If the calling thread is also the thread that initialized the JVM (e.g.
    // a unit test), just return our interface
    if (async::threadId() == g_owningThreadId) {
        LOG(Java, "initThread called from JVM thread; not re-attaching");
        return g_env;
    }

    LOG(Java, "Attaching thread to JVM");
    JNIEnv *env = nullptr;

    // Depending on how the caller is using this context, attach as a daemon
    // thread or normal thread
    if (detachable) {
        if (auto result =
                g_jvm->AttachCurrentThread(_reCast<void **>(&env), nullptr);
            result != JNI_OK)
            APERR_THROW(Ec::Java, "Failed to attach thread to JVM",
                        renderJniError(result));
    } else {
        if (auto result = g_jvm->AttachCurrentThreadAsDaemon(
                _reCast<void **>(&env), nullptr);
            result != JNI_OK)
            APERR_THROW(Ec::Java, "Failed to attach thread to JVM",
                        renderJniError(result));
    }

    LOG(Java, "Initialized thread, detachable:", detachable);
    return env;
}

//-------------------------------------------------------------------------
/// @details
///		Denitializes (or detaches) the calling thread
///------------------------------------------------------------------------
void deinitThread() noexcept {
    if (async::threadId() != g_owningThreadId) {
        LOG(Java, "Deinitializing thread");

        ASSERTD_MSG(g_jvm->DetachCurrentThread() == JNI_OK,
                    "Failed to detach JNI thread");
    } else {
        LOG(Java, "deinitThread called from JVM thread; not detaching");
    }
}
}  // namespace

//-------------------------------------------------------------------------
/// @details
///		Return the jvm reference
///------------------------------------------------------------------------
ErrorOr<Jvm *> getJvm() noexcept {
    if (g_jvm) return g_jvm;
    return APERR(Ec::InvalidState, "Java not initialized");
}

//-------------------------------------------------------------------------
/// @details
///		Return a JNI class ptr the current thread
///------------------------------------------------------------------------
ErrorOr<Jni *> getJni(bool detachable) noexcept {
    // Only once per thread
    _thread_local async::Tls<java::Jni> jni{_location};

    // If we are already initialized, return the current one
    if (jni->getEnv()) return &jni;

    // for the main thread, this will return the root context,
    // for a non-main thread, this will init the thread
    auto jnienv = initThread(detachable);

    // Setup the new JNIEnv attachment
    jni->setEnv(jnienv);

    // And return a reference to it
    return &jni;
}

//-------------------------------------------------------------------------
/// @details
///		Return a JNI interface for the current thread
///------------------------------------------------------------------------
ErrorOr<JNIEnv *> getEnv(bool detachable) noexcept {
    GET_JAVA_JNI(jni);
    return jni.getEnv();
}

//-------------------------------------------------------------------------
/// @details
///		Add a callback that will be called when the JVM is
///		deinitialized
///	@param[in]	callback
///		The callback to call
///------------------------------------------------------------------------
void addDeinitCallback(DeinitCallback callback) noexcept {
    g_deinitCallbacks.emplace_back(_mv(callback));
}

//---------------------------------------------------------------------
/// @details
///		This function will determine if the command line given is
///		directed to java or not. To do this, we look at all the
///		parameters and try to figure out if its java or not
//---------------------------------------------------------------------
bool isJava() noexcept {
    // Get the command line
    auto &cmds = application::cmdline();

    // If --java or --tika was specified, forces into java mode
    if (ExecJava || ExecTika) return true;

    // Get the original arguments
    auto args = cmds.args_original();

    // Loop through the arguments, the first being the program name
    // which can be ignored
    for (auto index = 1; index < args.size(); index++) {
        // Get the argument
        auto &arg = args[index];

        // These options indicate java
        if (arg == "-cp" || arg == "-classpath") {
            LOG(Java, "Java class path given, starting as java");
            return true;
        }

        // Skip any options
        if (arg[0] == '-') continue;

        // If it is a class specifier running java code directly, we have java!
        if (arg.startsWith("com.") || arg.startsWith("org.")) {
            LOG(Java, "Java class reference recognized, starting as java");
            return true;
        }
    }

    // Not java
    return false;
}

//---------------------------------------------------------------------
/// @details
///		This function will determine what to do with a java command
///		line.
///
///		engine -cp file.jar[;file.jar] mainClass
///			Execute the main class function in the given jar
///
///		If this is a python command line, we will have removed all
///		the arguments and sent them to python, so there will be
///		no remaining arguments and the regular task runner should
///		fall right through
///
///--------------------------------------------------------------------
Error execJava() noexcept {
    // Get the arguments - unlike python, we want the arguments
    // that we understand pulled out
    auto args = application::args();

    // Turn off status codes at end
    engine::monitor::setShowExitCode(false);

    // Execute the main class
    const auto javaExec = localfcn()->Error {
        // Interpret the command line
        Text execClass;
        auto index = 0;

        // If we are executing tika...
        // Look for the first non-option
        for (index = 1; index < args.size(); index++) {
            // Get the arg
            auto arg = args[index];

            // Process the class path option
            if (arg == "-cp" || arg == "-classpath") {
                // Point past -cp
                index++;

                // If we have another arg, save it into the jar list
                if (index < args.size()) g_javaJars.push_back(args[index]);

                // Look for more class paths, jars, etc
                continue;
            }

            // Find the class specifier
            if (arg.startsWith("com.") || arg.startsWith("org.")) {
                // Output it
                LOG(Java, "Executing", arg);

                // Point past it
                index++;

                // Got the class to execute
                execClass = arg;
                break;
            }

            // If it is an not option, done parsing
            if (arg[0] != '-') break;

            // Save the argument
            g_javaArgs.push_back(arg);
        }

        // If we are execing tika, set the class
        if (ExecTika) {
            // Setup for tika
            execClass = "com.rocketride.tika_api.TikaApi";
        }

        // Grab the args going over to the main(args)
        TextVector otherArgs;
        for (; index < args.size(); index++) otherArgs.push_back(args[index]);

        // Check to make sure we have an exec class
        if (!execClass) {
            LOG(Java, "did not find an executable class");
            return APERR(Ec::InvalidCommand,
                         "Did not find an executable class");
        }

        // Init the engine
        if (auto ccode = init()) return ccode;

        // Setup the reference to our jni interface
        GET_JAVA_JNI(jni);

        // Change all . to / for jni
        execClass = execClass.replace('.', '/');

        // Get our main class
        auto main = jni.getClass(execClass);

        // Get the method id for main
        auto methodId =
            jni.getStaticMethodId(main, "main", "([Ljava/lang/String;)V");

        // Build the string array to pass
        auto execArgs = jni.createStringArray(otherArgs);

        // Invoke it
        jni.invokeStaticMethod(main, methodId, execArgs);

        // Deinit the jvm
        deinitJvm();

        // And return any error
        return {};
    };

    // Execute it
    auto ccode = _callChk([&] { return javaExec(); });

    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Public init method for initializing the RocketRide Java subsystem
///------------------------------------------------------------------------
Error init() noexcept {
    Error ccode;

    // Check for double initialization
    if (initialized()) return {};

    // Internal init
    const auto initInt = localfcn()->Error {
        // Initialize our jvm
        initJvm();

        // Get the VM and our JNI interface
        GET_JAVA_JNI(jni);

        // Register logging callback
        logRegisterCallbacks();

        // Initialize logging
        LOG(Java, "Initializing logging");
        Logging::init(jni);

        // Debug
        return Error{};
    };

    // Initialize the JVM - this tends to throw if anything goes wrong, so
    // catch error here and return it as an error code
    if (ccode = _callChk([&] { return initInt(); })) return ccode;

#if ROCKETRIDE_PLAT_WIN
    // Re-install the console control handler so that we get console signals
    // (e.g. Ctrl + C) instead of the JVM
    ::SetConsoleCtrlHandler(plat::consoleEventHandler, TRUE);
#endif

    // And done
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Determine if we have been initialized
///------------------------------------------------------------------------
bool initialized() noexcept { return g_jvm ? true : false; }

//-------------------------------------------------------------------------
/// @details
///		Release the ptr - should stop the jvm if all was released
///------------------------------------------------------------------------
void deinit() noexcept { deinitJvm(); }

}  // namespace engine::java