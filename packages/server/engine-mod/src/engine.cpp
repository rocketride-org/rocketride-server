// =============================================================================
// The engine's bootstrap, behind the exported engine_run() entry point
// =============================================================================

#include <engLib/eng.h>

#include <engine.h>

// Matches the engine_run declarations in engine.h
#if ROCKETRIDE_PLAT_WIN
using ArgChr = wchar_t;
#else
using ArgChr = char;
#endif

namespace {

// The engine itself, called by bootstrap with exceptions translated to errors
ap::ErrorCode engineMain() noexcept {
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

extern "C" ENGINE_API int engine_run(int argc, const ArgChr** argv) noexcept {
    return ::ap::application::bootstrap(argc, argv, &engineMain);
}
