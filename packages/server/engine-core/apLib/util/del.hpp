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

#pragma once

namespace ap::util {

// We do this alot, delete, then make null. This template makes this
// easier.
template <typename Item>
inline void deleteNullifyItem(Item &&item) noexcept {
    if constexpr (std::is_pointer_v<std::remove_reference_t<Item>>) {
        delete _exch(item, nullptr);
    } else {
        item.reset();
    }
}

// We do this alot, delete, then make null. This template makes this
// easier.
template <typename Item>
inline Error closeItem(Item &&item) noexcept {
    using ItemT = std::remove_reference_t<Item>;

    if constexpr (std::is_pointer_v<ItemT>) {
        if constexpr (traits::IsDetectedExact<
                          Error, traits::DetectCloseMethodPtr, ItemT>{}) {
            if (!item) return {};
            return item->close();
        } else if constexpr (traits::IsDetectedExact<
                                 void, traits::DetectCloseMethodPtr, ItemT>{}) {
            if (!item) return {};
            item->close();
            return {};
        }
    } else if constexpr (traits::HasElementTypeV<ItemT>) {
        if constexpr (traits::IsDetectedExact<Error,
                                              traits::DetectCloseMethodPtr,
                                              typename ItemT::element_type>{}) {
            if (!item) return {};
            auto ccode = item->close();
            return ccode;
        } else if constexpr (traits::IsDetectedExact<
                                 void, traits::DetectCloseMethodPtr,
                                 typename ItemT::element_type>{}) {
            if (!item) return {};
            item->close();
            return {};
        }
    } else {
        static_assert(sizeof(Item) == 0, "Unsupported type for close");
    }
}

// We do this alot, delete, then make null. This template makes this
// easier.
template <typename Item>
inline Error removeItem(Item &&item) noexcept {
    using ItemT = std::remove_reference_t<Item>;

    if constexpr (std::is_pointer_v<ItemT>) {
        if constexpr (traits::IsDetectedExact<
                          Error, traits::DetectCloseMethodPtr, ItemT>{}) {
            if (!item) return {};
            return item->remove();
        } else if constexpr (traits::IsDetectedExact<
                                 void, traits::DetectCloseMethodPtr, ItemT>{}) {
            if (!item) return {};
            item->remove();
            return {};
        }
    } else if constexpr (traits::HasElementTypeV<ItemT>) {
        if constexpr (traits::IsDetectedExact<Error,
                                              traits::DetectCloseMethodPtr,
                                              typename ItemT::element_type>{}) {
            if (!item) return {};
            auto ccode = item->remove();
            return ccode;
        } else if constexpr (traits::IsDetectedExact<
                                 void, traits::DetectCloseMethodPtr,
                                 typename ItemT::element_type>{}) {
            if (!item) return {};
            item->remove();
            return {};
        }
    } else {
        static_assert(sizeof(Item) == 0, "Unsupported type for remove");
    }
}

// We do this alot, delete, then make null. This template makes this
// easier.
template <typename Item>
inline Error closeDeleteNullityItem(Item &&item) noexcept {
    using ItemT = std::remove_reference_t<Item>;

    if constexpr (std::is_pointer_v<ItemT>) {
        if constexpr (traits::IsDetectedExact<
                          Error, traits::DetectCloseMethodPtr, ItemT>{}) {
            if (!item) return {};
            auto ccode = item->close();
            deleteNullifyItem(std::forward<Item>(item));
            return ccode;
        } else if constexpr (traits::IsDetectedExact<
                                 void, traits::DetectCloseMethodPtr, ItemT>{}) {
            if (!item) return {};
            item->close();
            deleteNullifyItem(std::forward<Item>(item));
            return {};
        } else {
            deleteNullifyItem(std::forward<Item>(item));
            return {};
        }
    } else if constexpr (traits::HasElementTypeV<ItemT>) {
        if constexpr (traits::IsDetectedExact<Error,
                                              traits::DetectCloseMethodPtr,
                                              typename ItemT::element_type>{}) {
            if (!item) return {};
            auto ccode = item->close();
            deleteNullifyItem(std::forward<Item>(item));
            return ccode;
        } else if constexpr (traits::IsDetectedExact<
                                 void, traits::DetectCloseMethodPtr,
                                 typename ItemT::element_type>{}) {
            if (!item) return {};
            item->close();
            deleteNullifyItem(std::forward<Item>(item));
            return {};
        } else {
            deleteNullifyItem(std::forward<Item>(item));
            return {};
        }
    } else {
        static_assert(sizeof(Item) == 0, "Unsupported type for delete");
    }
}

// We do this alot, delete, then make null. This template makes this
// easier.
template <typename... Items>
inline void deleteNullify(Items &...items) noexcept {
    auto doDelete = [&](auto &item) noexcept { deleteNullifyItem(item); };

    (doDelete(items), ...);
}

// We do this alot, check if a raw ptr is valid, close it, remove it,
// then delete it and then mark it null. This template allows for a much easier
// and compact means to achomplish this on any number of items all at once.
template <typename... Items>
inline Error closeRemoveDeleteNullify(Items &&...items) noexcept {
    Error ccode;

    auto closeRemoveDeleteNullify = [&](auto &&item) noexcept {
        ccode = closeDeleteNullityItem(item) || ccode;
    };

    ((std::forward<Items>(items)), ...);

    return ccode;
}

// We do this alot, check if a raw ptr is valid, close it, then delete it
// and then mark it null. This template allows for a much easier
// and compact means to achomplish this on any number of items all at once.
template <typename... Items>
inline Error closeDeleteNullify(Items &&...items) noexcept {
    Error ccode;

    auto closeDeleteNullify = [&](auto &&item) noexcept {
        ccode = closeDeleteNullityItem(item) || ccode;
    };

    (closeDeleteNullify(std::forward<Items>(items)), ...);

    return ccode;
}

// Close all items
template <typename... Items>
inline Error closeAll(Items &&...items) noexcept {
    Error ccode;

    auto doClose = [&](auto &&item) noexcept {
        ccode = closeItem(item) || ccode;
    };

    (doClose(std::forward<Items>(items)), ...);

    return ccode;
}

// Remove all items
template <typename... Items>
inline Error removeAll(Items &&...items) noexcept {
    Error ccode;

    auto doRemove = [&](auto &&item) noexcept {
        ccode = removeItem(item) || ccode;
    };

    (doRemove(std::forward<Items>(items)), ...);

    return ccode;
}

}  // namespace ap::util
