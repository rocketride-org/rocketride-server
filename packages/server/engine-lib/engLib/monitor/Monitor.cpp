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

namespace engine::monitor {
//-------------------------------------------------------------------------
/// @details
///		Called to update the monitor
///	@param[in]	force
///		Force an update even if the timer has not expired
//-------------------------------------------------------------------------
void Monitor::updateProcess() noexcept {
    while (!async::cancelled()) {
        // See if it is time to update
        async::sleep(100ms);

        // If it is not time to update...
        if (time::now() - m_lastUpdate < 2.5s) continue;

        // If we are still active, Update the counts and current object if
        // needed
        if (m_started) updateMonitor();

        // Set the last update time
        m_lastUpdate = time::now();
    }

    // Done
    return;
}

//-------------------------------------------------------------------------
/// @details
///		Start the monitor
//-------------------------------------------------------------------------
void Monitor::startMonitor() noexcept {
    // Error on multiple starts - should not happen
    ASSERT(!m_started);

    // Create the thread
    m_updateThread = async::Thread{_location, "Status",
                                   _bind(&Monitor::updateProcess, this)};

    // And start it
    m_updateThread->start();

    // Say we re started
    m_started = true;
}

//-------------------------------------------------------------------------
/// @details
///		Start the counters
//-------------------------------------------------------------------------
void Monitor::startCounters() noexcept { Parent::startCounters(); }

//-----------------------------------------------------------------
///	@details
///		Output a warning message to the console
///	@param[in]
///		Error code to output
//-----------------------------------------------------------------
Error Monitor::warning(Error&& ccode) noexcept {
    // Lock this
    auto guard = lock();

    if (m_warnings.size() < 25) m_warnings.emplace_back(_mv(ccode));
    return ccode;
}

//-----------------------------------------------------------------
///	@details
///		Output an error message to the console
///	@param[in]
///		Error code to output
//-----------------------------------------------------------------
Error Monitor::error(Error&& ccode) noexcept {
    // Lock this
    auto guard = lock();

    if (m_errors.size() < 25) m_errors.emplace_back(_mv(ccode));
    return ccode;
}

//-----------------------------------------------------------------
///	@details
///		Output the exit code
///	@param[in]
///		Error code to output
//-----------------------------------------------------------------
Error Monitor::exit(Error&& ccode) noexcept { return ccode; }

//-----------------------------------------------------------------
///	@details
///		Output the crash dump file name
///	@param[in]	location
///		Location where the call occured
///	@param[in]	path
///		Path to the crash dump file
//-----------------------------------------------------------------
void Monitor::onCrashDumpCreated(Location location,
                                 const file::Path& path) noexcept {
    return;
}

//-----------------------------------------------------------------
///	@details
///		Output the json info
///	@param[in]	info
///		Info to output
//-----------------------------------------------------------------
void Monitor::info(const json::Value& info) noexcept {
    // Lock this
    auto guard = lock();

    m_info = info;
}

//-----------------------------------------------------------------
///	@details
///		Output the json info
///	@param[in]	info
///		Info to output
//-----------------------------------------------------------------
void Monitor::metrics(const json::Value& metrics) noexcept {
    // Lock this
    auto guard = lock();

    m_metrics = metrics;
}

//-----------------------------------------------------------------
///	@details
///		Output the current status
///	@param[in]	status
///		The status info
//-----------------------------------------------------------------
void Monitor::status(TextView status) noexcept {}

//-----------------------------------------------------------------
///	@details
///		Output the current service status up/down
///	@param[in]	status
///		The status info
//-----------------------------------------------------------------
void Monitor::service(bool status) noexcept {}

//-----------------------------------------------------------------
///	@details
///		Output with any key - must be formatted by the caller
///	@param[in]	param
///		The info to outut
//-----------------------------------------------------------------
void Monitor::other(TextView key, TextView param) noexcept {}

//-----------------------------------------------------------------
///	@details
///		Output an object - this is used to output an object and when
///		not using the begin/endObject interface
///	@param[in]	status
///		The status info
//-----------------------------------------------------------------
void Monitor::object(TextView object, uint64_t size) noexcept {}

//-------------------------------------------------------------------------
/// @details
///		Determines if this is an --monitor=app. App.hpp overrides
///		this
//-------------------------------------------------------------------------
bool Monitor::isAppMonitor() noexcept { return false; }

//-----------------------------------------------------------------
///	@details
///		Output an object from Dependency Download - this is used to output an
///object
///	@param[in]	status
///		The status info
//-----------------------------------------------------------------
void Monitor::dependencyDownload(const json::Value& data) noexcept {
    // No-op base implementation
}

//-------------------------------------------------------------------------
/// @details
///		Stops the counters and does a final count flush if they have
/// 	changed
//-------------------------------------------------------------------------
void Monitor::stopCounters() noexcept {
    // Call the parent
    Parent::stopCounters();

    // Output any stragglers
    updateMonitor();
}

//-------------------------------------------------------------------------
/// @details
///		Stop the monitor
//-------------------------------------------------------------------------
void Monitor::stopMonitor() noexcept {
    // If not started, done
    if (!m_started) return;

    // Say we are not started so the processing thread can see it
    m_started = false;

    // If we started the update thread
    if (m_updateThread) {
        // Stop it
        m_updateThread->cancel();

        // Join the thread
        m_updateThread->join();

        // Remove the thread
        m_updateThread.reset();
    }

    // Say we are not started
    m_started = false;

    // Output completion info
    // LOGT("Completed {} in {}", this, m_status.elapsed());
    // LOGT("Total count: {}, size: {}",
    //      MONITOR(completed).count,
    //      MONITOR(completed).size);

    // LOGTT(Perf, "Scan completed in {}", time::now() - start);
}
}  // namespace engine::monitor
