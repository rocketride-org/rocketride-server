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

namespace engine::store::filter::null {
//-----------------------------------------------------------------
// Register the filesys protocol config with the Url system. This
// allows call Url::toPath(...), Url::toUrl(...), etc
//-----------------------------------------------------------------
static url::UrlConfig urlConfig{
    {//------------------------------------------------------------
     /// @details
     ///	Define the protocol capabilities
     //------------------------------------------------------------
     .capabilities = {},

     //------------------------------------------------------------
     /// @details
     ///	Define the protocol type
     //------------------------------------------------------------
     .protocol = Type,

     //-------------------------------------------------------------
     /// @details
     ///		This function will take a protocol and a path and
     ///		convert it to a properly formatted url by adding the
     ///		url and the prefix
     ///	@param[in]	fromProtocol
     ///		Used to determine how to format the url
     ///	@param[in]	fromPath
     ///		The path to format
     ///	@param[out]	toUrl
     ///		Receives the url
     //-------------------------------------------------------------
     .toUrl = [](const iTextView fromProtocol, const file::Path& fromPath,
                 Url& toUrl) -> Error {
         using namespace ap::url;

         toUrl = builder() << protocol(Type) << fromPath;
         return {};
     }}};
}  // namespace engine::store::filter::null
