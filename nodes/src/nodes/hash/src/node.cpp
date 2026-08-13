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

//-----------------------------------------------------------------------------
//
//	The node's entry points. The engine resolves these by name after loading
//	the library and drives the whole lifetime of the node through them.
//
//	Registration happens here rather than in a static initializer on purpose:
//	the engine's factory registry has an explicit init/deinit, and a factory
//	that outlives the module it points into is a crash waiting for shutdown.
//
//-----------------------------------------------------------------------------
#include <node_api.h>

#include "hash.hpp"

//-------------------------------------------------------------------------
/// @details
///		Registers the node's factories with the engine. After this returns
///		the engine can instantiate the node exactly like a built-in filter.
///	@returns
///		true if the node initialized
//-------------------------------------------------------------------------
extern "C" ROCKETRIDE_NODE_API bool initializeNode() noexcept {
    using namespace engine::store::filter::hash;

    if (auto ccode = ap::Factory::registerFactory(IFilterInstance::Factory,
                                                  IFilterGlobal::Factory)) {
        LOG(Services, "Failed to register the hash factories:", ccode);
        return false;
    }

    return true;
}

//-------------------------------------------------------------------------
/// @details
///		Removes what initializeNode() registered, so nothing in the registry
///		points into this module once it is unloaded.
//-------------------------------------------------------------------------
extern "C" ROCKETRIDE_NODE_API void deinitializeNode() noexcept {
    using namespace engine::store::filter::hash;

    ap::Factory::deregisterFactory(IFilterInstance::Factory,
                                   IFilterGlobal::Factory);
}
