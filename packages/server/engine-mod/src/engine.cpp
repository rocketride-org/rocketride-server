// =============================================================================
// The engine's bootstrap, behind the exported engine_run() entry point
// =============================================================================

#include <engLib/eng.h>

#include <engine.h>

#if ROCKETRIDE_PLAT_WIN
#include <apLib/application/win/crashHandlers.ipp>

namespace {

ap::ErrorCode runEngine() {
    using namespace ap;
    Error ccode;

    // NOTE: Temporary handle --verify option to workaround CI/CD failure (see OPS-6087)
    // TODO: Remove this once OPS-6087 is fixed.
    if (application::cmdline().argc() == 2 && application::cmdline().argv()[1] == "--verify"_tv)
        return engine::TaskEc::COMPLETED;

    // Init the engine
    ccode = engine::init();

    // Run it if we inited it
    if (!ccode)
        ccode = engine::task::Main();

    // Output the exit code
    if (engine::config::monitor()) {
        MONCCODE(exit, ccode);
    } else {
        std::string message = _ts(ccode);
        std::cout << "Error: " << message << std::endl;
    }

    // Deinit the engine
    engine::deinit();

    // Get the exit status
    if (ccode)
        return engine::TaskEc::END_CODE_ERROR;
    return engine::TaskEc::COMPLETED;
}

}  // namespace

extern "C" ENGINE_API int engine_run(int argc, const wchar_t** argv) noexcept {
    using namespace ap;

    // Set the global commandline
    ::ap::application::cmdline() = {argc, argv};

    // Initialize apLib
    auto initScope = ::ap::init();

    // Determine our app path
    if (auto err = ::ap::application::detectExecPath()) return err;

    installCrashHandlers();

    // Call the engine with blocking and translation of exceptions to errors
    auto res = ::ap::error::call(_location, [&] { return runEngine().value(); });

    if (!res) return res.ccode().plat();
    return *res;
}

#else  // POSIX

namespace {

ap::ErrorCode runEngine() {
    using namespace ap;
    Error ccode;

    if (application::cmdline().argc() == 2 && application::cmdline().argv()[1] == "--verify"_tv)
        return engine::TaskEc::COMPLETED;

    ccode = engine::init();

    if (!ccode)
        ccode = engine::task::Main();

    if (engine::config::monitor()) {
        MONCCODE(exit, ccode);
    } else {
        std::string message = _ts(ccode);
        std::cout << "Error: " << message << std::endl;
    }

    engine::deinit();

    if (ccode)
        return engine::TaskEc::END_CODE_ERROR;
    return engine::TaskEc::COMPLETED;
}

}  // namespace

extern "C" ENGINE_API int engine_run(int argc, const char** argv) noexcept {
    using namespace ap;

    // Set the global commandline
    ::ap::application::cmdline() = {argc, argv};

#if ROCKETRIDE_PLAT_LIN
    // Ready the core
    auto initScope = ::ap::init();

    ::ap::application::detectExecPath();
#else
    ::ap::application::detectExecPath();

    // Ready the core
    auto initScope = ::ap::init();
#endif

    // Call the engine with blocking and translation of exceptions to errors
    auto res = ::ap::error::call(_location, [&] { return runEngine().value(); });

    if (!res) return res.ccode().plat();
    return *res;
}

#endif
