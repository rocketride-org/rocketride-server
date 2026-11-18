// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// SPECS THAT NEED THE REAL ENGINE OR THE SAAS EXTENSION (not run by this suite yet)
// =============================================================================
// The e2e server runs the engine's Python web stack with the native modules
// stubbed (support/../server/native_stubs.py). Three specs of plan section 5.4
// need more than that, so they are listed here as `fixme` (visible in every
// report) rather than written against something that cannot run:
//
//   T95  X10 (B3): the app builds `pk_` candidates from everything it receives and
//        the harness tries each against `rrext_process`. `pk_` is the SaaS
//        extension's task credential (`generate_token`); the OSS account has none,
//        and the fixture team-deploy chat pipeline is a SaaS deploy. Needs the
//        SaaS extension overlay (`--saas`) and a team-owned chat pipeline.
//   T97  L2: execute -> owned status and flow events -> final status -> terminate.
//        `execute` starts an engine subprocess (`sys.executable ai/node.py`), which
//        is the native `engine` binary. Needs the packaged engine (the CI build
//        artifact `server-artifacts-<platform>`) and a pipeline of built-in nodes.
//   T103 N1 e2e: port messages during a real chat run carry no credential, real
//        project id, real task id, userId value or team field. Same needs as T97,
//        plus a chat pipeline that answers without an external model.
// =============================================================================

import { test } from '../support/harness';

test.describe('needs the real engine (CI only)', () => {
	test.fixme('T95 X10: no pk_ candidate built from anything the app received authenticates (needs the SaaS extension)', async () => {});
	test.fixme('T97 L2: execute, owned status and flow events, final status, terminate (needs the engine binary)', async () => {});
	test.fixme('T103 N1: no credential, real id or team field in the port messages of a real chat run (needs the engine binary)', async () => {});
});
