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

#include "test.h"

using ResultVector = std::vector<std::string_view>;

TEST_CASE("string::StrView") {
    SECTION("find") {
        SECTION("(stl reference) find_first_of single character ") {
            REQUIRE("abcde"sv.find_first_of('a') == 0);
            REQUIRE("abcde"sv.find_first_of('b') == 1);
            REQUIRE("abcde"sv.find_first_of('c') == 2);
            REQUIRE("abcde"sv.find_first_of('d') == 3);
            REQUIRE("abcde"sv.find_first_of('e') == 4);
            REQUIRE("abcde"sv.find_first_of('f') == string::npos);
            REQUIRE(""sv.find_first_of('f') == string::npos);
            REQUIRE(""sv.find_first_of('\0') == string::npos);
        }

        SECTION("(stl reference) find_first_not_of single character") {
            REQUIRE("abcde"sv.find_first_not_of('a') == 1);
            REQUIRE("abcde"sv.find_first_not_of('b') == 0);
            REQUIRE("abcde"sv.find_first_not_of('c') == 0);
            REQUIRE("abcde"sv.find_first_not_of('d') == 0);
            REQUIRE("abcde"sv.find_first_not_of('e') == 0);
            REQUIRE("abcde"sv.find_first_not_of('f') == 0);
            REQUIRE("a"sv.find_first_not_of('a') == string::npos);
            REQUIRE(""sv.find_first_not_of('a') == string::npos);
            REQUIRE(""sv.find_first_not_of('\0') == string::npos);
        }

        SECTION("(stl reference) find_last_not_of single character") {
            REQUIRE("abcde"sv.find_last_not_of('a') == 4);
            REQUIRE("abcde"sv.find_last_not_of('b') == 4);
            REQUIRE("abcde"sv.find_last_not_of('c') == 4);
            REQUIRE("abcde"sv.find_last_not_of('d') == 4);
            REQUIRE("abcde"sv.find_last_not_of('e') == 3);
            REQUIRE("abcde"sv.find_last_not_of('f') == 4);
            REQUIRE("abcde"sv.find_last_not_of('f') == 4);
            REQUIRE("abcde"sv.find_last_not_of('f') == 4);
            REQUIRE("abcde"sv.find_last_not_of('\0') == 4);
            REQUIRE(""sv.find_last_not_of('\0') == string::npos);
            REQUIRE(""sv.find_last_not_of('f') == string::npos);
        }

        SECTION("find_first_of single character ") {
            REQUIRE("abcde"_tv.find_first_of('a') == 0);
            REQUIRE("abcde"_tv.find_first_of('b') == 1);
            REQUIRE("abcde"_tv.find_first_of('c') == 2);
            REQUIRE("abcde"_tv.find_first_of('d') == 3);
            REQUIRE("abcde"_tv.find_first_of('e') == 4);
            REQUIRE("abcde"_tv.find_first_of('f') == string::npos);
            REQUIRE(""_tv.find_first_of('f') == string::npos);
            REQUIRE(""_tv.find_first_of('\0') == string::npos);
        }

        SECTION("find_first_not_of single character") {
            REQUIRE("abcde"_tv.find_first_not_of('a') == 1);
            REQUIRE("abcde"_tv.find_first_not_of('b') == 0);
            REQUIRE("abcde"_tv.find_first_not_of('c') == 0);
            REQUIRE("abcde"_tv.find_first_not_of('d') == 0);
            REQUIRE("abcde"_tv.find_first_not_of('e') == 0);
            REQUIRE("abcde"_tv.find_first_not_of('f') == 0);
            REQUIRE("a"_tv.find_first_not_of('a') == string::npos);
            REQUIRE(""_tv.find_first_not_of('a') == string::npos);
            REQUIRE(""_tv.find_first_not_of('\0') == string::npos);
        }

        SECTION("find_last_not_of single character") {
            REQUIRE("abcde"_tv.find_last_not_of('a') == 4);
            REQUIRE("abcde"_tv.find_last_not_of('b') == 4);
            REQUIRE("abcde"_tv.find_last_not_of('c') == 4);
            REQUIRE("abcde"_tv.find_last_not_of('d') == 4);
            REQUIRE("abcde"_tv.find_last_not_of('e') == 3);
            REQUIRE("abcde"_tv.find_last_not_of('f') == 4);
            REQUIRE("abcde"_tv.find_last_not_of('f') == 4);
            REQUIRE("abcde"_tv.find_last_not_of('f') == 4);
            REQUIRE("abcde"_tv.find_last_not_of('\0') == 4);
            REQUIRE(""_tv.find_last_not_of('\0') == string::npos);
            REQUIRE(""_tv.find_last_not_of('f') == string::npos);
        }

        SECTION("(stl reference) find_first_of multi character ") {
            REQUIRE("abcde"sv.find_first_of("ab") == 0);
            REQUIRE("abcde"sv.find_first_of("bc") == 1);
            REQUIRE("abcde"sv.find_first_of("cd") == 2);
            REQUIRE("abcde"sv.find_first_of("de") == 3);
            REQUIRE("abcde"sv.find_first_of("ef") == 4);
            REQUIRE("abcde"sv.find_first_of("fg") == string::npos);
            REQUIRE("abcde"sv.find_first_of("gh") == string::npos);
            REQUIRE(""sv.find_first_of("gh") == string::npos);
            REQUIRE(""sv.find_first_of("") == string::npos);
        }

        SECTION("(stl reference) find_first_not_of multi character") {
            REQUIRE("abcde"sv.find_first_not_of("a") == 1);
            REQUIRE("abcde"sv.find_first_not_of("ab") == 2);
            REQUIRE("abcde"sv.find_first_not_of("bc") == 0);
            REQUIRE("abcde"sv.find_first_not_of("cd") == 0);
            REQUIRE("abcde"sv.find_first_not_of("de") == 0);
            REQUIRE("abcde"sv.find_first_not_of("ef") == 0);
            REQUIRE("abcde"sv.find_first_not_of("fg") == 0);
            REQUIRE("abcde"sv.find_first_not_of("gh") == 0);
            REQUIRE("abcde"sv.find_first_not_of("") == 0);
            REQUIRE("abcde"sv.find_first_not_of("abcde") == string::npos);
            REQUIRE(""sv.find_first_not_of("abcde") == string::npos);
            REQUIRE(""sv.find_first_not_of("") == string::npos);
        }

        SECTION("(stl reference) find_last_not_of multi character") {
            REQUIRE("abcde"sv.find_last_not_of("a") == 4);
            REQUIRE("abcde"sv.find_last_not_of("ab") == 4);
            REQUIRE("abcde"sv.find_last_not_of("bc") == 4);
            REQUIRE("abcde"sv.find_last_not_of("cd") == 4);
            REQUIRE("abcde"sv.find_last_not_of("de") == 2);
            REQUIRE("abcde"sv.find_last_not_of("ef") == 3);
            REQUIRE("abcde"sv.find_last_not_of("fg") == 4);
            REQUIRE("abcde"sv.find_last_not_of("gh") == 4);
            REQUIRE("abcde"sv.find_last_not_of("") == 4);
            REQUIRE("abcde"sv.find_last_not_of("abcde") == string::npos);
            REQUIRE(""sv.find_last_not_of("abcde") == string::npos);
            REQUIRE(""sv.find_last_not_of("") == string::npos);
        }

        SECTION("find_first_of multi character ") {
            REQUIRE("abcde"_tv.find_first_of("ab") == 0);
            REQUIRE("abcde"_tv.find_first_of("bc") == 1);
            REQUIRE("abcde"_tv.find_first_of("cd") == 2);
            REQUIRE("abcde"_tv.find_first_of("de") == 3);
            REQUIRE("abcde"_tv.find_first_of("ef") == 4);
            REQUIRE("abcde"_tv.find_first_of("fg") == string::npos);
            REQUIRE("abcde"_tv.find_first_of("gh") == string::npos);
            REQUIRE(""_tv.find_first_of("gh") == string::npos);
            REQUIRE(""_tv.find_first_of("") == string::npos);
        }

        SECTION("find_first_not_of multi character") {
            REQUIRE("abcde"_tv.find_first_not_of("a") == 1);
            REQUIRE("abcde"_tv.find_first_not_of("ab") == 2);
            REQUIRE("abcde"_tv.find_first_not_of("bc") == 0);
            REQUIRE("abcde"_tv.find_first_not_of("cd") == 0);
            REQUIRE("abcde"_tv.find_first_not_of("de") == 0);
            REQUIRE("abcde"_tv.find_first_not_of("ef") == 0);
            REQUIRE("abcde"_tv.find_first_not_of("fg") == 0);
            REQUIRE("abcde"_tv.find_first_not_of("gh") == 0);
            REQUIRE("abcde"_tv.find_first_not_of("") == 0);
            REQUIRE("abcde"_tv.find_first_not_of("abcde") == string::npos);
            REQUIRE(""_tv.find_first_not_of("abcde") == string::npos);
            REQUIRE(""_tv.find_first_not_of("") == string::npos);
        }

        SECTION("find_last_not_of multi character") {
            REQUIRE("abcde"_tv.find_last_not_of("a") == 4);
            REQUIRE("abcde"_tv.find_last_not_of("ab") == 4);
            REQUIRE("abcde"_tv.find_last_not_of("bc") == 4);
            REQUIRE("abcde"_tv.find_last_not_of("cd") == 4);
            REQUIRE("abcde"_tv.find_last_not_of("de") == 2);
            REQUIRE("abcde"_tv.find_last_not_of("ef") == 3);
            REQUIRE("abcde"_tv.find_last_not_of("fg") == 4);
            REQUIRE("abcde"_tv.find_last_not_of("gh") == 4);
            REQUIRE("abcde"_tv.find_last_not_of("") == 4);
            REQUIRE("abcde"_tv.find_last_not_of("abcde") == string::npos);
            REQUIRE(""_tv.find_last_not_of("abcde") == string::npos);
            REQUIRE(""_tv.find_last_not_of("") == string::npos);
        }
    }

    SECTION("tokenize") {
        using namespace string::view;

#if 0
		SECTION("Tokenize trim space delimiter") {
			auto result = _tr<ResultVector>(tokenizeTrim("A, B, C, D, EFGHIJKLMNOP"_tv, ' ', " "_tv));
			auto matched = result == ResultVector{ "A,", "B,", "C,", "D,", "EFGHIJKLMNOP" };
			REQUIRE(matched == true);
		}

		SECTION("Tokenize array no delimiter") {
			auto res = tokenizeArray<1>("A, B, C, D, EFGHIJKLMNOP"_tv, '\0');
			REQUIRE(res[0] == "A, B, C, D, EFGHIJKLMNOP");
		}

		SECTION("Tokenize it iter no trim") {
			auto result = _tr<ResultVector>(tokenize("A, B, C, D, EFGHIJKLMNOP"_tv, ','));
			auto iter = result.begin();
			REQUIRE(*iter++ == "A");
			REQUIRE(*iter++ == " B");
			REQUIRE(*iter++ == " C");
			REQUIRE(*iter++ == " D");
			REQUIRE(*iter++ == " EFGHIJKLMNOP");
		}

		SECTION("Tokenize it iter trim") {
			auto result = _tr<ResultVector>(tokenizeTrim("A, B, C, D, EFGHIJKLMNOP"_tv, ','));
			auto iter = result.begin();
			REQUIRE(*iter++ == "A");
			REQUIRE(*iter++ == "B");
			REQUIRE(*iter++ == "C");
			REQUIRE(*iter++ == "D");
			REQUIRE(*iter++ == "EFGHIJKLMNOP");
			REQUIRE(result == decltype(result){"A"sv});
		}
#endif

        SECTION("Tokenize enum") {
            auto result = tokenizeEnum<0, 5>("A = 4, B = 2, C = 1"_tv);
            REQUIRE(result[0] == "");
            REQUIRE(result[1] == "C");
            REQUIRE(result[2] == "B");
            REQUIRE(result[3] == "");
            REQUIRE(result[4] == "A");
        }

        SECTION("Constexpr tokenize enum") {
            auto result = tokenizeEnum<0, 5>("A = 4, B = 2, C = 1"_tv);
            REQUIRE(result[0] == "");
            REQUIRE(result[1] == "C");
            REQUIRE(result[2] == "B");
            REQUIRE(result[3] == "");
            REQUIRE(result[4] == "A");
        }

        SECTION("tokenize comma delimited array") {
            auto result = tokenizeArray<3>("1,2,3"_tv, ',');
            REQUIRE(result[0] == "1");
            REQUIRE(result[1] == "2");
            REQUIRE(result[2] == "3");
        }

        SECTION("Constexpr tokenize comma delimited array empty portions") {
            auto result = tokenizeArray<3>(",,3"_tv, ',');
            REQUIRE(result[0] == "");
            REQUIRE(result[1] == "");
            REQUIRE(result[2] == "3");
        }

        SECTION(
            "Constexpr tokenize comma delimited array empty portions, 1 "
            "comma") {
            auto result = tokenizeArray<3>(",2"_tv, ',');
            REQUIRE(result[0] == "");
            REQUIRE(result[1] == "2");
            REQUIRE(result[2] == "");
        }

        SECTION(
            "Constexpr tokenize comma delimited more fields then specifiers") {
            REQUIRE(tokenizeArray<1>("1,2,3,4,5,6"_tv, ',') ==
                    std::array{"1,2,3,4,5,6"_tv});
            REQUIRE(tokenizeArray<2>("1,2,3,4,5,6"_tv, ',') ==
                    std::array{"1"_tv, "2,3,4,5,6"_tv});
            REQUIRE(tokenizeArray<3>("1,2,3,4,5,6"_tv, ',') ==
                    std::array{"1"_tv, "2"_tv, "3,4,5,6"_tv});
        }

        SECTION("Split at position") {
            auto result = splitAtPosition("01234567890abc"_tv, 5);
            REQUIRE(result.left == "01234");
            REQUIRE(result.right == "67890abc");

            _const auto check = SplitResult<char>{"01234"_tv, "67890abc"_tv};
            REQUIRE(check == result);
        }

        SECTION("Split at token") {
            auto result = splitAtToken("01234567890abc"_tv, "789"_tv);
            REQUIRE(result.left == "0123456");
            REQUIRE(result.right == "0abc");

            _const auto check = SplitResult<char>{"0123456"_tv, "0abc"_tv};
            REQUIRE(check == result);
        }

        SECTION("Split at token") {
            auto result = splitAtToken("01234567890abc"_tv, "789"_tv);
            REQUIRE(result.left == "0123456");
            REQUIRE(result.right == "0abc");

            _const auto check = SplitResult<char>{"0123456"_tv, "0abc"_tv};
            REQUIRE(check == result);
        }

        SECTION("Log macro parsing") {
            auto rawEnumtr = APUTIL_MAKE_STR(
                ERROR = 1, VERBOSE, TRACE, STATS, DEBUG, TEST,

                IDATA = 8, IPROVIDER, INODE, ICHANNEL, IDICTIONARY, ICOMMAND,
                ICLASSIFY, DATABAS, DATABUF, DATACMP, DATARND, DATASQU, DATASTD,
                DATARET, DATADLT, DATAFLT, DATAENC, DATAWRM, DICTIONARY,
                NODEFILE,

                PROVIDERDATANET = 32, PROVIDERDATAFILE, PROVIDERDATADIR,
                PROVIDEROBJSTORE, PROVIDERAZURE, PROVIDERBACKBLAZE,

                OBJECT = 48, DATAFILE, DATANET, OBJSTORELOG, FILESYS, PATH,
                SOCKET, TEXT, DIFF, JOB, SNAP, PARSE, WORD, MATCH, AZURELOG,

                CLASSIFY = 64);

            auto result = tokenizeEnum<1, 256>(string::StrView{rawEnumtr});
            REQUIRE(result.size() == 256);
            REQUIRE(result[0] == "");
            REQUIRE(result[1] == "ERROR");
            REQUIRE(result[2] == "VERBOSE");
            REQUIRE(result[3] == "TRACE");
            REQUIRE(result[4] == "STATS");
            REQUIRE(result[5] == "DEBUG");
            REQUIRE(result[6] == "TEST");
            REQUIRE(result[7] == "");
            REQUIRE(result[8] == "IDATA");
            REQUIRE(result[9] == "IPROVIDER");
            REQUIRE(result[10] == "INODE");
            REQUIRE(result[11] == "ICHANNEL");
            REQUIRE(result[12] == "IDICTIONARY");
            REQUIRE(result[13] == "ICOMMAND");
            REQUIRE(result[14] == "ICLASSIFY");
            REQUIRE(result[15] == "DATABAS");
            REQUIRE(result[16] == "DATABUF");
            REQUIRE(result[17] == "DATACMP");
            REQUIRE(result[18] == "DATARND");
            REQUIRE(result[19] == "DATASQU");
            REQUIRE(result[20] == "DATASTD");
            REQUIRE(result[21] == "DATARET");
            REQUIRE(result[22] == "DATADLT");
            REQUIRE(result[23] == "DATAFLT");
            REQUIRE(result[24] == "DATAENC");
            REQUIRE(result[25] == "DATAWRM");
            REQUIRE(result[26] == "DICTIONARY");
            REQUIRE(result[27] == "NODEFILE");
            REQUIRE(result[28] == "");
            REQUIRE(result[29] == "");
            REQUIRE(result[30] == "");
            REQUIRE(result[31] == "");
            REQUIRE(result[32] == "PROVIDERDATANET");
            REQUIRE(result[33] == "PROVIDERDATAFILE");
            REQUIRE(result[34] == "PROVIDERDATADIR");
            REQUIRE(result[35] == "PROVIDEROBJSTORE");
            REQUIRE(result[36] == "PROVIDERAZURE");
            REQUIRE(result[37] == "PROVIDERBACKBLAZE");
            REQUIRE(result[38] == "");
            REQUIRE(result[39] == "");
            REQUIRE(result[40] == "");
            REQUIRE(result[41] == "");
            REQUIRE(result[42] == "");
            REQUIRE(result[43] == "");
            REQUIRE(result[44] == "");
            REQUIRE(result[45] == "");
            REQUIRE(result[46] == "");
            REQUIRE(result[47] == "");
            REQUIRE(result[48] == "OBJECT");
            REQUIRE(result[49] == "DATAFILE");
            REQUIRE(result[50] == "DATANET");
            REQUIRE(result[51] == "OBJSTORELOG");
            REQUIRE(result[52] == "FILESYS");
            REQUIRE(result[53] == "PATH");
            REQUIRE(result[54] == "SOCKET");
            REQUIRE(result[55] == "TEXT");
            REQUIRE(result[56] == "DIFF");
            REQUIRE(result[57] == "JOB");
            REQUIRE(result[58] == "SNAP");
            REQUIRE(result[59] == "PARSE");
            REQUIRE(result[60] == "WORD");
            REQUIRE(result[61] == "MATCH");
            REQUIRE(result[62] == "AZURELOG");
            REQUIRE(result[63] == "");
            REQUIRE(result[64] == "CLASSIFY");
            REQUIRE(result[65] == "");
            REQUIRE(result[66] == "");
            REQUIRE(result[67] == "");
            REQUIRE(result[68] == "");
            REQUIRE(result[69] == "");
            REQUIRE(result[70] == "");
            REQUIRE(result[71] == "");
            REQUIRE(result[72] == "");
            REQUIRE(result[73] == "");
            REQUIRE(result[74] == "");
            REQUIRE(result[75] == "");
            REQUIRE(result[76] == "");
            REQUIRE(result[77] == "");
            REQUIRE(result[78] == "");
            REQUIRE(result[79] == "");
            REQUIRE(result[80] == "");
            REQUIRE(result[81] == "");
            REQUIRE(result[82] == "");
            REQUIRE(result[83] == "");
            REQUIRE(result[84] == "");
            REQUIRE(result[85] == "");
            REQUIRE(result[86] == "");
            REQUIRE(result[87] == "");
            REQUIRE(result[88] == "");
            REQUIRE(result[89] == "");
            REQUIRE(result[90] == "");
            REQUIRE(result[91] == "");
            REQUIRE(result[92] == "");
            REQUIRE(result[93] == "");
            REQUIRE(result[94] == "");
            REQUIRE(result[95] == "");
            REQUIRE(result[96] == "");
            REQUIRE(result[97] == "");
            REQUIRE(result[98] == "");
            REQUIRE(result[99] == "");
            REQUIRE(result[100] == "");
            REQUIRE(result[101] == "");
            REQUIRE(result[102] == "");
            REQUIRE(result[103] == "");
            REQUIRE(result[104] == "");
            REQUIRE(result[105] == "");
            REQUIRE(result[106] == "");
            REQUIRE(result[107] == "");
            REQUIRE(result[108] == "");
            REQUIRE(result[109] == "");
            REQUIRE(result[110] == "");
            REQUIRE(result[111] == "");
            REQUIRE(result[112] == "");
            REQUIRE(result[113] == "");
            REQUIRE(result[114] == "");
            REQUIRE(result[115] == "");
            REQUIRE(result[116] == "");
            REQUIRE(result[117] == "");
            REQUIRE(result[118] == "");
            REQUIRE(result[119] == "");
            REQUIRE(result[120] == "");
            REQUIRE(result[121] == "");
            REQUIRE(result[122] == "");
            REQUIRE(result[123] == "");
            REQUIRE(result[124] == "");
            REQUIRE(result[125] == "");
            REQUIRE(result[126] == "");
            REQUIRE(result[127] == "");
            REQUIRE(result[128] == "");
            REQUIRE(result[129] == "");
            REQUIRE(result[130] == "");
            REQUIRE(result[131] == "");
            REQUIRE(result[132] == "");
            REQUIRE(result[133] == "");
            REQUIRE(result[134] == "");
            REQUIRE(result[135] == "");
            REQUIRE(result[136] == "");
            REQUIRE(result[137] == "");
            REQUIRE(result[138] == "");
            REQUIRE(result[139] == "");
            REQUIRE(result[140] == "");
            REQUIRE(result[141] == "");
            REQUIRE(result[142] == "");
            REQUIRE(result[143] == "");
            REQUIRE(result[144] == "");
            REQUIRE(result[145] == "");
            REQUIRE(result[146] == "");
            REQUIRE(result[147] == "");
            REQUIRE(result[148] == "");
            REQUIRE(result[149] == "");
            REQUIRE(result[150] == "");
            REQUIRE(result[151] == "");
            REQUIRE(result[152] == "");
            REQUIRE(result[153] == "");
            REQUIRE(result[154] == "");
            REQUIRE(result[155] == "");
            REQUIRE(result[156] == "");
            REQUIRE(result[157] == "");
            REQUIRE(result[158] == "");
            REQUIRE(result[159] == "");
            REQUIRE(result[160] == "");
            REQUIRE(result[161] == "");
            REQUIRE(result[162] == "");
            REQUIRE(result[163] == "");
            REQUIRE(result[164] == "");
            REQUIRE(result[165] == "");
            REQUIRE(result[166] == "");
            REQUIRE(result[167] == "");
            REQUIRE(result[168] == "");
            REQUIRE(result[169] == "");
            REQUIRE(result[170] == "");
            REQUIRE(result[171] == "");
            REQUIRE(result[172] == "");
            REQUIRE(result[173] == "");
            REQUIRE(result[174] == "");
            REQUIRE(result[175] == "");
            REQUIRE(result[176] == "");
            REQUIRE(result[177] == "");
            REQUIRE(result[178] == "");
            REQUIRE(result[179] == "");
            REQUIRE(result[180] == "");
            REQUIRE(result[181] == "");
            REQUIRE(result[182] == "");
            REQUIRE(result[183] == "");
            REQUIRE(result[184] == "");
            REQUIRE(result[185] == "");
            REQUIRE(result[186] == "");
            REQUIRE(result[187] == "");
            REQUIRE(result[188] == "");
            REQUIRE(result[189] == "");
            REQUIRE(result[190] == "");
            REQUIRE(result[191] == "");
            REQUIRE(result[192] == "");
            REQUIRE(result[193] == "");
            REQUIRE(result[194] == "");
            REQUIRE(result[195] == "");
            REQUIRE(result[196] == "");
            REQUIRE(result[197] == "");
            REQUIRE(result[198] == "");
            REQUIRE(result[199] == "");
            REQUIRE(result[200] == "");
            REQUIRE(result[201] == "");
            REQUIRE(result[202] == "");
            REQUIRE(result[203] == "");
            REQUIRE(result[204] == "");
            REQUIRE(result[205] == "");
            REQUIRE(result[206] == "");
            REQUIRE(result[207] == "");
            REQUIRE(result[208] == "");
            REQUIRE(result[209] == "");
            REQUIRE(result[210] == "");
            REQUIRE(result[211] == "");
            REQUIRE(result[212] == "");
            REQUIRE(result[213] == "");
            REQUIRE(result[214] == "");
            REQUIRE(result[215] == "");
            REQUIRE(result[216] == "");
            REQUIRE(result[217] == "");
            REQUIRE(result[218] == "");
            REQUIRE(result[219] == "");
            REQUIRE(result[220] == "");
            REQUIRE(result[221] == "");
            REQUIRE(result[222] == "");
            REQUIRE(result[223] == "");
            REQUIRE(result[224] == "");
            REQUIRE(result[225] == "");
            REQUIRE(result[226] == "");
            REQUIRE(result[227] == "");
            REQUIRE(result[228] == "");
            REQUIRE(result[229] == "");
            REQUIRE(result[230] == "");
            REQUIRE(result[231] == "");
            REQUIRE(result[232] == "");
            REQUIRE(result[233] == "");
            REQUIRE(result[234] == "");
            REQUIRE(result[235] == "");
            REQUIRE(result[236] == "");
            REQUIRE(result[237] == "");
            REQUIRE(result[238] == "");
            REQUIRE(result[239] == "");
            REQUIRE(result[240] == "");
            REQUIRE(result[241] == "");
            REQUIRE(result[242] == "");
            REQUIRE(result[243] == "");
            REQUIRE(result[244] == "");
            REQUIRE(result[245] == "");
            REQUIRE(result[246] == "");
            REQUIRE(result[247] == "");
            REQUIRE(result[248] == "");
            REQUIRE(result[249] == "");
            REQUIRE(result[250] == "");
            REQUIRE(result[251] == "");
            REQUIRE(result[252] == "");
            REQUIRE(result[253] == "");
            REQUIRE(result[254] == "");
            REQUIRE(result[255] == "");
        }
    }

    SECTION("Trim") {
        SECTION("trimLeading") {
            REQUIRE(TextView{"...txt"}.trimLeading(".") == "txt");
            REQUIRE(TextView{"...txt"}.trimLeading<Text>({'.'}) == "txt");
        }

        SECTION("trimTrailing") {
            REQUIRE(TextView{"...txt"}.trimTrailing("txt") == "...");
            REQUIRE(TextView{"...txt"}.trimTrailing<Text>({'t', 'x', 't'}) ==
                    "...");

            REQUIRE(TextView{"...txt"}.trimTrailing("TXT") == "...txt");
            REQUIRE(TextView{"...txt"}.trimTrailing<Text>({'T', 'X', 'T'}) ==
                    "...txt");
            REQUIRE(TextView{"...txt"}.trimTrailing("TXT", false) == "...");
            REQUIRE(TextView{"...txt"}.trimTrailing<Text>({'T', 'X', 'T'},
                                                          false) == "...");
        }
    }

    SECTION("Equality") {
        SECTION("Empty view") {
            REQUIRE(TextView{} == TextView{});
            REQUIRE(""_tv == ""_tv);
            REQUIRE(TextView{} == ""_tv);
            REQUIRE(""_tv == TextView{});
        }

        REQUIRE("abc"_tv == "abc"_tv);
        REQUIRE_FALSE("abc"_tv == "ABC"_tv);
        REQUIRE_FALSE("abc"_tv == ""_tv);
        REQUIRE_FALSE(""_tv == "abc"_tv);
    }
}
