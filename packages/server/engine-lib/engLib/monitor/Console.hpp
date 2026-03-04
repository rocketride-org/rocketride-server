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
// The console monitor is instantiated when a user is monitorng the engine
// from the console
//
// This derives from monitor and provides the virtual functions to actually
// output the status. The Monitor class is the common code between the
// App and Console classes
//-------------------------------------------------------------------------
class Console : public Monitor {
public:
    //-----------------------------------------------------------------
    //	Factory info
    //-----------------------------------------------------------------
    using Monitor::Monitor;
    _const auto Factory = Factory::makeFactory<Console, Monitor>("Console");

    //-----------------------------------------------------------------
    ///	@details
    ///		Output a warning message to the console
    ///	@param[in]
    ///		Error code to output
    //-----------------------------------------------------------------
    virtual Error warning(Error&& ccode) noexcept override {
        auto mon = ccode;
        Monitor::warning(_mv(mon));

        return outputWarningOrError("Warning:", _mv(ccode));
    }

    //-----------------------------------------------------------------
    /// @details
    ///   Output dependency installation status as structured JSON
    /// @param[in] data
    ///   JSON object describing the current status
    //-----------------------------------------------------------------
    virtual void dependencyDownload(const json::Value& data) noexcept override {
        auto str = data.stringify(false);
        Monitor::dependencyDownload(data);

        LOGL(Lvl::ServicePython, _location, _ts("DependencyDownload: ", str));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output an error message to the console
    ///	@param[in]
    ///		Error code to output
    //-----------------------------------------------------------------
    virtual Error error(Error&& ccode) noexcept override {
        auto mon = ccode;
        Monitor::error(_mv(mon));

        return outputWarningOrError("Error:", _mv(ccode));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output the exit code
    ///	@param[in]
    ///		Error code to output
    //-----------------------------------------------------------------
    virtual Error exit(Error&& ccode) noexcept override {
        auto mon = ccode;
        Monitor::exit(_mv(mon));

        // If this has already been called once, bail
        if (m_exitCalled.exchange(true)) return ccode;

        // If we are not supposed to show it, done
        if (!engine::monitor::getShowExitCode()) return ccode;

        // Only show it if error
        if (ccode)
            return outputWarningOrError("Exit:", _mv(ccode));
        else
            return APERR(TaskEc::COMPLETED, ccode.location());
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output the crash dump file name
    ///	@param[in]	location
    ///		Location where the call occured
    ///	@param[in]	path
    ///		Path to the crash dump file
    //-----------------------------------------------------------------
    void onCrashDumpCreated(Location location,
                            const file::Path& path) noexcept override {
        Monitor::onCrashDumpCreated(location, path);

        // Only report the dump name-- the directory is configured by the app
        LOGL(Lvl::Always, location, "{}", _ts("\r", Color::Red, path));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output the json info
    ///	@param[in]	info
    ///		Info to output
    //-----------------------------------------------------------------
    void info(const json::Value& info) noexcept override {
        Monitor::info(info);

        // Use an empty format specifier as the first argument to force
        // the log API not to treat the braces in the JSON format specifiers
        LOGL(Lvl::Always, _location, "{}",
             _ts(Color::Yellow, "Info: ", info.stringify(true)));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output the json metrics info
    ///	@param[in]	info
    ///		Info to output
    //-----------------------------------------------------------------
    virtual void metrics(const json::Value& metrics) noexcept override {
        Monitor::metrics(metrics);

        LOGL(Lvl::Always, _location, "{}",
             _ts(Color::Yellow, "Info: ", metrics.stringify(true)));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output the current status
    ///	@param[in]	status
    ///		The status info
    //-----------------------------------------------------------------
    virtual void status(TextView status) noexcept override {
        Monitor::status(status);

        LOGL(Lvl::Always, _location, status);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output the service status
    ///	@param[in]	upDown
    ///		The status info
    //-----------------------------------------------------------------
    virtual void service(bool status) noexcept override {
        Monitor::service(status);

        LOGL(Lvl::Always, _location, status ? "Service up" : "Service down");
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output with any key - must be formatted by the caller
    ///	@param[in]	param
    ///		The info to outut
    //-----------------------------------------------------------------
    virtual void other(TextView key, TextView param) noexcept override {
        Monitor::other(key, param);

        LOGL(Lvl::Always, _location, param);
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

        LOGL(Lvl::Always, _location, Color::Cyan, object, Color::Reset, size);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output the counts
    ///	@param[in]
    ///		The counts to output
    //-----------------------------------------------------------------
    virtual void updateMonitor() noexcept override {
        // Lock this
        auto guard = lock();

        // If the counts have been updated
        if (haveCountsBeenUpdated() || hasObjectBeenUpdated()) {
            // Get the counts
            Text counts;
            counts = _ts(Color::Yellow, this);

            // Get the current object
            Text object;
            if (auto obj = currentObject())
                object = _ts(Color::Cyan, obj->path, Color::Yellow, " [",
                             obj->size, "]");

            // And reset the flag
            resetCountsUpdated();
            resetObjectUpdated();

            LOGL(Lvl::Always, _location, "\r{} {}", counts, object);
        }
    }

private:
    //-----------------------------------------------------------------
    ///	@details
    ///		Format an error or warning, and output
    ///	@param[in]	tag
    ///		The tag to output
    ///	@param[in]	error
    ///		The error/warning to output
    //-----------------------------------------------------------------
    Error outputWarningOrError(TextView tag, Error&& ccode) noexcept {
        LOGL(Lvl::Always, ccode.location(), _ts(Color::Red, tag, " ", ccode));
        return _mv(ccode);
    }
};

};  // namespace engine::monitor
