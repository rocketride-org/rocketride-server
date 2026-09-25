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

//-----------------------------------------------------------------------------
//
//	Umbrella header for the msServices node, mirroring the include order
//	store.hpp used while these endpoints lived in engLib
//
//-----------------------------------------------------------------------------
#pragma once

#include <engLib/eng.h>

// cpprest comes in through the engLib PCH, which has to include it before
// anything instantiates std::char_traits<unsigned char>

#include "outlook/constants.hpp"
#include "msConnector/MsConnector.hpp"
#include "msConnector/MsSharepointConnector/MsSharepointConnector.hpp"
#include "msConnector/MsEmailConnector/MsEmailConnector.hpp"
#include "msConnector/MsEmailConnector/MsEmailContainer.hpp"
#include "sharepoint/base.hpp"
#include "outlook/base.hpp"
