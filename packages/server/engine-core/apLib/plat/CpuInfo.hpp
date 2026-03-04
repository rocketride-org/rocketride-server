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

namespace ap::plat {

// Uses the __cpuid intrinsic to get information about
// CPU extended instruction set support.
// From
// https://docs.microsoft.com/en-us/cpp/intrinsics/cpuid-cpuidex?view=vs-2019
// See also https://en.wikipedia.org/wiki/CPUID
class CpuInfo {
public:
    CpuInfo() {
        // Query basic CPU info (up to leaf 7)
        std::vector<std::array<uint32_t, 4>> data;
        for (uint32_t i = {}; i <= std::min(cpuidMax(), 7u); ++i) {
            data.push_back(cpuid(i));
        }

        // Sanity check.  Can this happen?
        if (data.empty()) {
            LOG(Always, "Unable to query CPU info");
            return;
        }

        // Capture vendor string
        char vendorBuffer[0x20];
        memset(vendorBuffer, 0, sizeof(vendorBuffer));
        *_reCast<int*>(vendorBuffer) = data[0][1];
        *_reCast<int*>(vendorBuffer + 4) = data[0][3];
        *_reCast<int*>(vendorBuffer + 8) = data[0][2];
        m_vendor = vendorBuffer;
        m_vendor.trim();
        if (m_vendor == "GenuineIntel")
            m_isIntel = true;
        else if (m_vendor == "AuthenticAMD")
            m_isAMD = true;

        // Load bitsets with flags for leaf 1
        if (data.size() >= 1) {
            // Interpret family, model, and stepping, which are stored in EAX
            // for leaf 1
            union CpuSignature {
                struct {
                    uint32_t stepping : 4;
                    uint32_t model : 4;
                    uint32_t family : 4;
                    uint32_t processorType : 2;
                    uint32_t reseved1 : 2;
                    uint32_t extendedModel : 4;
                    uint32_t extendedFamily : 8;
                    uint32_t reserved0 : 4;
                };
                uint32_t reg;
            };

            CpuSignature sig{.reg = data[1][0]};
            // "If the Family ID field is equal to 15, the family is equal to
            // the sum of the Extended Family ID and the Family ID fields.
            // Otherwise, the family is equal to value of the Family ID field."
            m_family =
                sig.family == 15 ? sig.extendedFamily + sig.family : sig.family;
            // "If the Family ID field is either 6 or 15, the model is equal to
            // the sum of the Extended Model ID field shifted left by 4 bits and
            // the Model field. Otherwise, the model is equal to the value of
            // the Model field."
            m_model = (sig.family == 6 || sig.family == 15)
                          ? (sig.extendedModel << 4) + sig.model
                          : sig.model;
            m_stepping = sig.stepping;

            m_f1_ECX = data[1][2];
            m_f1_EDX = data[1][3];
        }

        // Load bitsets with flags for leaf 7
        if (data.size() >= 7) {
            m_f7_EBX = data[7][1];
            m_f7_ECX = data[7][2];
        }

        // Query extended CPU info (up to 0x80000004)
        const uint32_t maxCpuidEx = cpuidExMax();
        std::vector<std::array<uint32_t, 4>> extdata;
        for (uint32_t i = 0x80000000; i <= std::min(maxCpuidEx, 0x80000004);
             ++i) {
            extdata.push_back(cpuid(i));
        }

        // Load bitsets with flags for function 0x80000001
        if (maxCpuidEx >= 0x80000001) {
            m_f81_ECX = extdata[1][2];
            m_f81_EDX = extdata[1][3];
        }

        // Capture CPU brand string if reported
        if (maxCpuidEx >= 0x80000004) {
            char brandBuffer[0x40];
            memset(brandBuffer, 0, sizeof(brandBuffer));
            memcpy(brandBuffer, extdata[2].data(), 4);
            memcpy(brandBuffer + 16, extdata[3].data(), 4);
            memcpy(brandBuffer + 32, extdata[4].data(), 4);
            m_brand = brandBuffer;
            m_brand.trim();
        }
    };

    Text vendor() const noexcept { return m_vendor; }
    Text brand() const noexcept { return m_brand; }
    uint32_t family() const noexcept { return m_family; }
    uint32_t model() const noexcept { return m_model; }
    uint32_t stepping() const noexcept { return m_stepping; }

