This port was added because the vcpkg defines the option (feature) to copy the tools which is disabled by default:
`option(INSTALL_TOOLS "Install tools" OFF)`

I did not find the way to enable this option outside the port in the triplet file.

So, this port is an exact copy of the default port with only single options added:
`-DINSTALL_TOOLS=ON`.
