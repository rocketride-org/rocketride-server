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

namespace engine::task::classifyFiles {
//-------------------------------------------------------------------------
/// @details
///		Defines the classification test task which takes a series of
///		files and classifies them
//-------------------------------------------------------------------------
class Task : public ITask {
public:
    using Parent = ITask;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		Define our log level
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::JobClassifyFiles;

    //-----------------------------------------------------------------
    ///	@details
    ///		Define our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<Task, ITask>("classifyFiles");

protected:
    //-----------------------------------------------------------------
    ///	@details
    ///		Create the results for the given file
    ///	@param[in] path
    ///		The file path being classified
    //-----------------------------------------------------------------
    static json::Value createResult(const file::Path &path) noexcept {
        json::Value result;
        result["file"] = _ts(path);
        return result;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Add the results of the file to the results set
    ///	@param[in] value
    ///		The results from the classification
    //-----------------------------------------------------------------
    void addResult(json::Value &value) noexcept {
        m_results.emplace_back(_mv(value));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Indicate failure to classify to the result set
    ///	@param[in] path
    ///		The file path being classified
    ///	@param[in] ccode
    ///		The failure code
    //-----------------------------------------------------------------
    void addFailure(const file::Path &path, const Error &ccode) noexcept {
        MONERR(error, ccode, path);

        auto result = createResult(path);
        result["error"] = _tso(Format::NO_COLORS, ccode);
        addResult(result);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Report the results to the monitor
    //-----------------------------------------------------------------
    void reportResults() noexcept {
        json::Value results;
        results["results"] = _tj(m_results);
        MONITOR(info, results);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Execute the task - send results over the >INFO channel
    //-----------------------------------------------------------------
    Error classifyFile(Path &path) noexcept {
        Error ccode;

        // Get the url
        Url url;
        if (auto ccode = Url::toUrl(
                engine::store::filter::filesys::filesys::Type, path, url))
            return ccode;

        // Make an entry from the url
        Entry entry = Entry(url);
        entry.flags(Entry::FLAGS::CLASSIFY | Entry::FLAGS::OCR);

        // Size is required by parse filter. Do not fail if something wrong,
        // let underlying filter process the error.
        auto info = file::stat(path);
        if (info.hasValue()) entry.size(info->size);

        // Define the lambda to catch any errors
        const auto process = [&]() -> Error {
            // Allocate/release the source pipe
            ErrorOr<ServicePipe> sourcePipe;
            util::Guard sourcePipeGuard{
                [&] { sourcePipe = m_sourceEndpoint->getPipe(); },
                [&] {
                    if (sourcePipe) m_sourceEndpoint->putPipe(*sourcePipe);
                }};

            // Check to make sure we got it
            if (!sourcePipe) return sourcePipe.ccode();

            // Allocate/release the target pipe
            ErrorOr<ServicePipe> targetPipe;
            util::Guard targetPipeGuard{
                [&] { targetPipe = m_targetEndpoint->getPipe(); },
                [&] {
                    if (targetPipe) m_targetEndpoint->putPipe(*targetPipe);
                }};

            // Check to make sure we got it
            if (!targetPipe) return targetPipe.ccode();

            // Open on the target
            if (ccode = targetPipe->open(entry)) return ccode;

            // Render the object to the target
            if (ccode = sourcePipe->renderObject(*targetPipe, entry))
                return ccode;

            // Render the object to the target
            ccode = sourcePipe->renderObject(*targetPipe, entry);

            // Close the target pipe
            ccode = targetPipe->close() || ccode;

            return ccode;
        };

        // Copy it
        if (ccode = _callChk([&] { return process(); })) return ccode;

        // If the object failed....
        if (entry.objectFailed()) {
            // Log the completion code
            addFailure(path, entry.completionCode());
        } else {
            // Get the value
            json::Value classes = entry.classifications();

            // Save the path
            classes["file"] = (TextView)path;

            // Add the result
            addResult(classes);
        }

        // Done
        return {};
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Setup endpoints
    //-----------------------------------------------------------------
    Error beginTask() noexcept override {
        // Set the configuration for a dummy file system service
        json::Value filesysSource = R"(
                {
                    "type": "filesys",
                    "name": "Filesys endpoint",
                    "mode": "source",
                    "parameters": {}
                }
            )"_json;

        // Get a filesys source endpoint
        if (!(m_sourceEndpoint = IServiceEndpoint::getSourceEndpoint(
                  {.jobConfig = jobConfig(),
                   .taskConfig = taskConfig(),
                   .serviceConfig = filesysSource,
                   .openMode = OPEN_MODE::SOURCE})))
            return m_sourceEndpoint.ccode();

        // Get a null target endpoint
        if (!(m_targetEndpoint = IServiceEndpoint::getTargetEndpoint(
                  {.jobConfig = jobConfig(),
                   .taskConfig = taskConfig(),
                   .openMode = OPEN_MODE::CLASSIFY_FILE})))
            return m_targetEndpoint.ccode();

        return {};
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Execute the task - send results over the >INFO channel
    //-----------------------------------------------------------------
    Error exec() noexcept override {
        TextVector files;

        // Get the files to classify
        if (auto ccode = taskConfig().lookupAssign("files", files))
            return ccode;

        // Walk through the files
        for (auto &file : files) {
            // Build a path
            Path path{file};

            // Classify the file
            if (auto ccode = classifyFile(path)) return ccode;
        }

        // Report the results to the monitor
        reportResults();
        return {};
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Complete and release endpoints
    //-----------------------------------------------------------------
    Error endTask() noexcept override {
        Error ccode;

        // Close out the source endpoint if we have one
        if (m_sourceEndpoint) {
            if (auto endCode = m_sourceEndpoint->endEndpoint())
                ccode = APERRT(endCode, "Failed to end source endpoint");
            m_sourceEndpoint.reset();
        }

        // Close out the target endpoint if we have one
        if (m_targetEndpoint) {
            if (auto endCode = m_targetEndpoint->endEndpoint())
                ccode =
                    (ccode || APERRT(endCode, "Failed to end target endpoint"));
            m_targetEndpoint.reset();
        }

        return ccode;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		The open NULL endpoint with index filter driver on top
    ///		to intercept renderObject
    //-----------------------------------------------------------------
    ErrorOr<ServiceEndpoint> m_sourceEndpoint;

    //-----------------------------------------------------------------
    ///	@details
    ///		The NULL endpoint we send info to
    //-----------------------------------------------------------------
    ErrorOr<ServiceEndpoint> m_targetEndpoint;

    //-----------------------------------------------------------------
    ///	@details
    ///		The list of results we have built
    //-----------------------------------------------------------------
    std::vector<json::Value> m_results;
};
}  // namespace engine::task::classifyFiles
