vcpkg_from_git(
    OUT_SOURCE_PATH SOURCE_PATH
    URL https://chromium.googlesource.com/linux-syscall-support
    REF 9719c1e1e676814c456b55f5f070eabad6709d31
)

file(INSTALL ${SOURCE_PATH}/linux_syscall_support.h DESTINATION ${CURRENT_PACKAGES_DIR}/share/linux-syscall-support RENAME copyright)

file(INSTALL ${SOURCE_PATH}/linux_syscall_support.h DESTINATION ${CURRENT_PACKAGES_DIR}/include RENAME linux_syscall_support.h)
