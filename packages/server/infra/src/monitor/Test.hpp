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
// The console monitor is instantiated when a user is monitoring the engine
// from the unit tester. This is pretty much the same as console
// but does inhibits outputting of info and formats lines for the
// loading spaces
//-------------------------------------------------------------------------
class TestConsole : public Console {
public:
    //-----------------------------------------------------------------
    //	Factory info
    //-----------------------------------------------------------------
    using Console::Console;
    _const auto Factory =
        Factory::makeFactory<TestConsole, Monitor>("TestConsole");

    //-----------------------------------------------------------------
    ///	@details
    ///		Output the json info
    ///	@param[in]	info
    ///		Info to output
    //-----------------------------------------------------------------
    void info(const json::Value &info) noexcept override {
        Monitor::info(info);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Output the current status
    ///	@param[in]	status
    ///		The status info
    //-----------------------------------------------------------------
    virtual void status(TextView status) noexcept override {
        Monitor::status(status);

        LOGL(Lvl::Always, _location, "    \r", status);
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

        LOGL(Lvl::Always, _location, "    \r", Color::Cyan, object,
             Color::Reset, size);
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
        Text counts;
        if (haveCountsBeenUpdated()) {
            // Output the counts
            counts = _ts(Color::Yellow, this);

            // And reset the flag
            resetCountsUpdated();
        }

        // If the object has been updated
        Text object;
        if (hasObjectBeenUpdated()) {
            // Output the current object
            if (auto obj = currentObject())
                object = _ts(Color::Cyan, obj->path, Color::Yellow, " [",
                             obj->size, "]");

            // Reset the flag
            resetObjectUpdated();
        }

        if (counts || object)
            LOGL(Lvl::Always, _location, "    \r{} {}", counts, object);
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
    Error outputWarningOrError(TextView tag, Error &&ccode) noexcept {
        LOGL(Lvl::Always, ccode.location(), _ts(Color::Red, tag, " ", ccode));
        return _mv(ccode);
    }
};

};  // namespace engine::monitor
