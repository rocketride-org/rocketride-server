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

namespace engine::store::filter::filesys::smb {
//-----------------------------------------------------------------
// Register the smb protocol config with the Url system. This
// allows call Url::toPath(...), Url::toUrl(...), etc. Note that
// we only provide the osPath since the service manager will
// register generic toPath, toUrl and capabilities
//-----------------------------------------------------------------
static url::UrlConfig urlConfig{
    {//------------------------------------------------------------
     /// @details
     ///	Define the protocol type
     //------------------------------------------------------------
     .protocol = Type,

     //------------------------------------------------------------
     /// @details
     ///	Given a fully qualified url in the form of
     ///	smb://Share/<host>/<share>/dir/file.txt, returns the
     ///	unc path ("<host>", "<share>", "dir", "file.txt")
     /// @param[in]	fromUrl
     ///	Url to convert
     /// @param[out] toPath
     ///	Receives the path
     //------------------------------------------------------------
     .toPath = [](const Url &fromUrl, file::Path &toPath) -> Error {
         // Trim off protocol and File System
         toPath = "//"_tv + fromUrl.fullpath().subpth(1).str();
         return {};
     },

     //-------------------------------------------------------------
     /// @details
     ///		This function will convert a path, with the prefix
     ///		removed, to a fully qualified UNC path that can be
     ///		sent to the apLib file API.
     ///
     ///		For Windows:
     ///			path: ("<host>", "<share>", "dir", "file.txt")
     ///			ouputs: \\<host>\<share>\dir\file.txt
     ///
     ///		For Linux:
     ///			path: ("<host>", "<share>", "dir", "file.txt")
     ///			ouputs: //<host>/<share>/dir/file.txt
     ///
     ///	@param[in] fromUrl
     ///		The url
     ///	@param[out]	osPath
     ///		Receives the text representation of the path
     ///	@returns
     ///		Error
     //------------------------------------------------------------
     .osPath = [](const Url &fromUrl, Text &toPath) -> Error {
         // Get the path
         Path fromPath;
         if (auto ccode = urlConfig.toPath(fromUrl, fromPath)) return ccode;

         // For Windows and Linux just use the plat function
         toPath = fromPath.plat();
         return {};
     }}};

}  // namespace engine::store::filter::filesys::smb
