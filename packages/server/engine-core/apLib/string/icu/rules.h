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

#pragma once

namespace ap::string::icu {

// This is the base word rule for iterating word boundaries with the
// icu break iterator. Its copied from the default rule set used with
// the default word instance break iterator. This structure defines
// sections and provides a way to render it into a rule string the break
// iterator can consume on construction. This being a base rule it cannot
// be used on its own and it requires a specialization on top of it.
struct BaseRules {
private:
    // Chain section, where custom rules can be added to
    _const auto Chains = R"(
		!!chain;
	)"_tv;

    // Quoted literal section provides the fundamental word boundary rules
    _const auto QuotedLiterals = R"(
		!!quoted_literals_only;
		$CR = [\p{Word_Break = CR}];
		$LF = [\p{Word_Break = LF}];
		$Newline = [\p{Word_Break = Newline} ];
		$Extend = [\p{Word_Break = Extend}];
		$ZWJ = [\p{Word_Break = ZWJ}];
		$Regional_Indicator = [\p{Word_Break = Regional_Indicator}];
		$Format = [\p{Word_Break = Format}];
		$Katakana = [\p{Word_Break = Katakana}];
		$Hebrew_Letter = [\p{Word_Break = Hebrew_Letter}];
		$ALetter = [\p{Word_Break = ALetter}];
		$Single_Quote = [\p{Word_Break = Single_Quote}];
		$Double_Quote = [\p{Word_Break = Double_Quote}];
		$MidNumLet = [\p{Word_Break = MidNumLet}];
		$MidLetter = [\p{Word_Break = MidLetter}];
		$MidNum = [\p{Word_Break = MidNum}];
		$Numeric = [\p{Word_Break = Numeric}];
		$ExtendNumLet = [\p{Word_Break = ExtendNumLet}];
		$E_Base = [\p{Word_Break = EB}];
		$E_Modifier = [\p{Word_Break = EM}];
		$Extended_Pict = [\U0001F774-\U0001F77F\U00002700-\U00002701\U00002703-\U00002704\U0000270E\U00002710-\U00002711\U00002765-\U00002767\U0001F030-\U0001F093\U0001F094-\U0001F09F\U0001F10D-\U0001F10F\U0001F12F\U0001F16C-\U0001F16F\U0001F1AD-\U0001F1E5\U0001F260-\U0001F265\U0001F203-\U0001F20F\U0001F23C-\U0001F23F\U0001F249-\U0001F24F\U0001F252-\U0001F25F\U0001F266-\U0001F2FF\U0001F7D5-\U0001F7FF\U0001F000-\U0001F003\U0001F005-\U0001F02B\U0001F02C-\U0001F02F\U0001F322-\U0001F323\U0001F394-\U0001F395\U0001F398\U0001F39C-\U0001F39D\U0001F3F1-\U0001F3F2\U0001F3F6\U0001F4FE\U0001F53E-\U0001F548\U0001F54F\U0001F568-\U0001F56E\U0001F571-\U0001F572\U0001F57B-\U0001F586\U0001F588-\U0001F589\U0001F58E-\U0001F58F\U0001F591-\U0001F594\U0001F597-\U0001F5A3\U0001F5A6-\U0001F5A7\U0001F5A9-\U0001F5B0\U0001F5B3-\U0001F5BB\U0001F5BD-\U0001F5C1\U0001F5C5-\U0001F5D0\U0001F5D4-\U0001F5DB\U0001F5DF-\U0001F5E0\U0001F5E2\U0001F5E4-\U0001F5E7\U0001F5E9-\U0001F5EE\U0001F5F0-\U0001F5F2\U0001F5F4-\U0001F5F9\U00002605\U00002607-\U0000260D\U0000260F-\U00002610\U00002612\U00002616-\U00002617\U00002619-\U0000261C\U0000261E-\U0000261F\U00002621\U00002624-\U00002625\U00002627-\U00002629\U0000262B-\U0000262D\U00002630-\U00002637\U0000263B-\U00002647\U00002654-\U0000265F\U00002661-\U00002662\U00002664\U00002667\U00002669-\U0000267A\U0000267C-\U0000267E\U00002680-\U00002691\U00002695\U00002698\U0000269A\U0000269D-\U0000269F\U000026A2-\U000026A9\U000026AC-\U000026AF\U000026B2-\U000026BC\U000026BF-\U000026C3\U000026C6-\U000026C7\U000026C9-\U000026CD\U000026D0\U000026D2\U000026D5-\U000026E8\U000026EB-\U000026EF\U000026F6\U000026FB-\U000026FC\U000026FE-\U000026FF\U00002388\U0001FA00-\U0001FFFD\U0001F0A0-\U0001F0AE\U0001F0B1-\U0001F0BF\U0001F0C1-\U0001F0CF\U0001F0D1-\U0001F0F5\U0001F0AF-\U0001F0B0\U0001F0C0\U0001F0D0\U0001F0F6-\U0001F0FF\U0001F80C-\U0001F80F\U0001F848-\U0001F84F\U0001F85A-\U0001F85F\U0001F888-\U0001F88F\U0001F8AE-\U0001F8FF\U0001F900-\U0001F90B\U0001F91F\U0001F928-\U0001F92F\U0001F931-\U0001F932\U0001F94C\U0001F95F-\U0001F96B\U0001F992-\U0001F997\U0001F9D0-\U0001F9E6\U0001F90C-\U0001F90F\U0001F93F\U0001F94D-\U0001F94F\U0001F96C-\U0001F97F\U0001F998-\U0001F9BF\U0001F9C1-\U0001F9CF\U0001F9E7-\U0001F9FF\U0001F6C6-\U0001F6CA\U0001F6D3-\U0001F6D4\U0001F6E6-\U0001F6E8\U0001F6EA\U0001F6F1-\U0001F6F2\U0001F6F7-\U0001F6F8\U0001F6D5-\U0001F6DF\U0001F6ED-\U0001F6EF\U0001F6F9-\U0001F6FF];
		$EBG = [\p{Word_Break = EBG}];
		$EmojiNRK = [[\p{Emoji}] - [\p{Word_Break = Regional_Indicator}\u002a\u00230-9ÃƒÂ¢Ã¢â‚¬ÂÃ‚Â¬ÃƒÂ¢Ã…â€™Ã‚ÂÃƒÂ¢Ã¢â‚¬ÂÃ‚Â¬Ãƒâ€šÃ‚Â«ÃƒÅ½Ã¢â‚¬Å“ÃƒÆ’Ã‚Â¤ÃƒÆ’Ã‚Â³ÃƒÂÃ¢â€šÂ¬ÃƒÆ’Ã¢â‚¬Â¡ÃƒÂ¢Ã¢â‚¬â€œÃ¢â‚¬ËœÃƒÂÃ¢â€šÂ¬ÃƒÆ’Ã¢â‚¬Â¡ÃƒÂ¢Ã¢â‚¬Â¢Ã…â€œ]];
		$Han = [:Han:];
		$Hiragana = [:Hiragana:];
		$Control = [\p{Grapheme_Cluster_Break = Control}]; $HangulSyllable = [\uac00-\ud7a3];
		$ComplexContext = [:LineBreak = Complex_Context:];
		$KanaKanji = [$Han $Hiragana $Katakana];
		$dictionaryCJK = [$KanaKanji $HangulSyllable];
		$dictionary = [$ComplexContext $dictionaryCJK];
		$ALetterPlus = [$ALetter-$dictionaryCJK [$ComplexContext-$Extend-$Control]];
		$KatakanaEx = $Katakana ($Extend | $Format | $ZWJ)*;
		$Hebrew_LetterEx = $Hebrew_Letter ($Extend | $Format | $ZWJ)*;
		$ALetterEx = $ALetterPlus ($Extend | $Format | $ZWJ)*;
		$Single_QuoteEx = $Single_Quote ($Extend | $Format | $ZWJ)*;
		$Double_QuoteEx = $Double_Quote ($Extend | $Format | $ZWJ)*;
		$MidNumLetEx = $MidNumLet ($Extend | $Format | $ZWJ)*;
		$MidLetterEx = $MidLetter ($Extend | $Format | $ZWJ)*;
		$MidNumEx = $MidNum ($Extend | $Format | $ZWJ)*;
		$NumericEx = $Numeric ($Extend | $Format | $ZWJ)*;
		$ExtendNumLetEx = $ExtendNumLet ($Extend | $Format | $ZWJ)*;
		$Regional_IndicatorEx = $Regional_Indicator ($Extend | $Format | $ZWJ)*;
		$Ideographic = [\p{Ideographic}];
		$HiraganaEx = $Hiragana ($Extend | $Format | $ZWJ)*;
		$IdeographicEx = $Ideographic ($Extend | $Format | $ZWJ)*;
	)"_tv;

    // Forwards are where things get defined, for custom rules we can
    // define custom status codes for the rules that got matched
    _const auto Forwards = R"(
		!!forward;
		$CR $LF;
		$ZWJ ($Extended_Pict | $EmojiNRK);
		[^$CR $LF $Newline]? ($Extend | $Format | $ZWJ)+;
		$NumericEx {100};
		$ALetterEx {200};
		$HangulSyllable {200};
		$Hebrew_LetterEx{200};
		$KatakanaEx {400}; $HiraganaEx {400}; $IdeographicEx {400}; $E_Base ($Extend | $Format | $ZWJ)*;
		$E_Modifier ($Extend | $Format | $ZWJ)*;
		$Extended_Pict ($Extend | $Format | $ZWJ)*;
		($ALetterEx | $Hebrew_LetterEx) ($ALetterEx | $Hebrew_LetterEx) {200};
		($ALetterEx | $Hebrew_LetterEx) ($MidLetterEx | $MidNumLetEx | $Single_QuoteEx) ($ALetterEx | $Hebrew_LetterEx) {200};
		$Hebrew_LetterEx $Single_QuoteEx {200};
		$Hebrew_LetterEx $Double_QuoteEx $Hebrew_LetterEx {200};
		$NumericEx $NumericEx {100};
		($ALetterEx | $Hebrew_LetterEx) $NumericEx {200};
		$NumericEx ($ALetterEx | $Hebrew_LetterEx) {200};
		$NumericEx ($MidNumEx | $MidNumLetEx | $Single_QuoteEx) $NumericEx {100};
		$KatakanaEx $KatakanaEx {400};
		$ALetterEx $ExtendNumLetEx {200}; $Hebrew_LetterEx $ExtendNumLetEx {200}; $NumericEx $ExtendNumLetEx {100}; $KatakanaEx $ExtendNumLetEx {400}; $ExtendNumLetEx $ExtendNumLetEx {200}; $ExtendNumLetEx $ALetterEx {200}; $ExtendNumLetEx $Hebrew_Letter {200}; $ExtendNumLetEx $NumericEx {100}; $ExtendNumLetEx $KatakanaEx {400}; ($E_Base | $EBG) ($Format | $Extend | $ZWJ)* $E_Modifier;
		^$Regional_IndicatorEx $Regional_IndicatorEx;
		$HangulSyllable $HangulSyllable {200};
		$KanaKanji $KanaKanji {400}; .;
	)"_tv;

    // Safe reverse is part of the built in word boundary logic
    _const auto SafeReverse = R"(
		!!safe_reverse;
		($Extend | $Format | $ZWJ)+ .?;
		($MidLetter | $MidNumLet | $Single_Quote) ($Format | $Extend | $ZWJ)* ($Hebrew_Letter | $ALetterPlus);
		$Double_Quote ($Format | $Extend | $ZWJ)* $Hebrew_Letter;
		($MidNum | $MidNumLet | $Single_Quote) ($Format | $Extend | $ZWJ)* $Numeric;
		$Regional_Indicator ($Format | $Extend | $ZWJ)* $Regional_Indicator;
		$dictionary $dictionary;
	)"_tv;

