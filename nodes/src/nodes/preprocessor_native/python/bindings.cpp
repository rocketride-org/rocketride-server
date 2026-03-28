#include <nanobind/nanobind.h>
#include <nanobind/stl/string.h>
#include <nanobind/stl/string_view.h>
#include <nanobind/stl/vector.h>
#include <nanobind/stl/pair.h>
#include "chunker.h"
#include "indexer.h"

namespace nb = nanobind;

NB_MODULE(rr_native, m) {
    m.doc() = "RocketRide native C++ chunker and indexer";

    nb::class_<rr::Chunk>(m, "Chunk")
        .def_ro("doc_id", &rr::Chunk::doc_id)
        .def_ro("offset", &rr::Chunk::offset)
        .def_ro("length", &rr::Chunk::length)
        .def("__repr__", [](const rr::Chunk& c) {
            return "Chunk(doc_id=" + std::to_string(c.doc_id) +
                   ", offset=" + std::to_string(c.offset) +
                   ", length=" + std::to_string(c.length) + ")";
        });

    nb::enum_<rr::SplitMode>(m, "SplitMode")
        .value("recursive", rr::SplitMode::recursive)
        .value("fast", rr::SplitMode::fast)
        .value("icu", rr::SplitMode::icu);

    nb::class_<rr::ChunkerConfig>(m, "ChunkerConfig")
        .def(nb::init<>())
        .def_rw("target_size", &rr::ChunkerConfig::target_size)
        .def_rw("overlap", &rr::ChunkerConfig::overlap)
        .def_rw("locale", &rr::ChunkerConfig::locale)
        .def_rw("mode", &rr::ChunkerConfig::mode);

    nb::class_<rr::Chunker>(m, "Chunker")
        .def(nb::init<>())
        .def(nb::init<rr::ChunkerConfig>())
        .def("chunk", &rr::Chunker::chunk, nb::arg("text"), nb::arg("doc_id") = 0)
        .def("chunk_batch", &rr::Chunker::chunk_batch);

    nb::class_<rr::SearchResult>(m, "SearchResult")
        .def_ro("chunk_id", &rr::SearchResult::chunk_id)
        .def_ro("score", &rr::SearchResult::score);

    nb::class_<rr::IndexerConfig>(m, "IndexerConfig")
        .def(nb::init<>())
        .def_rw("k1", &rr::IndexerConfig::k1)
        .def_rw("b", &rr::IndexerConfig::b)
        .def_rw("min_token_len", &rr::IndexerConfig::min_token_len);

    nb::class_<rr::Indexer>(m, "Indexer")
        .def(nb::init<>())
        .def(nb::init<rr::IndexerConfig>())
        .def("add", &rr::Indexer::add)
        .def("add_batch", &rr::Indexer::add_batch)
        .def("search", &rr::Indexer::search, nb::arg("query"), nb::arg("top_k") = 10)
        .def("reset", &rr::Indexer::reset)
        .def("term_count", &rr::Indexer::term_count)
        .def("doc_count", &rr::Indexer::doc_count)
        .def("memory_bytes", &rr::Indexer::memory_bytes);
}
