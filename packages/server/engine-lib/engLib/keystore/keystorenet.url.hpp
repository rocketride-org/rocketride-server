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

namespace engine::stream::keystorenet {
//-------------------------------------------------------------------------
///	@details
///		The trace flag for this component
//-------------------------------------------------------------------------
_const auto Level = Lvl::KeyStoreNet;
//-------------------------------------------------------------------------
///	@details
///		The type of this stream
//-------------------------------------------------------------------------
_const auto Type = "kvsnet"_itv;

//-------------------------------------------------------------------------
// Register the protocol config with the Url system. This
// allows call Url::toPath(...), Url::toUrl(...), etc
//-------------------------------------------------------------------------
static url::UrlConfig urlConfig{
    {//------------------------------------------------------------
     /// @details
     ///	Define the protocol capabilities
     //------------------------------------------------------------
     .capabilities = Url::PROTOCOL_CAPS::NETWORK | Url::PROTOCOL_CAPS::DATANET,

     //------------------------------------------------------------
     /// @details
     ///	Define the protocol type
     //------------------------------------------------------------
     .protocol = Type,

     //------------------------------------------------------------
     /// @details
     ///	    Given a fully qualified url in the form of
     ///	    kvsnet://<host>/dir/file.dat, returns the
     ///	    path ("<host>", "dir", "file.dat")
     /// @param[in]	fromUrl
     ///	    Url to convert
     /// @param[out] toPath
     ///	    Receives the path
     //------------------------------------------------------------
     .toPath = [](const Url &fromUrl, file::Path &toPath) -> Error {
         // Validate it
         if (auto ccode = urlConfig.validate(fromUrl)) return ccode;

         // Get the path
         auto path = fromUrl.fullpath();

         // Grab what we need and convert to a path
         toPath =
             file::Path{config::paths().lookup(path.at(1)) / path.fileName()};

         return {};
     },

     //------------------------------------------------------------
     /// @details
     ///	    verifies that the given url is valid and in the form
     ///	    of kvsnet://<host>/dir/file
     /// @param[in]	url
     ///	    Url to convert
     //------------------------------------------------------------
     .validate = [](const Url &url) -> Error {
         // Get the path
         const auto path = url.fullpath();

         // Must have at exactly 3 components
         if (path.count() != 3)
             return APERRX(
                 Level, Ec::InvalidParam,
                 "kvsnet path has unexpected number of components:", path);

         return {};
     }}};

}  // namespace engine::stream::keystorenet