protected:
    // Render this base rule as a complete rule string with the callers
    // custom chains and forwards to be layered into this base definition
    static Text render(TextView userChains = {},
                       TextView userForwards = {}) noexcept {
        return _ts(Chains, userChains, QuotedLiterals, Forwards, userForwards,
                   SafeReverse);
    }

public:
    // Core status definitions, used with getRuleStatus api on the break
    // iterator, each definition here map to a forward definition
    _const int STATUS_NONE = UWordBreak::UBRK_WORD_NONE;
    _const int STATUS_NONE_MAX = UWordBreak::UBRK_WORD_NONE_LIMIT;
    _const int STATUS_NUMBER = UWordBreak::UBRK_WORD_NUMBER;
    _const int STATUS_NUMBER_MAX = UWordBreak::UBRK_WORD_NUMBER_LIMIT;
    _const int STATUS_LETTER = UWordBreak::UBRK_WORD_LETTER;
    _const int STATUS_LETTER_MAX = UWordBreak::UBRK_WORD_LETTER_LIMIT;
    _const int STATUS_KANA = UWordBreak::UBRK_WORD_KANA;
    _const int STATUS_KANA_MAX = UWordBreak::UBRK_WORD_KANA_LIMIT;
    _const int STATUS_IDEO = UWordBreak::UBRK_WORD_IDEO;
    _const int STATUS_IDEO_MAX = UWordBreak::UBRK_WORD_IDEO_LIMIT;

    // Renders a status integer to its string name, used for logging
    static TextView renderStatus(int status) noexcept {
        if (status >= STATUS_NONE && status < STATUS_NONE_MAX)
            return "STATUS_NONE";
        if (status >= STATUS_NUMBER && status < STATUS_NUMBER_MAX)
            return "STATUS_NUMBER";
        if (status >= STATUS_LETTER && status < STATUS_LETTER_MAX)
            return "STATUS_LETTER";
        if (status >= STATUS_KANA && status < STATUS_KANA_MAX)
            return "STATUS_KANA";
        if (status >= STATUS_IDEO && status < STATUS_IDEO_MAX)
            return "STATUS_IDEO";
        return "STATUS_INVALID";
    }

    // Pack hook for _ts macros to convert this rule to a string for
    // passing to the icu break iterator
    template <typename Buffer>
    static void __toString(Buffer& buff) noexcept {
        buff << render();
    }
};

}  // namespace ap::string::icu
