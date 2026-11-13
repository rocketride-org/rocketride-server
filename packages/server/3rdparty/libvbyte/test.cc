
#include <vector>
#include <stdio.h>
#include <assert.h>
#include <ctime>
#include <set>

#include <boost/random.hpp>
#include <boost/random/uniform_01.hpp>

#include "timer.h"
#include "vbyte.h"
#include "varintdecode.h"

static const int loops = 5;

template<typename Traits>
static void
run_compression_test(std::vector<typename Traits::type> &plain,
                std::vector<uint8_t> &z)
{
  size_t len = Traits::compress(&plain[0], &z[0], plain.size());
  z.resize(len);
  assert(len == Traits::compressed_size(&plain[0], plain.size()));
}

template<typename Traits>
static void
run_uncompression_test(const std::vector<typename Traits::type> &plain,
                std::vector<uint8_t> &z,
                std::vector<typename Traits::type> &out)
{
  Timer<boost::chrono::high_resolution_clock> t;
  for (int l = 0; l < loops; l++) {
    Traits::uncompress(&z[0], &out[0], plain.size());
    for (uint32_t j = 0; j < plain.size(); j++)
      assert(plain[j] == out[j]);
  }
  printf("    %s decode -> %f\n", Traits::name, t.seconds() / loops);
}

template<typename Traits>
static void
run_select_test(const std::vector<typename Traits::type> &plain,
                std::vector<uint8_t> &z)
{
  Timer<boost::chrono::high_resolution_clock> t;
  for (int l = 0; l < loops; l++) {
    for (uint32_t i = 0; i < plain.size(); i += 1 + plain.size() / 100) {
      uint32_t v = Traits::select(&z[0], z.size(), i);
      assert(plain[i] == v);
    }
  }
  printf("    %s select -> %f\n", Traits::name, t.seconds() / loops);
}

template<typename Traits>
static void
run_search_test(const std::vector<typename Traits::type> &plain,
                std::vector<uint8_t> &z)
{
  Timer<boost::chrono::high_resolution_clock> t;
  for (int l = 0; l < loops; l++) {
    for (size_t i = 0; i < plain.size(); i += 1 + plain.size() / 5000) {
      typename Traits::type found;
      size_t pos = Traits::search(&z[0], z.size(), plain[i], &found);
      assert(found == plain[i]);
      assert(i == pos);
    }
  }
  printf("    %s search -> %f\n", Traits::name, t.seconds() / loops);
}

template<typename Traits>
static void
run_append_test(std::vector<typename Traits::type> &plain,
                std::vector<uint8_t> &z)
{
  size_t zsize = z.size();

  z.reserve(z.size() + 1024);

  Timer<boost::chrono::high_resolution_clock> t;
  for (uint32_t i = 0; i < 100; i++) {
    typename Traits::type highest = plain[plain.size() - 1];
    typename Traits::type value = highest + 5;
    size_t size = Traits::append(z.data() + zsize, highest, value);
    zsize += size;
    plain.push_back(value);
  }
  printf("    %s append -> %f\n", Traits::name, t.seconds() / loops);

  // verify
  for (uint32_t i = 1; i <= 100; i++) {
    typename Traits::type sel = Traits::select(&z[0], zsize, plain.size() - i);
    assert(sel == plain[plain.size() - i]);
  }
}

template<typename Traits>
static void
run_tests(size_t length)
{
  std::vector<typename Traits::type> plain;
  std::vector<uint8_t> z(length * 10);
  std::vector<typename Traits::type> out(length);

  for (size_t i = 0; i < length; i++)
    plain.push_back(i * 7);

  // compress the data
  run_compression_test<Traits>(plain, z);

  // uncompress the data
  run_uncompression_test<Traits>(plain, z, out);

  // select values
  run_select_test<Traits>(plain, z);

  // search for keys
  run_search_test<Traits>(plain, z);

  // append keys. Will modify |plain| and |z|!
  run_append_test<Traits>(plain, z);
}

struct Sorted32Traits {
  typedef uint32_t type;
  static constexpr const char *name = "Sorted32";

  static size_t compress(const type *in, uint8_t *out, size_t length) {
    return vbyte_compress_sorted32(in, out, length);
  }
  
  static size_t compressed_size(const type *in, size_t length) {
    return vbyte_compressed_size_sorted32(in, length);
  }

