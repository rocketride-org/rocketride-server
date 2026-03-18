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
bool setShowExitCode(bool showCode) noexcept;
bool getShowExitCode() noexcept;

//-------------------------------------------------------------------------
/// @details
///		The monitor interface is what all monitor instantiations derive from
///		it allows for polymorphic monitors, mostly allowing unit testing
///		of job flow
//-------------------------------------------------------------------------
class Monitor : public Counts {
public:
    using Parent = Counts;
    using Parent::Parent;

    //-----------------------------------------------------------------
    //	Factory info
    //-----------------------------------------------------------------
    _const auto FactoryType = "Monitor";
    struct FactoryArgs {
        Text type;
    };

    //-----------------------------------------------------------------
    //	Constructor/destructor
    //-----------------------------------------------------------------
    Monitor(FactoryArgs args) noexcept : m_type(_mv(args.type)) {
        // To ensure we capture all cases of exit register our own handler to
        // call exit
        m_fatalitySlot = dev::registerFatalityHandler(
            _bind(&Monitor::onFatality, this, _1, _2));
    }
    virtual ~Monitor() noexcept {
        // Deregister our notification
        dev::deRegisterFatalityHandler(m_fatalitySlot);

        // Stop the monitor
        stopMonitor();
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Static factory hook called when someone does
    ///		Factory::make<Monitor>
    //-----------------------------------------------------------------
    static ErrorOr<Ptr<Monitor>> __factory(Location location,
                                           uint32_t requiredFlags,
                                           FactoryArgs args) noexcept {
        return Factory::find<Monitor>(location, requiredFlags, args.type, args);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Helper function to output named JSON object to
    ///		info (e.g. "{sysinfo: {...}}")
    //-----------------------------------------------------------------
    void info(TextView name, const json::Value &object) noexcept {
        ASSERT(!name.empty());
        json::Value json;
        json[name] = object;
        info(json);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Retrieve the info we stored
    //-----------------------------------------------------------------
    json::Value &info() { return m_info; }

    //-----------------------------------------------------------------
    ///	@details
    ///		Retrieve the info we stored
    //-----------------------------------------------------------------
    json::Value &metrics() { return m_metrics; }

    //-----------------------------------------------------------------
    ///	@details
    ///		Retrieve our saved errors
    //-----------------------------------------------------------------
    std::vector<Error> &errors() { return m_errors; }

    //-----------------------------------------------------------------
    ///	@details
    ///		Retrieve our saved warnings
    //-----------------------------------------------------------------
    std::vector<Error> &warnings() { return m_warnings; }

    //-----------------------------------------------------------------
    ///	@details
    ///		Return the type of console
    //-----------------------------------------------------------------
    TextView type() const noexcept { return m_type; }

    //-------------------------------------------------------------
    /// @details
    ///		Reset all the counts
    //-------------------------------------------------------------
    void reset() noexcept {
        Parent::reset();
        m_warnings.clear();
        m_errors.clear();
        m_info = {};
        m_metrics = {};
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Templated type to help efficiently render stuff. Be very
    ///		careful with this one. The original code marked this as
    ///		do not use with JSON, however it was used with JSON. The
    ///		main problem is the '{ "value": {} }', the { may be
    ///		misinterpreted by the formatter as insertion markers.
    ///	@param[in]	fmt
    ///		The format string with {} subs
    ///	@param[in]	...
    ///		Parameter arguments to format
    //-----------------------------------------------------------------
    template <typename... Args>
    void infoFmt(TextView fmt, Args &&...args) noexcept {
        auto infoMsg = _fmt(fmt, std::forward<Args>(args)...);
        auto val = json::parse(infoMsg);
        ASSERTD_MSG(val, "Failed to parse info object format", infoMsg);
        info(*val);
    }

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    virtual void startMonitor() noexcept;
    virtual void startCounters() noexcept;
    virtual Error warning(Error &&ccode) noexcept;
    virtual Error error(Error &&ccode) noexcept;
    virtual Error exit(Error &&ccode) noexcept;
    virtual void onCrashDumpCreated(Location location,
                                    const file::Path &path) noexcept;
    virtual void info(const json::Value &info) noexcept;
    virtual void metrics(const json::Value &metrics) noexcept;
    virtual void status(TextView status) noexcept;
    virtual void service(bool status) noexcept;
    virtual void other(TextView key, TextView param) noexcept;
    virtual void object(TextView object, uint64_t size) noexcept;
    virtual void dependencyDownload(const json::Value &data) noexcept;
    virtual void stopCounters() noexcept;
    virtual void stopMonitor() noexcept;
    virtual bool isAppMonitor() noexcept;

    //-----------------------------------------------------------------
    /// This must be implemented in derived classes
    //-----------------------------------------------------------------
protected:
    virtual void updateMonitor() noexcept = 0;

protected:
    //-----------------------------------------------------------------
    ///	@details
    ///		Fatal error handler
    ///	@param[in]	location
    ///		Where it happened
    ///	@param[in]	msg
    ///		Message to output
    //-----------------------------------------------------------------
    void onFatality(Location location, std::string_view msg) noexcept {
        exit(APERR(Ec::Fatality, msg));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Flag to indicate we have output the >EXIT code
    //-----------------------------------------------------------------
    Atomic<bool> m_exitCalled{};

private:
    //-----------------------------------------------------------------
    // Private API
    //-----------------------------------------------------------------
    void updateProcess() noexcept;

    //-----------------------------------------------------------------
    ///	@details
    ///		The saved type from our factory
    //-----------------------------------------------------------------
    Text m_type;

    //-----------------------------------------------------------------
    ///	@details
    ///		Save area for last info set
    //-----------------------------------------------------------------
    json::Value m_info;

    //-----------------------------------------------------------------
    ///	@details
    ///		Save area for last metrics set
    //-----------------------------------------------------------------
    json::Value m_metrics;

    //-----------------------------------------------------------------
    ///	@details
    ///		Save area for the first 25 warnings we accumulated
    //-----------------------------------------------------------------
    std::vector<Error> m_warnings;

    //-----------------------------------------------------------------
    ///	@details
    ///		Save area for the first 25 errors we accumulated
    //-----------------------------------------------------------------
    std::vector<Error> m_errors;

    //-----------------------------------------------------------------
    ///	@details
    ///		The slot where we have registered a fatal error handler
    //-----------------------------------------------------------------
    size_t m_fatalitySlot{};

    //-------------------------------------------------------------
    /// @details
    ///		Have we started yet?
    //-------------------------------------------------------------
    bool m_started = {};

    //-------------------------------------------------------------
    /// @details
    ///		Are we stopping?
    //-------------------------------------------------------------
    bool m_stopping = {};

    //-------------------------------------------------------------
    /// @details
    ///		thisis the thread that is going to do the auto updates
    //-------------------------------------------------------------
    Opt<async::Thread> m_updateThread;

    //-------------------------------------------------------------
    /// @details
    ///		We only update the monitor every so often when an
    ///		add is reported, the timestamp helps us do that
    //-------------------------------------------------------------
    time::PreciseStamp m_lastUpdate = time::now();
};
};  // namespace engine::monitor
