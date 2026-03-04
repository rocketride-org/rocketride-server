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

#pragma once

namespace engine::store {
//-------------------------------------------------------------------------
///	@details
///		Defines the generic structure we use to keep the service
///		configuration information in that is used by the endpoints, the
///		filters, etc. This is setup by endpoint.config.cpp as part
/// 	of the endpoint creation
//-------------------------------------------------------------------------
struct IServiceConfig {
    using Path = ap::file::Path;

    //-----------------------------------------------------------------
    ///	@details
    ///		The filter/pipe level
    //-----------------------------------------------------------------
    Dword level = 0;

    //-----------------------------------------------------------------
    ///	@details
    ///		The name from the UI
    //-----------------------------------------------------------------
    Text name;

    //-----------------------------------------------------------------
    ///	@details
    ///		The unique user for this service
    //-----------------------------------------------------------------
    Text key;

    //-----------------------------------------------------------------
    ///	@details
    ///		Logical type of endpoint (filesys, aws, smb,
    //		ms-onedrive, etc)
    //-----------------------------------------------------------------
    Text logicalType;

    //-----------------------------------------------------------------
    ///	@details
    ///		Physical type of endpoint (filesys, aws, smb, python, etc)
    //-----------------------------------------------------------------
    Text physicalType;

    //-----------------------------------------------------------------
    ///	@details
    ///		Type of endpoint (file://, aws://, smb://, etc)
    //-----------------------------------------------------------------
    Text protocol;

    //-----------------------------------------------------------------
    /// @details
    ///		Keep track of whether what aspect this endpoint is in,
    ///		source or target. We cannot rely on the service definition
    ///		since a target can actually be a source as well
    //-----------------------------------------------------------------
    ENDPOINT_MODE endpointMode = ENDPOINT_MODE::NONE;

    //-----------------------------------------------------------------
    ///	@details
    ///		The is the mode that the service definition actually
    ///		declares
    //-----------------------------------------------------------------
    SERVICE_MODE serviceMode = SERVICE_MODE::NONE;

    //-----------------------------------------------------------------
    /// @details
    ///		Keep track of whether we are open or not and what type of
    ///		operational pipe stack we created
    //-----------------------------------------------------------------
    OPEN_MODE openMode = OPEN_MODE::NONE;

    //-----------------------------------------------------------------
    ///	@details
    ///		The size of each segment
    //-----------------------------------------------------------------
    Dword segmentSize = (Dword)5_mb;

    //-----------------------------------------------------------------
    ///	@details
    ///		The name where the storage base is to be read/written by
    ///		an endpoint. For example if this is set to C:\data, then
    ///		objects will be stored there
    //-----------------------------------------------------------------
    Path storePath;

    //-----------------------------------------------------------------
    ///	@details
    ///		When recovering in native mode, the common target path is
    ///		used to remove components off the source before appending
    ///		it to storePath
    //-----------------------------------------------------------------
    Path commonTargetPath;

    //-----------------------------------------------------------------
    ///	@details
    ///		The name of the update behavior when doing export
    //-----------------------------------------------------------------
    Text exportUpdateBehaviorName;

    //-----------------------------------------------------------------
    ///	@details
    ///		The stream format
    //-----------------------------------------------------------------
    EXPORT_UPDATE_BEHAVIOR exportUpdateBehavior =
        EXPORT_UPDATE_BEHAVIOR::UNKNOWN;

    //-----------------------------------------------------------------
    ///	@details
    ///		The entire set of parameters given to the job
    //-----------------------------------------------------------------
    json::Value jobConfig;

    //-----------------------------------------------------------------
    ///	@details
    ///		The set of parameters for the task (the job.config) section
    //-----------------------------------------------------------------
    json::Value taskConfig;

    //-----------------------------------------------------------------
    ///	@details
    ///		The set of parameters for the service
    //-----------------------------------------------------------------
    json::Value serviceConfig;

    //-----------------------------------------------------------------
    ///	@details
    ///		Saved copy of the raw services key
    //-----------------------------------------------------------------
    json::Value originalServiceConfig;

    //-----------------------------------------------------------------
    ///	@details
    ///		The set of parameters for the service
    //-----------------------------------------------------------------
    json::Value parameters;

    //-----------------------------------------------------------------
    /// @details
    ///		Parsed configuration containing host, etc
    //-----------------------------------------------------------------
    file::smb::Share shareConfig;

    //-----------------------------------------------------------------
    /// @details
    ///		The pipeline configuration wrapper for the endpoint
    ///		service configuration.
    //-----------------------------------------------------------------
    pipeline::PipelineConfig pipeline;

    bool flatten = false;

    //-----------------------------------------------------------------
    /// @details
    ///		Pipeline trace level
    //-----------------------------------------------------------------
    PIPELINE_TRACE_LEVEL pipelineTraceLevel = PIPELINE_TRACE_LEVEL::NONE;
};
}  // namespace engine::store
