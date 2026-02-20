# Tika updates

Tika support is an ongoing maintence tasks. It is pretty much automated, but you
need to tell maven what version of Tika to use.

You do this in the CMakeLists.txt file [here](../../engLib/aparavi-java/lib/tika/CMakeLists.txt) by
setting `APARAVI_TIKA_VERSION` to the desired version.

This will automatically generate the required pom.xml with the specified Tika version when configuring the project.

#
# YOU ARE RESPONSIBLE FOR GOING THROUGH THE CHANGE LOGS OF THE NEW TARGET VERSION AND  DETERMINING IF THERE ARE ANY BREAKING CHANGES!
