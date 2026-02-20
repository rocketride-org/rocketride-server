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

#include <engLib/eng.h>

#include <apLib/application/mainstub.ipp>

namespace ap::application {
    ErrorCode Main() {
		Error ccode;

		// NOTE: Temporary handle --verify option to workaround CI/CD failure (see OPS-6087)
		// TODO: Remove this once OPS-6087 is fixed.
		if (cmdline().argc() == 2 && cmdline().argv()[1] == "--verify"_tv)
            return engine::TaskEc::COMPLETED;

		// Init the engine
        ccode = engine::init();

		// Run it if we inited it
        if (!ccode)
            ccode = engine::task::Main();

		// Output the exit code
		if (engine::config::monitor()) {
			MONCCODE(exit, ccode);
		} else {
			std::string message = _ts(ccode);
			std::cout << "Error: " << message << std::endl;
		}

		// Deinit the engine
		engine::deinit();

		// Get the exit status
	    if (ccode)
            return engine::TaskEc::END_CODE_ERROR;
        else
            return engine::TaskEc::COMPLETED;
    }

}  // namespace ap::application
