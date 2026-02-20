# Embedded Python updates

We currently bundle Python 3.10 with the engine. To update to a new version will be a long
and arduous processes, but here are the basic steps that need to be followed:

1. Clone the entire project
2. The python3 port needs to have its [port](../../apLib/cmake/ports/python3/portfile.cmake) file update with the target signatures
	* Change the version numbers up at the top
	* Change the vcpkg_from_github(...) SHA signature to download
	* You can obtain the signature after you change the version, run it and it should display the new signature
3. Update all the Python3_* values to the version you are downloading in [CMakeLists.txt](../../engLib/engLib/CMakeLists.txt)
4. Rebuild the python.zip
	* You can obtain the latests python *.py from the version you downloaded in the vcpkg/installed directory
	* Copy all these to engLib/3rdparty/lib.dist folder
	* Zip the entire content of this lib.dist folder into engLib/3rdparty/python/python.zip
5. Cross your fingers and rebuild

#
# YOU ARE RESPONSIBLE FOR GOING THROUGH THE CHANGE LOGS OF THE NEW TARGET VERSION AND  DETERMINING IF THERE ARE ANY BREAKING CHANGES!
