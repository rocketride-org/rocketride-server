#pragma once

// =============================================================================
// The public C ABI for the shared engine module - its entire exported surface
// =============================================================================

#ifdef _WIN32
    #ifdef ENGINE_MOD_EXPORT
        #define ENGINE_API __declspec(dllexport)
    #else
        #define ENGINE_API __declspec(dllimport)
    #endif
#else
    #ifdef ENGINE_MOD_EXPORT
        #define ENGINE_API __attribute__((visibility("default")))
    #else
        #define ENGINE_API
    #endif
#endif

#ifdef __cplusplus
    #define ENGINE_NOEXCEPT noexcept
#else
    #define ENGINE_NOEXCEPT
#endif

#ifdef _WIN32
    #include <wchar.h>
#endif

#ifdef __cplusplus
extern "C" {
#endif

// Runs the engine to completion and returns the process exit code. Handles every
// error internally; nothing is thrown across this boundary.
#ifdef _WIN32
ENGINE_API int engine_run(int argc, const wchar_t** argv) ENGINE_NOEXCEPT;
#else
ENGINE_API int engine_run(int argc, const char** argv) ENGINE_NOEXCEPT;
#endif

#ifdef __cplusplus
}
#endif
