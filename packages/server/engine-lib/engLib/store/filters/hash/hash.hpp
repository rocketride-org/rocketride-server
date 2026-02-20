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

//-----------------------------------------------------------------------------
//
//	The hasher filter deals with creating/checking SHA512 signatures. It is
//	used for the generation and check of the hashes on the target pipe. Even
//	though this can be included on a source pipe stack, it will be bypassed
//	since it does not intercept any source methods.
//
//	Source Mode:
//		No source mode is needed
//
//	Target Mode:
//		The hasher implements the writeTag interface. On open object, we
//		prepare for a new, incoming object by clearing the hash. On writeTag,
//		if the tag indicates in its attributes, that it is not an instance
//		only data tag, then the tag and its contents are added to the currently
//		running hash created in open object
//
//		If, in writeTag, we receive a TAG_HASH tag, the source is a compound
//		document format that we already wrote a hash to. So, we can compare
//		the current hash we have running with the one in the TAG_HASH we just
//		received. If they are different, then we have a data corruption.
//		Regardless, we do not send this tag down the filter stack.
//
//		When we receive the TAG_OBJECT_END, we can finalize the tag, allow the
//		object end tag to be written, followed by the TAG_HASH tag. This
//		allows us to check for data corruption on copy as described above.
//		Also, when hash has been finalized, we update the currentEntry
//		componentId and signature so it can be sent back to the response
//		pipe.
//
//		An I/O control is also available to retrieve the hash from the filter
//		once it has been finalized.
//
//-----------------------------------------------------------------------------
#pragma once

namespace engine::store::filter::hash {
class IFilterGlobal;

//-------------------------------------------------------------------------
/// @details
///		Declare our factory info
//-------------------------------------------------------------------------
_const auto Type = "hash"_itv;

//-------------------------------------------------------------------------
///	@details
///		The trace flag for this filter
//-------------------------------------------------------------------------
_const auto Level = Lvl::ServiceHash;

//-------------------------------------------------------------------------
/// @details
///		Define the instance class for this filter
//-------------------------------------------------------------------------
class IFilterInstance : public IServiceFilterInstance {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterInstance;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::ServiceHash;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterInstance, Parent>(Type);

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    virtual Error writeTag(const TAG *pTag) noexcept override;
    virtual Error open(Entry &entry) noexcept override;
    virtual Error ioControl(IOCTRL *pCommand) noexcept override;

private:
    Error isEqualTagHash(const TAG_HASH *pTag) noexcept;
    Error writeHashTag() noexcept;
    Error computeHash(const TAG_OBJECT_STREAM_DATA *pData) noexcept;

private:
    //-----------------------------------------------------------------
    /// @details
    ///		The finalized hash - set when the TAG_OBJECT_END is
    ///		detected
    //-----------------------------------------------------------------
    bool m_isFinalized = false;

    //-----------------------------------------------------------------
    /// @details
    ///		The context of the hash as we are generating
    //-----------------------------------------------------------------
    ap::crypto::Sha512 m_context;

    //-----------------------------------------------------------------
    /// @details
    ///		The hash we generated
    //-----------------------------------------------------------------
    ap::crypto::Sha512Hash m_hash;
};

//-------------------------------------------------------------------------
/// @details
///		Define the common class for this filter
//-------------------------------------------------------------------------
class IFilterGlobal : public IServiceFilterGlobal {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterGlobal;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Level;

    //-----------------------------------------------------------------
    /// @details
    ///		Declare our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<IFilterGlobal, Parent>(Type);
};
}  // namespace engine::store::filter::hash