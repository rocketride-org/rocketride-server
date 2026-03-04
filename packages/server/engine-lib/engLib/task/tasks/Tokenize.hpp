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

namespace engine::task::tokenize {
//-------------------------------------------------------------------------
/// @details
///		Defines the tokenize task which takes a series of words or
///		phrases and tokenizes them for preparing the queryPlan
//-------------------------------------------------------------------------
class Task : public ITask {
public:
    using Parent = ITask;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		Define our log level
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::JobTokenize;

    //-----------------------------------------------------------------
    ///	@details
    ///		Define our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<Task, ITask>("tokenize");

protected:
    //-----------------------------------------------------------------
    ///	@details
    ///		Execute the task - send results over the >INFO channel
    //-----------------------------------------------------------------
    Error exec() noexcept override {
        // Grab the words/phrases to tokenize
        std::map<Text, std::vector<Text>> phrases;
        bool stripSymbolsAndWhitespace = true;

        if (auto ccode = taskConfig().lookupAssign("words", phrases) ||
                         taskConfig().lookupAssign("stripSymbolsAndWhitespace",
                                                   stripSymbolsAndWhitespace))
            return ccode;

        // Setup the monitor
        MONITOR(status,
                string::format("Tokenizing {} string(s)", phrases.size()));

        // Determine our strip mode
        SymbolAndWhitespaceMode mode = SymbolAndWhitespaceMode::KEEP;
        if (stripSymbolsAndWhitespace) mode = SymbolAndWhitespaceMode::STRIP;

        // Get a normalizer
        auto normalizer =
            string::icu::getNormalizer(string::icu::NormalizationForm::NFC);
        if (!normalizer)
            return APERRT(normalizer.ccode(),
                          "Unable to get normalizer instance");

        // Setup the results and a token iterator
        std::map<Text, std::vector<Text>> results;
        TextTokenIter<> ti;

        // Normalized text if we need it
        ErrorOr<Text> normalized;

        // Walk throgu the phrases
        for (auto [phrase, ignored] : phrases) {
            // Do a check to see if we even need to normalize it (most likely)
            if (normalizer->isNormalized(phrase)) {
                // Nope, send it is as
                ti.setText(TextView{phrase}, mode);
            } else {
                // Attempt to normalize it
                normalized = normalizer->normalize(phrase);

                // If we couldn't just write it out as is
                if (!normalized)
                    ti.setText(TextView{phrase}, mode);
                else
                    ti.setText(TextView{*normalized}, mode);
            }

            // Look through the results
            auto &tokens = results[phrase];
            while (auto token = ti.next()) {
                // Normalize linefeeds to spaces
                if (token.length() == 1 &&
                    string::isVerticalSpace(token.front())) {
                    tokens.emplace_back(" ");
                    continue;
                }

                // Save it
                tokens.emplace_back(token);
            }
        }

        MONITOR(info, "words", _tj(results));
        return {};
    }
};
}  // namespace engine::task::tokenize
