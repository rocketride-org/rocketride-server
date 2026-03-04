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

#include <catch.hpp>
#include <engLib/eng.h>

//-----------------------------------------------------------------------------
// Bring in apTest's util.hpp under aptest::ap::test so it doesn't conflict
// with our engine::test namespace
//-----------------------------------------------------------------------------
namespace aptest {
using namespace ::ap;
#include "../../engine-core/test/test/util.hpp"
}  // namespace aptest

//-----------------------------------------------------------------------------
// Import that segregated namespace into ours
//-----------------------------------------------------------------------------
namespace engine::test {
using namespace aptest::ap::test;
}  // namespace engine::test

//-----------------------------------------------------------------------------
// Basic includes
//-----------------------------------------------------------------------------
#include "test/util.hpp"
#include "test/words.h"
#include "store/store.h"

//-----------------------------------------------------------------------------
// Include our namespaces
//-----------------------------------------------------------------------------
using namespace engine;
using namespace engine::test;