  static size_t uncompress(const uint8_t *in, type *out, size_t length) {
    return vbyte_uncompress_sorted32(in, out, length);
  } 

  static type select(const uint8_t *in, size_t length, size_t index) {
    return vbyte_select_sorted32(in, length, index);
  } 

  static size_t search(const uint8_t *in, size_t length, type value,
                  type *result) {
    return vbyte_search_lower_bound_sorted32(in, length, value, result);
  }

  static size_t append(uint8_t *end, type highest, type value) {
    return vbyte_append_sorted64(end, highest, value);
  }
};

struct Sorted64Traits {
  typedef uint64_t type;
  static constexpr const char *name = "Sorted64";

  static size_t compress(const type *in, uint8_t *out, size_t length) {
    return vbyte_compress_sorted64(in, out, length);
  }

  static size_t compressed_size(const type *in, size_t length) {
    return vbyte_compressed_size_sorted64(in, length);
  }

  static size_t uncompress(const uint8_t *in, type *out, size_t length) {
    return vbyte_uncompress_sorted64(in, out, length);
  } 

  static type select(const uint8_t *in, size_t length, size_t index) {
    return vbyte_select_sorted64(in, length, index);
  } 

  static size_t search(const uint8_t *in, size_t length, type value,
                  type *result) {
    return vbyte_search_lower_bound_sorted64(in, length, value, result);
  }

  static size_t append(uint8_t *end, type highest, type value) {
    return vbyte_append_sorted64(end, highest, value);
  }
};

struct Unsorted32Traits {
  typedef uint32_t type;
  static constexpr const char *name = "Unsorted32";

  static size_t compress(const type *in, uint8_t *out, size_t length) {
    return vbyte_compress_unsorted32(in, out, length);
  }

  static size_t compressed_size(const type *in, size_t length) {
    return vbyte_compressed_size_unsorted32(in, length);
  }

  static size_t uncompress(const uint8_t *in, type *out, size_t length) {
    return vbyte_uncompress_unsorted32(in, out, length);
  } 

  static type select(const uint8_t *in, size_t length, size_t index) {
    return vbyte_select_unsorted32(in, length, index);
  } 

  static size_t search(const uint8_t *in, size_t length, type value,
                  type *result) {
    *result = value;
    return vbyte_search_unsorted32(in, length, value);
  }

  static size_t append(uint8_t *end, type, type value) {
    return vbyte_append_unsorted32(end, value);
  }
};

struct Unsorted64Traits {
  typedef uint64_t type;
  static constexpr const char *name = "Unsorted64";

  static size_t compress(const type *in, uint8_t *out, size_t length) {
    return vbyte_compress_unsorted64(in, out, length);
  }

  static size_t compressed_size(const type *in, size_t length) {
    return vbyte_compressed_size_unsorted64(in, length);
  }

  static size_t uncompress(const uint8_t *in, type *out, size_t length) {
    return vbyte_uncompress_unsorted64(in, out, length);
  } 

  static type select(const uint8_t *in, size_t length, size_t index) {
    return vbyte_select_unsorted64(in, length, index);
  } 

  static size_t search(const uint8_t *in, size_t length, type value,
                  type *result) {
    *result = value;
    return vbyte_search_unsorted64(in, length, value);
  }

  static size_t append(uint8_t *end, type, type value) {
    return vbyte_append_unsorted64(end, value);
  }
};

inline static void
test(size_t length)
{
  printf("%u, sorted, 32bit\n", (uint32_t)length);
  run_tests<Sorted32Traits>(length);

  printf("%u, sorted, 64bit\n", (uint32_t)length);
  run_tests<Sorted64Traits>(length);

  printf("%u, unsorted, 32bit\n", (uint32_t)length);
  run_tests<Unsorted32Traits>(length);

  printf("%u, unsorted, 64bit\n", (uint32_t)length);
  run_tests<Unsorted64Traits>(length);
}

int
main()
{
  uint32_t seed = std::time(0);
  printf("seed: %u\n", seed);

  test(1);
  test(2);
  test(10);
  test(16);
  test(33);
  test(42);
  test(100);
  test(128);
  test(256);
  test(333);
  test(1000);
  test(10000);
  test(20000);
  test(100000);
  test(1000000);
  test(10000000);
  return 0;
}
