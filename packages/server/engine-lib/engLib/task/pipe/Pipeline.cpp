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

namespace engine::task::pipeline {

//-----------------------------------------------------------------
//      A pipeline task is a special kind of task which can operate in multiple
//      mode based on the ["pipeline"] configuration option in the task info.
//
//      1) The first mode mode, the pipes mode, is when we get an input file
//      from the app to process. For every item of type "I", the processItem
//      function is called to process that item. This is just like any other
//      pipeline task, like instance or transform.
//
//      2) The second mode is direct mode. In this mode, we create the
//      source and target endpoints as normal, but instead of reading the
//      entries from the pipe, we start a scan on the source pipe and
//      directly pipe the items found over to the processItem function.
//      This way, there is no database or no input/output pipe files.
//
//      3) The third mode is the resident endpoint. This is where we
//      startup the source endpoint, call scan and it doesn't return until
//		it is time to exit the tasks
//
//      How do we know which mode we are in? In the classType in the
//      services definition. If in the classType, one of the classes is
//      catalog, we know that this is coming from a catalog driver,
//      which requires the app and the pipe files.
//-------------------------------------------------------------------------

//-------------------------------------------------------------------------
/// @details
///     This function is called when an endpoint scanner has found an
///		object to add or a container to add to the processing list
/// @param[in]  context
///     Context we are flushing
///	@param[in]	object
///		The object to write or container to process
//-------------------------------------------------------------------------
Error Task::ScanDirect::addScanObject(ScanContext &context, Entry &object,
                                      const Path &objectPath) noexcept {
    // Url of the object
    Url url;

    // Build the url
    if (auto ccode = Url::toUrl(scanProtocol, objectPath, url)) return ccode;

    // Set the url
    object.url(url);

    // Queue the item we found
    return m_pTask->queueItem(object);
}

//-----------------------------------------------------------------
///	@details
///		This is called when we are enumerating an input pipe
/// @param[in] line
///		The incoming line - json format
/// @param[in] parent
///		The current parent
//-----------------------------------------------------------------
ErrorOr<Entry> Task::processLine(TextView line, const Url &parent) noexcept {
    // Process for I*{...} lines
    return Parent::processLine("I"_tv, line, parent);
}

//-----------------------------------------------------------------
/// @details
///		Process the enry
/// @param[in] entry
///		The entry to copy
//-----------------------------------------------------------------
Error Task::processItem(Entry &entry) noexcept {
    Error ccode;

    // Allocate/release the source pipe
    ErrorOr<ServicePipe> sourcePipe;
    util::Guard pipes{[&] { sourcePipe = m_sourceEndpoint->getPipe(); },
                      [&] {
                          if (sourcePipe)
                              m_sourceEndpoint->putPipe(*sourcePipe);
                      }};

    // Get a source pipe
    if (!sourcePipe) return sourcePipe.ccode();

    // If this doesn't have an object id (and it won't in DIRECT mode)
    // create one. It will be in the NAME_SPACE_URL namespace
    if (!entry.objectId) {
        // Get the url, it will have a unique path
        std::string &url = static_cast<std::string &>(entry.url());

        // Define the namespace (Boost equivalent of `uuid.NAMESPACE_URL`)
        boost::uuids::uuid namespace_uuid = boost::uuids::string_generator()(
            "6ba7b811-9dad-11d1-80b4-00c04fd430c8");  // UUID for URLs
                                                      // (NAMESPACE_URL)

        // Generate a UUID based on the file path using UUIDv5 (SHA-1 hash of
        // namespace + name)
        boost::uuids::name_generator_sha1 uuid5_gen(namespace_uuid);
        boost::uuids::uuid objectUuid = uuid5_gen(url);

        std::string objectId = boost::uuids::to_string(objectUuid);
        entry.objectId(objectId);
    }

    // Start/stop the counters
    util::Guard entryScope{[&] { MONITOR(beginObject, entry); },
                           [&] { MONITOR(endObject, entry); }};

    // Process the item -- calls renderObject
    if (ccode = Parent::processItem(entry, *sourcePipe))
        entry.completionCode(ccode);

    // write it to the monitor
    // If we failed or not...
    if (entry.objectFailed()) {
        // Add the path to the error code
        auto wrappedError = wrapError(entry, entry.completionCode());

        // Report the error to the monitor and log it
        LOGT(wrappedError);

        if (auto &monitor = config::monitor())
            monitor->warning(_mv(wrappedError));

        // Add it to the failed
        MONITOR(addFailed, 1, entry.size());
    } else {
        // Add it to the completed
        MONITOR(addCompleted, 1, entry.size());
    }

    // Based on the mode
    switch (m_mode) {
        case PIPELINE_MODE::CATALOG: {
            // We need to write to the output pipe whether we failed or not
            // If we failed or not...
            if (entry.objectFailed()) {
                // Write the error
                ccode =
                    Parent::writeError(entry, entry.completionCode()) || ccode;
            } else {
                // Write the result
                ccode = Parent::writeResult('I', entry) || ccode;
            }
            break;
        }

        case PIPELINE_MODE::DIRECT: {
            // Only catalog mode wants a results file
            break;
        }
    }

    // And done
    return ccode;
}

//-----------------------------------------------------------------
/// @details
///		Setup the operation
//-----------------------------------------------------------------
Error Task::beginTask() noexcept {
    // On a pipeline task, everything is stored in the config.pipeline
    // key, including the source. We have some work to do here to set
    // things up...

    // Setup the parameters
    if (auto ccode = taskConfig().lookupAssign("threadCount", m_threadCount))
        return ccode;

    // Make it valid
    if (m_threadCount < 1 || m_threadCount > 64) m_threadCount = 4;

    // Get the pipeline information
    pipelineConfig().setRoot(taskConfig());

    // Verify the pipeline information
    if (auto ccode = pipelineConfig().validate()) return ccode;

    // Decode the pipeline information
    if (auto ccode = pipelineConfig().decrypt()) return ccode;

    // Find the provider of this source
    auto provider = pipelineConfig().source().lookup<Text>("provider");

    // Get the service definitions provideo
    auto res = IServices::getServiceDefinition(provider);
    if (!res) return res.ccode();
    auto providerDefinition = *res;

    // Determine the mode we will be running in
    //      1) CATALOG mode
    //          Tradional input/output pipes, run the objects through the pipes
    //          and we are done
    //      2) DIRECT mode
    //          Connect the scanObjects function to the renderObject function.
    //          For
    //			a dynamic endpoint like webhook, it is still direct but the scan
    //			function will not return until the webhook is to be terminated
    if (providerDefinition->capabilities &
        url::UrlConfig::PROTOCOL_CAPS::CATALOG) {
        // We are in catalog mode, the endpoint is actually contained in the
        // config of the catalog source
        m_mode = PIPELINE_MODE::CATALOG;
    } else {
        // NOTE: The direct pipelined mode was designed as a 'no state'
        // workflow,
        //       and it is unclear how 'sync' endpoints, which consecutive scans
        //       depend on each other by delta tokens stored in the keystore,
        //       should behave. For now, let's just enable them.
        // if (providerDefinition->capabilities &
        // url::UrlConfig::PROTOCOL_CAPS::SYNC)
        //     return APERR(Ec::InvalidParam, "Sync endpoints must be used
        //     within a catalog");

        // In this mode we need to issue a scan and pipe those objects found
        // directly into the target via renderObject
        m_mode = PIPELINE_MODE::DIRECT;
    }

    // Get the debug request
    auto debug = pipelineConfig().root().lookup<bool>("debug", false);
    // Output running to the console
    MONITOR(status, "Processing");

    // Get an endpoint
    if (!(m_sourceEndpoint = IServiceEndpoint::getSourceEndpoint(
              {.jobConfig = jobConfig(),
               .taskConfig = taskConfig(),
               .serviceConfig = pipelineConfig().sourceConfig(),
               .openMode = OPEN_MODE::SOURCE})))
        return m_sourceEndpoint.ccode();

    // Get an endpoint - this should be the null driver
    if (!(m_targetEndpoint = IServiceEndpoint::getTargetEndpoint(
              {.jobConfig = jobConfig(),
               .taskConfig = taskConfig(),
               .serviceConfig = pipelineConfig().targetConfig(),
               .openMode = OPEN_MODE::PIPELINE,
               .debug = debug})))
        return m_targetEndpoint.ccode();

    // Set the target endpoint into the source so python can get it
    m_sourceEndpoint->target = *m_targetEndpoint;

    // And do the parent setup
    auto ccode = Parent::beginTask();

    return ccode;
}

//-----------------------------------------------------------------
/// @details
///		Fill the queue with entries to process
//-----------------------------------------------------------------
Error Task::enumInput() noexcept {
    Error ccode;

    // Set the service monitor to true - we are ready (well almost ready)
    MONITOR(service, true);

    switch (m_mode) {
        case PIPELINE_MODE::CATALOG: {
            // This is standard input/output pipe stuff, just
            // let the default do it
            ccode = Parent::enumInput();
            break;
        }

        case PIPELINE_MODE::DIRECT: {
            // Set the containg pipeline task
            if (auto ccode = m_scanner.setPipelineTask(this)) return ccode;

            // Get our endpoint
            auto endpoint = *m_sourceEndpoint;

            // We hook up the output of the scan objects to the
            // input of the pipe
            ccode = m_scanner.scan(endpoint);
            break;
        }
    }

    return ccode;
}

//-----------------------------------------------------------------
/// @details
///		Setup the operation
//-----------------------------------------------------------------
Error Task::endTask() noexcept {
    MONITOR(service, false);

    // Call the parent
    auto ccode = Parent::endTask();

    // And done
    return ccode;
}

//-----------------------------------------------------------------
/// @details
///		Execute the task
//-----------------------------------------------------------------
Error Task::exec() noexcept { return Parent::exec(); }

}  // namespace engine::task::pipeline
