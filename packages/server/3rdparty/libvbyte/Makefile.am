# If you use Automake then please delete the "makefile". Automake creates
# a "Makefile" (upper-case M), but as long as "makefile" (lower-case M) exists
# then "makefile" will be used and the Automake-"Makefile" is ignored.

libvbyte_la_SOURCES = vbyte.cc vbyte.h

# INCLUDES = 
if ENABLE_SSE4
AM_CPPFLAGS = -mavx
libvbyte_la_SOURCES += varintdecode.c varintdecode.h
endif

noinst_LTLIBRARIES = libvbyte.la

