#pragma once

// =============================================================================
// The C ABI every C++ node shared library must export.
//
// A node is declared to the engine by a services.json carrying "node": "cpp".
// At startup the engine resolves the library from the "path" field, loads it,
// and calls initializeNode(). The node registers its global and instance
// factories there; from that point the engine instantiates it exactly like a
// built-in C++ filter. deinitializeNode() unregisters them again, which has to
// happen before the library can be unloaded - a factory left in the registry
// would point at code that is no longer mapped.
//
// Both entry points are resolved by name, so they must keep C linkage.
// =============================================================================

#ifdef _WIN32
    #define ROCKETRIDE_NODE_API __declspec(dllexport)
#else
    #define ROCKETRIDE_NODE_API __attribute__((visibility("default")))
#endif

// The names the engine looks up. Kept as macros so the loader and the node
// agree on the spelling without repeating a string literal.
#define ROCKETRIDE_NODE_INIT "initializeNode"
#define ROCKETRIDE_NODE_DEINIT "deinitializeNode"

#ifdef __cplusplus
extern "C" {
#endif

// Registers the node's factories. Returns false if the node could not
// initialize, which the engine reports as a load failure. Nothing is thrown
// across this boundary.
typedef bool (*RocketrideNodeInit)(void);

// Unregisters what initializeNode() registered. Called during engine shutdown.
typedef void (*RocketrideNodeDeinit)(void);

#ifdef __cplusplus
}
#endif
