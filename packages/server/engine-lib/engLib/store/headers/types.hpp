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

//-------------------------------------------------------------------------
//
//	|---------------|
//	| endpoint		|
//	| 	m_pipes		|-------|
//	|---------------|		|
//						|---------------|
//						| pipeGlobal	|
//						|	m_pipes		|-----------|---------------|
//			|-----------|	m_global	|			|				|
//			|			|---------------|			|				|
//		  Stack Array		|						|				|
//							v						v				v
//						|-----------|		|-----------|	|-----------|
//						| pipeGlb	| <---> | pipeIns	|	| pipeIns	|
//						|-----------|		|-----------|	|-----------|
//							^					^				^
//							|					|				|
//							v					v				v
//		|-----------|	|-----------|		|-----------|	|-----------|
//		| compress	|	| pipeGlb	| <---> | compress	|	| compress	|
//		|-----------|	|-----------|		|-----------|	|-----------|
//							^					^				^
//							|					|				|
//							v					v				v
//		|-----------|	|-----------|		|-----------|	|-----------|
//		| encrypt	|	| pipeGlb	| <---> | encrypt	|	| encrypt	|
//		|-----------|	|-----------|		|-----------|	|-----------|
//							^					^				^
//							|					|				|
//							v					v				v
//		|-----------|	|-----------|		|-----------|	|-----------|
//		| etc...	|	| etc...	| <---> | etc...	|	| etc...	|
//		|-----------|	|-----------|		|-----------|	|-----------|
//
// This pretty much illustrates the layout of how endpoints/globals and
// instances work. The endpoint has a single member, m_pipes, which contains
// a pointer to a global pipe instance for the endpoint. There is only 1.
//
// When the creator of the endpoint begins operations (via beginEndpoint
// or during endpoint creation by specifying an open mode) the global
// pipe filter creates the IFilterGlobal of each filter specified in the
// stack. The IFilterGlobal provides for a storage area for the individual
// instance filters to store global data.
//
// By global data, we mean data specific to that operation, or instance
// of the endpoint, not truly global. But, it does provide a location to
// store data which will be shared amongst all filter instances.
//
// Next, when the creator of the endpoint call getPipe on the endpoint,
// which retrieves an interface with functions to call to perform actual
// operations against, the endpoint forwards this off to the IFilterGlobal
// pipe. The global pipe filter then determines if any pipes are available
// and if not, creates an pipe instance stack made up of the filters
// specified in the stack, linking and binding them all up. It then calls
// beginFilterInstance on each of them and binds them up with their global
// filter data as well. At this point, operations can begin against
// the pipe such as renderObject, writeTag, etc.
//
// Notes:
// * There are no linkages (up/down) pointers in the global data
// as they are kept in an array and don't need to call each up and down
// the stack.
//
// * The "pipe" filter driver at the top (and "bottom" filter driver)
// has validations to make sure that the pipe is used as it should, that
// double opens are not performed, that if the pipe is released with a
// pending open, it is closed, etc. These top and bottom filter drivers
// are automatically added to the filter stack an do not need to be
// specified in the buildPipeStack return.
//
// * Even though they are not shown, each filter instances has a pointer
// to its global filter (via this.pipe) and its endpoint (via this.endpoint)
//
// * By default, the filter instance gets a simple IServiceFilterGlobal
// ptr to it's global data. This is usually not sufficient due to the fact
// that the global data specific members are not accessible through that
// type of ptr. To obtain the correct type of ptr, to allow access to
// the global data, you must declare your own this.pipe, override the
// constructor and do a cast to the appropriate type. The global filter
// must also have a friend declaration for the instance filter class. You
// can see an example of the modifications required in the indexer filter
// driver.
//
//-------------------------------------------------------------------------

//-----------------------------------------------------------------------------
/// @details
///		Forward declare the pipe filter classes so we can bring them
///		into the engine::store name space
//-----------------------------------------------------------------------------
namespace engine::store {
namespace filter {
namespace pipe {
class IFilterGlobal;
class IFilterInstance;
}  // namespace pipe
namespace trace {
class IFilterInstance;
}
}  // namespace filter
}  // namespace engine::store

