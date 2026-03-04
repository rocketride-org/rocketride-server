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

namespace ap::xml {

// Creates a documents root element (its declaration)
inline auto declare(Document& doc, const char* declaration = {}) noexcept {
    Declaration* d;
    if (declaration)
        d = doc.NewDeclaration(declaration);
    else
        d = doc.NewDeclaration();
    doc.InsertEndChild(d);
    return d;
}

// For when you have a parent node to link to...
inline auto add(Document& doc, Element* parent, const char* name) noexcept {
    auto e = doc.NewElement(name);
    if (parent)
        parent->LinkEndChild(e);
    else
        doc.LinkEndChild(e);
    return e;
}

inline auto add(Document& doc, Element* parent, const char* name,
                const char* value) noexcept {
    auto e = add(doc, parent, name);
    e->SetText(value);
    return e;
}

template <typename Value>
inline auto add(Document& doc, Element* parent, const char* name,
                const Value& value) noexcept {
    if constexpr (traits::IsStrV<Value>)
        return add(doc, parent, name, value.c_str());
    else {
        StackTextArena arena;
        StackText str{arena};
        _tsb(str, value);
        return add(doc, parent, name, str.c_str());
    }
}

// Name returns the node name as a view, easier to compare vs raw char * and no
// allocation
template <typename NodeT>
inline TextView name(const NodeT* node) noexcept {
    if (auto n = node->Name()) return n;
    return {};
}

// For when you just want to link to the root node...
template <typename Value>
inline auto add(Document& doc, const char* name, const Value& value) noexcept {
    return add(doc, doc.RootElement(), name, value);
}

inline auto add(Document& doc, const char* name) noexcept {
    return add(doc, doc.RootElement(), name);
}

// Extract/convert a node value
template <typename T = TextView, typename NodeT>
inline ErrorOr<T> value(const NodeT* node) noexcept {
    TextView val;
    if constexpr (traits::IsSameTypeV<Element, NodeT>) {
        val = node->GetText();
    } else if constexpr (traits::IsSameTypeV<Attribute, NodeT>) {
        val = node->Value();
    } else {
        static_assert(sizeof(NodeT) == 0, "Unsupported node type");
    }

    if (!val) return APERR(Ec::NotFound, "XML element contains no text value");
    if constexpr (traits::IsSameTypeV<T, TextView> ||
                  traits::IsSameTypeV<T, iTextView>)
        return T{val};
    else
        return _fsc<T>(val);
}

inline auto findAttribute(const Element* elem, const char* name) noexcept {
    return elem->FindAttribute(name);
}

template <typename T = TextView>
inline ErrorOr<T> getAttributeValue(const Element* elem,
                                    const char* name) noexcept {
    if (auto attribute = findAttribute(elem, name)) return value<T>(attribute);
    return APERR(Ec::NotFound, "XML attribute not found", name);
}

// Visit a tree of elements
template <typename Callback>
inline auto visit(const Element* root, Callback&& cb) {
    // Use our callback based visitor to match the value
    CallbackVisitor visitor{std::forward<Callback>(cb)};
    root->Accept(&visitor);
}

template <typename Attrib>
inline auto setAttribute(Element* elem, const char* name,
                         const Attrib& attrib) noexcept {
    if constexpr (traits::IsStrV<Attrib>)
        elem->SetAttribute(name, attrib);
    else {
        StackTextArena arena;
        StackText str{arena};
        _tsb(str, attrib);
        elem->SetAttribute(name, str.c_str());
    }
    return elem;
}

template <typename Attrib>
inline auto setAttribute(Element* elem, const char* name,
                         const char* attrib) noexcept {
    elem->SetAttribute(name, attrib);
}

// Set one or more attributes, each attribute must be string type, followed by
// its value
template <typename... Attribs>
inline auto setAttributes(Element* elem, Attribs&&... attribs) noexcept {
    static_assert(sizeof...(attribs) % 2 == 0,
                  "Invalid number of attribute to values");

    // Step 1 make a tuple of all the args
    auto bundle = makeTuple(std::forward_as_tuple<Attribs>(attribs)...);

    // Step 2 split odds and evens out, evens are the names, odds are the values
    auto names = util::tuple::justEvens(bundle);
    auto vals = util::tuple::justOdds(bundle);

    // Step 3 iterate the resulting pairs and set each attribute in turn
    util::tuple::forEach(makePair<>(_mv(names), _mv(vals)),
                         [&](const auto& name, const auto& val) noexcept {
                             setAttribute(elem, get<0>(name), get<0>(val));
                         });

    return elem;
}

inline auto findChild(const Node* parent, const char* name) noexcept {
    return parent->FirstChildElement(name);
}

inline auto findChild(Element* parent, const char* name) noexcept {
    return _constCast<Element*>(parent->FirstChildElement(name));
}

inline auto childCount(Element* parent, const char* name = nullptr) noexcept {
    size_t count = {};
    for (auto element = parent->FirstChildElement(name); element;
         element = element->NextSiblingElement(name)) {
        ++count;
    }
    return count;
}

inline auto attributeCount(Element* element) noexcept {
    size_t count = {};
    for (auto attribute = element->FirstAttribute(); attribute;
         attribute = attribute->Next()) {
        ++count;
    }
    return count;
}

inline Error parse(TextView str, Document& doc) noexcept {
    if (auto ec = doc.Parse(str.data(), str.size()))
        return APERR(Ec::InvalidXml, doc.ErrorStr());
    if (!doc.RootElement())
        return APERR(Ec::InvalidXml, "XML document has no root element");
    return {};
}

template <typename Buffer>
inline void render(const Node& node, Buffer& buff,
                   bool compact = true) noexcept {
    tinyxml2::XMLPrinter printer(nullptr, compact);
    node.Accept(&printer);

    // Do not allow a rogue null terminator to be added to the view
    auto len = _cast<size_t>(printer.CStrSize());
    if (len) len--;

    _tsb(buff, TextView{printer.CStr(), len});
}

template <typename AllocT = std::allocator<char>>
inline auto toString(const Node& node, bool compact = true,
                     const AllocT& alloc = {}) noexcept {
    string::Str<char, string::Case<char>, AllocT> buff;
    render(node, buff, compact);
    return buff;
}

}  // namespace ap::xml

namespace tinyxml2 {

// ADL lookup for __toString of XMLNode
template <typename Buffer>
inline auto __toString(const XMLNode& node, Buffer& buff) noexcept {
    return ::ap::xml::render(node, buff, false);
}

// ADL lookup for __toString of XMLAttribute
template <typename Buffer>
inline auto __toString(const XMLAttribute& attrib, Buffer& buff) noexcept {
    buff << *::ap::xml::value(&attrib);
}

}  // namespace tinyxml2