    bool SSE3() const noexcept { return m_f1_ECX[0]; }
    bool PCLMULQDQ() const noexcept { return m_f1_ECX[1]; }
    bool MONITOR() const noexcept { return m_f1_ECX[3]; }
    bool SSSE3() const noexcept { return m_f1_ECX[9]; }
    bool FMA() const noexcept { return m_f1_ECX[12]; }
    bool CMPXCHG16B() const noexcept { return m_f1_ECX[13]; }
    bool SSE41() const noexcept { return m_f1_ECX[19]; }
    bool SSE42() const noexcept { return m_f1_ECX[20]; }
    bool MOVBE() const noexcept { return m_f1_ECX[22]; }
    bool POPCNT() const noexcept { return m_f1_ECX[23]; }
    bool AES() const noexcept { return m_f1_ECX[25]; }
    bool XSAVE() const noexcept { return m_f1_ECX[26]; }
    bool OSXSAVE() const noexcept { return m_f1_ECX[27]; }
    bool AVX() const noexcept { return m_f1_ECX[28]; }
    bool F16C() const noexcept { return m_f1_ECX[29]; }
    bool RDRAND() const noexcept { return m_f1_ECX[30]; }

    bool MSR() const noexcept { return m_f1_EDX[5]; }
    bool CX8() const noexcept { return m_f1_EDX[8]; }
    bool SEP() const noexcept { return m_f1_EDX[11]; }
    bool CMOV() const noexcept { return m_f1_EDX[15]; }
    bool CLFSH() const noexcept { return m_f1_EDX[19]; }
    bool MMX() const noexcept { return m_f1_EDX[23]; }
    bool FXSR() const noexcept { return m_f1_EDX[24]; }
    bool SSE() const noexcept { return m_f1_EDX[25]; }
    bool SSE2() const noexcept { return m_f1_EDX[26]; }

    bool FSGSBASE() const noexcept { return m_f7_EBX[0]; }
    bool BMI1() const noexcept { return m_f7_EBX[3]; }
    bool HLE() const noexcept { return m_isIntel && m_f7_EBX[4]; }
    bool AVX2() const noexcept { return m_f7_EBX[5]; }
    bool BMI2() const noexcept { return m_f7_EBX[8]; }
    bool ERMS() const noexcept { return m_f7_EBX[9]; }
    bool INVPCID() const noexcept { return m_f7_EBX[10]; }
    bool RTM() const noexcept { return m_isIntel && m_f7_EBX[11]; }
    bool AVX512F() const noexcept { return m_f7_EBX[16]; }
    bool RDSEED() const noexcept { return m_f7_EBX[18]; }
    bool ADX() const noexcept { return m_f7_EBX[19]; }
    bool AVX512PF() const noexcept { return m_f7_EBX[26]; }
    bool AVX512ER() const noexcept { return m_f7_EBX[27]; }
    bool AVX512CD() const noexcept { return m_f7_EBX[28]; }
    bool SHA() const noexcept { return m_f7_EBX[29]; }

    bool PREFETCHWT1() const noexcept { return m_f7_ECX[0]; }

    bool LAHF() const noexcept { return m_f81_ECX[0]; }
    bool LZCNT() const noexcept { return m_isIntel && m_f81_ECX[5]; }
    bool ABM() const noexcept { return m_isAMD && m_f81_ECX[5]; }
    bool SSE4a() const noexcept { return m_isAMD && m_f81_ECX[6]; }
    bool XOP() const noexcept { return m_isAMD && m_f81_ECX[11]; }
    bool TBM() const noexcept { return m_isAMD && m_f81_ECX[21]; }

    bool SYSCALL() const noexcept { return m_isIntel && m_f81_EDX[11]; }
    bool MMXEXT() const noexcept { return m_isAMD && m_f81_EDX[22]; }
    bool RDTSCP() const noexcept { return m_isIntel && m_f81_EDX[27]; }
    bool _3DNOWEXT() const noexcept { return m_isAMD && m_f81_EDX[30]; }
    bool _3DNOW() const noexcept { return m_isAMD && m_f81_EDX[31]; }

private:
    static std::array<uint32_t, 4> cpuid(int leaf) noexcept;
    static uint32_t cpuidMax() noexcept;
    static uint32_t cpuidExMax() noexcept;

private:
    Text m_vendor;
    Text m_brand;
    uint32_t m_family = {};
    uint32_t m_model = {};
    uint32_t m_stepping = {};
    bool m_isIntel = {};
    bool m_isAMD = {};
    std::bitset<32> m_f1_ECX;
    std::bitset<32> m_f1_EDX;
    std::bitset<32> m_f7_EBX;
    std::bitset<32> m_f7_ECX;
    std::bitset<32> m_f81_ECX;
    std::bitset<32> m_f81_EDX;
};

inline const CpuInfo& cpuInfo() noexcept {
    static CpuInfo cpuInfo;
    return cpuInfo;
}

}  // namespace ap::plat
