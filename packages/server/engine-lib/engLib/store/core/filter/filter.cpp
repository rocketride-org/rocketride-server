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

#include <engLib/eng.h>

namespace engine::store {
//-------------------------------------------------------------------------
/// @brief Destructor for IServiceFilterGlobal.
/// @details
///     Forces end of global
//-------------------------------------------------------------------------
IServiceFilterGlobal::~IServiceFilterGlobal() {
    LOGPIPE();
    endFilterGlobal();
}

//-------------------------------------------------------------------------
/// @brief Begin using filter
//-------------------------------------------------------------------------
Error IServiceFilterGlobal::beginFilterGlobal() noexcept { return {}; }

//-------------------------------------------------------------------------
/// @brief Validate using filter
//-------------------------------------------------------------------------
Error IServiceFilterGlobal::validateConfig() noexcept { return {}; }

//-------------------------------------------------------------------------
/// @brief End use of a filter
/// @details
///     Cleans up allocated buffers and resets internal pointers.
//-------------------------------------------------------------------------
Error IServiceFilterGlobal::endFilterGlobal() noexcept {
    // Reset all of our ptrs
    endpoint.reset();
    global.reset();
    return {};
}

//-------------------------------------------------------------------------
/// @brief Destructor for IServiceFilterInstance.
/// @details
///     Forces an end instance
//-------------------------------------------------------------------------
IServiceFilterInstance::~IServiceFilterInstance() {
    LOGPIPE();
    endFilterInstance();
}

//-------------------------------------------------------------------------
/// @brief Begin using filter
//-------------------------------------------------------------------------
Error IServiceFilterInstance::beginFilterInstance() noexcept { return {}; }

//-------------------------------------------------------------------------
/// @details
///		First touch of a binding: bind this instance to the pipe's current
///		generation. Already bound to it: nothing to do. Bound to an older
///		generation (a putPipe() that never ran): that binding is ended
///		first. The generation is recorded BEFORE beginBinding() runs, so a
///		binding whose constructor failed half way is still ended by
///		putPipe() and nothing is left behind for the next holder
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceFilterInstance::bindToGeneration() noexcept {
    if (!pipe)
        return APERR(Ec::InvalidCommand, "The instance is not on a pipe");

    if (m_endingBinding)
        return APERR(Ec::InvalidCommand,
                     "The instance is ending its binding; nothing can be bound "
                     "from inside endInstance");

    const auto generation = pipe->generation;
    if (m_boundGeneration == generation) return {};

    if (m_boundGeneration)
        if (auto ccode = releaseBinding()) return ccode;

    m_boundGeneration = generation;
    return beginBinding();
}

//-------------------------------------------------------------------------
/// @details
///		End the binding this instance holds, if any
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceFilterInstance::releaseBinding() noexcept {
    if (!m_boundGeneration) return {};

    m_boundGeneration = 0;
    m_endingBinding = true;
    auto ccode = endBinding();
    m_endingBinding = false;
    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Whether this instance is bound to the pipe's current generation
//-------------------------------------------------------------------------
bool IServiceFilterInstance::isBound() const noexcept {
    return pipe && m_boundGeneration && m_boundGeneration == pipe->generation;
}

//-------------------------------------------------------------------------
/// @brief End use of a filter
/// @details
///     Cleans up allocated buffers and resets internal pointers.
//-------------------------------------------------------------------------
Error IServiceFilterInstance::endFilterInstance() noexcept {
    // Reset all of our ptrs
    endpoint.reset();
    global.reset();
    instance.reset();
    pipe.reset();
    pDown.reset();

    // Release the tag buffer if allocated
    if (m_pTagBuffer) Memory::release(&m_pTagBuffer);

    // Release the IO buffer if allocated
    if (m_pIOBuffer) Memory::release(&m_pIOBuffer);
    return {};
}
}  // namespace engine::store
