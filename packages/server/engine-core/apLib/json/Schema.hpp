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

namespace ap::json {

// Makes a json schema from a list of args and names, each arg should be
// followed by a name, e.g.
//
//	struct MyThing {
//		Text val1 = "frodo";
//		int val2 = 1;
//		Size val3 = 1_mb;
//
//		auto __jsonSchema() const noexcept {
//			return json::makeSchema(val1, "val1", val2, "val2", val3, "val3");
//		}
//	};
template <typename... Args>
inline auto makeSchema(Args&&... args) noexcept {
    static_assert(sizeof...(args) % 2 == 0,
                  "Invalid json schema argument list");

    // Step 1 make a tuple of all the args
    auto bundle = makeTuple(std::forward_as_tuple<Args>(args)...);

    // Step 2 split odds and evens out, odds are the names, evens are the values
    auto values = util::tuple::justEvens(bundle);
    auto names = util::tuple::justOdds(bundle);

    // Now return a pair
    return makePair<>(_mv(values), _mv(names));
}

}  // namespace ap::json