//-----------------------------------------------------------------------------
/// @details
///		Define our global types for the engine::store name space
//-----------------------------------------------------------------------------
namespace engine::store {
using Path = ap::file::Path;

//-------------------------------------------------------------------------
/// @details
///		Bring these into the engine::store name space. They are written
///		and act like normal filter drivers but they manage the underlying
///		pipes
//-------------------------------------------------------------------------
using IServiceFilterInstancePipe = engine::store::filter::pipe::IFilterInstance;
using IServierFilterGlobalPipe = engine::store::filter::pipe::IFilterGlobal;

//-------------------------------------------------------------------------
/// @details
///		Bring this into the engine::store name space. This is a wrapper
///		that can be applied to a filter instance to monitor its
///		input/output
//-------------------------------------------------------------------------
using IServiceTracerInstance = engine::store::filter::trace::IFilterInstance;

//-------------------------------------------------------------------------
/// @details
///		Forward declare our upper level classes - this live in the
///		engine::store name space
//-------------------------------------------------------------------------
struct IServiceConfig;
class IServiceEndpoint;
class IServiceFilterGlobal;
class IServiceFilterInstance;

//-------------------------------------------------------------------------
// The factories come back with a unique_ptr. These need to be moved
// into a shared ptr
//-------------------------------------------------------------------------
using ServiceEndpointPtr = Ptr<IServiceEndpoint>;
using ServiceGlobalPtr = Ptr<IServiceFilterGlobal>;
using ServiceInstancePtr = Ptr<IServiceFilterInstance>;

//-------------------------------------------------------------------------
// Define these so we can store the shared ptr inside the objects themselves
//-------------------------------------------------------------------------
using ServiceEndpointWeak = WeakPtr<IServiceEndpoint>;
using ServiceGlobalWeak = WeakPtr<IServiceFilterGlobal>;
using ServiceInstanceWeak = WeakPtr<IServiceFilterInstance>;
using ServicePipeWeak = WeakPtr<IServiceFilterInstancePipe>;

//-------------------------------------------------------------------------
// We pass shared_ptr around
//-------------------------------------------------------------------------
using ServiceEndpoint = SharedPtr<IServiceEndpoint>;
using ServiceGlobal = SharedPtr<IServiceFilterGlobal>;
using ServiceInstance = SharedPtr<IServiceFilterInstance>;
using ServicePipe = SharedPtr<IServiceFilterInstancePipe>;

//-------------------------------------------------------------------------
// Vectors holding our stacks
//-------------------------------------------------------------------------
using ServiceGlobalStack = std::vector<ServiceGlobal>;
using ServiceInstanceStack = std::vector<ServiceInstance>;
using ServiceInstanceStacks = std::vector<ServiceInstanceStack>;

//-------------------------------------------------------------------------
/// @details
///		What type of AVI is being processed
//-------------------------------------------------------------------------
APUTIL_DEFINE_ENUM(AVI_MODE, 0, 3, AUDIO = _begin, VIDEO, IMAGE);

//-------------------------------------------------------------------------
/// @details
///		AVI action being requested
//-------------------------------------------------------------------------
APUTIL_DEFINE_ENUM(AVI_ACTION, 0, 3, BEGIN = _begin, WRITE, END);

//-------------------------------------------------------------------------
/// @details
///		Define the open modes of an endpoint
//-------------------------------------------------------------------------
APUTIL_DEFINE_ENUM(OPEN_MODE, 0, 17, NONE = _begin, TARGET, SOURCE,
                   SOURCE_INDEX,

                   SCAN, CONFIG, INDEX, CLASSIFY, INSTANCE, CLASSIFY_FILE, HASH,
                   STAT, REMOVE, TRANSFORM, PIPELINE, PIPELINE_CONFIG);

//-------------------------------------------------------------------------
/// @details
///		Define the configured mode of the endpoint - this is what the
///		service comes configured as from the json task file
//-------------------------------------------------------------------------
APUTIL_DEFINE_ENUM(SERVICE_MODE, 0, 3, NONE = _begin, SOURCE, TARGET, NEITHER);

//-------------------------------------------------------------------------
/// @details
///		Define the disposition of an endpoint. This is how any operation
///		that instantiated the endpoint has declared it will be used
//-------------------------------------------------------------------------
APUTIL_DEFINE_ENUM(ENDPOINT_MODE, 0, 3, NONE = _begin, SOURCE, TARGET);

//-------------------------------------------------------------------------
/// @details
///		Define the types of parameters for packing/unpacking
//-------------------------------------------------------------------------
APUTIL_DEFINE_ENUM(PARAM_TYPE, 0, 3, NONE = 0, READONLY = 1, SECURE = 2);

//-------------------------------------------------------------------------
///	@details
///		Define the identifiers of our update behavior during export
//-------------------------------------------------------------------------
APUTIL_DEFINE_ENUM(EXPORT_UPDATE_BEHAVIOR, 0, 3, UNKNOWN = 0, SKIP = 1,
                   UPDATE = 2);

//-------------------------------------------------------------------------
/// @details
///		Define the pipeline trace levels:
///		NONE     = 0  No tracing
///		METADATA = 1  Trace enter/leave with lane and class type
///		SUMMARY  = 2  + data summaries (lengths, counts, types)
///		FULL     = 3  + full payload data (text content, etc)
//-------------------------------------------------------------------------
APUTIL_DEFINE_ENUM(PIPELINE_TRACE_LEVEL, 0, 4, NONE = 0, METADATA = 1,
                   SUMMARY = 2, FULL = 3);

//-------------------------------------------------------------------------
///	@details
///		Define the state of sync scan tokens
//-------------------------------------------------------------------------
APUTIL_DEFINE_ENUM(
    SYNC_SCAN_STATE, 0, 3,
    STATE = _begin,  // Tokens committed and ready for next sync scan.
    SCANNING,        // Sync scan started using committed tokens.
    SCANNED);        // Scan scan completed, new tokens not committed yet.

//-----------------------------------------------------------------------------
// This is the scope operator for lambda functions - all variables are
// included by reference
//-----------------------------------------------------------------------------
#define localfcn [&]
}  // namespace engine::store
