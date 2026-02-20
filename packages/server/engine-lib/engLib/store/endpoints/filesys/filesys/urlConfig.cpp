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

namespace engine::store::filter::filesys::filesys {
//-----------------------------------------------------------------
// Register the filesys protocol config with the Url system. This
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

     //-------------------------------------------------------------
     /// @details
     ///		This function will convert a path, with the prefix
     ///		removed, to a fully qualified path that can be sent
     ///		to the OS.
     ///
     ///		For Linux:
     ///			path: ("usr", "dir", "file.txt")
     ///			ouputs: /usr/dir/file
     ///
     ///		For Windows:
     ///			path: ("C:", "dir", "file.txt")
     ///			ouputs: //./C:/dir/file.txt
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

#ifdef ROCKETRIDE_PLAT_WIN

         // For Windows, we can just use the plat function for now
         toPath = fromPath.plat();
#else
         // For Linux, the path comes from a url, so it does not contain
         // the leading /. For example, filesys://FileSystem/dir/file.txt
         // the path passed will be dir/file.txt. This is okay for Windows
         // since the first component is the drive letter, but for Linux
         // we must add the leading /
         if (!fromPath.isAbsolute())
             toPath = "/" + fromPath.plat();
         else
             toPath = fromPath.plat();
#endif
         return {};
     }}};

}  // namespace engine::store::filter::filesys::filesys
