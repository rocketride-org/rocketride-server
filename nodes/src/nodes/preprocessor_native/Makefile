CXX = clang++
CXXFLAGS = -std=c++20 -O2 -shared -fPIC

UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
	EXT = dylib
else
	EXT = so
endif

all: libnative_chunker.$(EXT) libnative_indexer.$(EXT)

libnative_chunker.$(EXT): native_chunker.cpp
	$(CXX) $(CXXFLAGS) $< -o $@

libnative_indexer.$(EXT): native_indexer.cpp
	$(CXX) $(CXXFLAGS) $< -o $@

clean:
	rm -f *.dylib *.so

.PHONY: all clean
