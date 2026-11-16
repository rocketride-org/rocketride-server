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

namespace engine::monitor {
//-------------------------------------------------------------------------
// The app monitor is instantiated by the job system and allows for
// contextual status gathering across all our subsystems in a global context
// This derives from monitor and provides the virtual functions to actually
// output the status. The Monitor class is the common code between the
// App and Console classes
//-------------------------------------------------------------------------
class App : public Monitor {
    //-----------------------------------------------------------------
    ///	@details
    ///		Define the constant types we need to output
    //-----------------------------------------------------------------
    _const auto CountsTag = ">CNT"_tv;
    _const auto DumpTag = ">DUMP"_tv;
    _const auto ErrorTag = ">ERR"_tv;
    _const auto ExitTag = ">EXIT"_tv;
    _const auto InfoTag = ">INF"_tv;
    _const auto JobTag = ">JOB"_tv;
    _const auto ObjectTag = ">OBJ"_tv;
    _const auto WarningTag = ">WRN"_tv;
    _const auto MetricsTag = ">MET"_tv;
    _const auto ServiceTag = ">SVC"_tv;
    _const auto DependencyDownloadTag = ">DL"_tv;

public:
    //-----------------------------------------------------------------
    //	Factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<App, Monitor>("App");

    //-----------------------------------------------------------------
    //	Constructor/destructor
    //-----------------------------------------------------------------
    App(FactoryArgs args) noexcept : Monitor(_mv(args)) {
        log::options().disableAllColors = true;
        log::options().forceDecoration = false;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output a warning message to the console
    //-----------------------------------------------------------------
    virtual void startMonitor() noexcept override {
        // Now, stop the parent
        Monitor::startMonitor();
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output a warning message to the console
    ///	@param[in]
    ///		Error code to output
    //-----------------------------------------------------------------
    virtual Error warning(Error &&ccode) noexcept override {
        auto mon = ccode;
        Monitor::warning(_mv(mon));

        return outputWarningOrError(WarningTag, _mv(ccode));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output an error message to the console
    ///	@param[in]
    ///		Error code to output
    //-----------------------------------------------------------------
    virtual Error error(Error &&ccode) noexcept override {
        auto mon = ccode;
        Monitor::error(_mv(mon));

        return outputWarningOrError(ErrorTag, _mv(ccode));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output the exit code
    ///	@param[in]
    ///		Error code to output
    //-----------------------------------------------------------------
    virtual Error exit(Error &&ccode) noexcept override {
        auto mon = ccode;
        Monitor::exit(_mv(mon));

        // If this has already been called once, bail
        if (m_exitCalled.exchange(true)) return ccode;

        // If we are not supposed to show it, done
        if (!engine::monitor::getShowExitCode()) return ccode;

        // If there is an exist code, output it else output
        // just the exit success
        if (ccode)
            return outputWarningOrError(ExitTag, _mv(ccode));
        else
            return outputWarningOrError(
                ExitTag, APERR(TaskEc::COMPLETED, ccode.location()));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output the crash dump file name
    ///	@param[in]	location
    ///		Location where the call occured
    ///	@param[in]	path
    ///		Path to the crash dump file
    //-----------------------------------------------------------------
    virtual void onCrashDumpCreated(Location location,
                                    const file::Path &path) noexcept override {
        Monitor::onCrashDumpCreated(location, path);

        // Only report the dump name-- the directory is configured by the app
        outputTag(DumpTag, path.fileName());
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output the json info
    ///	@param[in]	info
    ///		Info to output
    //-----------------------------------------------------------------
    virtual void info(const json::Value &info) noexcept override {
        Monitor::info(info);

        outputTag(InfoTag, info.stringify(false));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output the json metrics info
    ///	@param[in]	info
    ///		Info to output
    //-----------------------------------------------------------------
    virtual void metrics(const json::Value &metrics) noexcept override {
        Monitor::metrics(metrics);

        outputTag(MetricsTag, metrics.stringify(false));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output the current status
    ///	@param[in]	status
    ///		The status info
    //-----------------------------------------------------------------
    virtual void status(TextView status) noexcept override {
        Monitor::status(status);

        outputTag(JobTag, status);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output the service status
    ///	@param[in]	upDown
    ///		The status info
    //-----------------------------------------------------------------
    virtual void service(bool status) noexcept override {
        Monitor::service(status);

        outputTag(ServiceTag, status ? "1" : "0");
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output with any key - must be formatted by the caller
    ///	@param[in]	param
    ///		The info to outut
    //-----------------------------------------------------------------
    virtual void other(TextView key, TextView param) noexcept override {
        Monitor::other(key, param);

        outputTag(">" + key, param);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output an object - this is used to output an object and when
    ///		not using the begin/endObject interface
    ///	@param[in]	status
    ///		The status info
    //-----------------------------------------------------------------
    virtual void object(TextView object, uint64_t size) noexcept override {
        Monitor::object(object, size);

        StackText res;
        _tsbo(res, {Format::HEX, {}, '*'}, size, object);
        outputTag(ObjectTag, res);
    }

    //-----------------------------------------------------------------
    /// @details
    ///   Output dependency installation status as structured JSON
    /// @param[in] data
    ///   JSON object describing the current status
    //-----------------------------------------------------------------
    virtual void dependencyDownload(const json::Value &data) noexcept override {
        Monitor::status(
            data.stringify(false));  // optional, saves for internal access
        outputTag(DependencyDownloadTag,
                  data.stringify(false));  // emits >DL*{...}
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Stop the monitor
    //-----------------------------------------------------------------
    virtual void stopMonitor() noexcept override {
        // Now, stop the monitor
        Monitor::stopMonitor();
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Say we are the app monitor
    //-----------------------------------------------------------------
    virtual bool isAppMonitor() noexcept override { return true; }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output the counts
    ///	@param[in]
    ///		Counts to output
    //-----------------------------------------------------------------
    virtual void updateMonitor() noexcept override {
        // Lock this
        auto guard = lock();

        // If the counts have been updated
        if (haveCountsBeenUpdated()) {
            StackText msg;

            // Format it
            _tsbo(msg, {Format::HEX, {}, '*'}, total().size, total().count,
                  completed().size, completed().count, failed().size,
                  failed().count, words().size, words().count,
                  _cast<uint64_t>(rate().rateSize * 100),
                  _cast<uint32_t>(rate().rateCount * 100));

            // Output it
            outputTag(CountsTag, msg);

            // And reset the flag
            resetCountsUpdated();
        }

        // If the object has been updated
        if (hasObjectBeenUpdated()) {
            // Get the "current" object
            const auto obj = currentObject();

            // If we got one, use the discrete object output function
            if (obj) object(obj->path, obj->size);

            // Reset the flag
            resetObjectUpdated();
        }
    }

private:
    //-----------------------------------------------------------------
    ///	@details
    ///		Output a tag and info
    ///	@param[in]	tag
    ///		The tag to output
    ///	@param[in]	message
    ///		The data message to output
    //-----------------------------------------------------------------
    void outputTag(TextView tag, TextView message) noexcept {
        log::write(FormatOptions{Format::HEX, {}, '*'}, _location, tag,
                   stripVerticalWhitespace(message));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Format an error or warning, and output
    ///	@param[in]	tag
    ///		The tag to output
    ///	@param[in]	error
    ///		The error/warning to output
    //-----------------------------------------------------------------
    Error outputWarningOrError(TextView tag, Error &&ccode) noexcept {
        StackText msg;

        // Get the root cause of why we are here
        auto &root = ccode.root();

        if (!ccode) {
            // If there is no error...
            _tsbo(msg, {Format::HEX, {}, '*'}, 0, "");
        } else if (root != ccode) {
            // If the error raiser code differs from the actual problem
            _tsbo(msg, {Format::HEX, {}, '*'}, root.code().message(),
                  ccode.message() + " Caused by: " + root.message(),
                  root.location());
        } else if (ccode.message()) {
            // If the error raiser has its own message, use it
            _tsbo(msg, {Format::HEX, {}, '*'}, ccode.code().message(),
                  ccode.message(), ccode.location());
        } else {
            // Use the root cause
            _tsbo(msg, {Format::HEX, {}, '*'}, root.code().message(),
                  root.message(), root.location());
        }

        // Format the output to >ERR or >WRN specs
        if (auto trace = ccode.trace(); trace)
            _tsbo(msg, Format::APPEND, '*', string::replace(trace, "\n", "*"));

        // Output the tag
        outputTag(tag, msg);
        return _mv(ccode);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Replace vertical whitespace with a space
    ///	@param[in]	string
    ///		The string to remove vertical white space from
    //-----------------------------------------------------------------
    Text stripVerticalWhitespace(TextView string) noexcept {
        Text stripped{string};
        std::replace_if(
            stripped.begin(), stripped.end(),
            [](auto ch) { return string::isVerticalSpace(ch); }, ' ');
        return stripped;
    }
};
};  // namespace engine::monitor
