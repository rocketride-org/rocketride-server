# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

cmake_minimum_required(VERSION 3.17 FATAL_ERROR)
include(rocketride)

#
# Do not want on new boost version library. The port does not know about
# the latest version, but it should be okay
#
set(Boost_NO_WARN_NEW_VERSIONS	1)

#
# rocketride_configure_jvm_linkage - Configure platform-specific JVM linkage properties
#
function(rocketride_configure_jvm_linkage target)
	if (ROCKETRIDE_PLAT_WIN)
		# On Windows, we delay-load jvm.dll after explicitly adding its installed directory to the DLL search path
		target_link_libraries(${target} PUBLIC delayimp.lib)
		set_target_properties(${target} PROPERTIES LINK_OPTIONS "/DELAYLOAD:jvm.dll")
	elseif (ROCKETRIDE_PLAT_LIN)
		# On Linux, change the RPATH to include the JRE directory and ./lib
		set_target_properties(${target} PROPERTIES
			INSTALL_RPATH "\$ORIGIN/lib:\$ORIGIN/java/jre/lib/server"
			BUILD_WITH_INSTALL_RPATH TRUE
		)
	elseif (ROCKETRIDE_PLAT_MAC)
		# On Mac, add the lib rpath for brew, some package are installed with brew
		set(ENGINE_INSTALL_RPATH
			"@loader_path/java/jre/lib"
			"/usr/local/lib"
		)

		set_target_properties(${target} PROPERTIES
			INSTALL_RPATH "${ENGINE_INSTALL_RPATH}"
			BUILD_WITH_INSTALL_RPATH TRUE
		)
	endif()
endfunction()
