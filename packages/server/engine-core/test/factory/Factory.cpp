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

#include "test.h"

static uint32_t MyDerived2Closed = false, MyDerived1Closed = false;

struct MyInterface {
    struct FactoryArgs {
        Text name;
    };

    MyInterface(const FactoryArgs &args) noexcept : m_name(args.name) {}

    virtual ~MyInterface() {}

    _const auto FactoryType = "MyInterface";
    // Interfaces derived from this class share its factory registry, and every
    // method stored in it returns a pointer to this root
    using FactoryRoot = MyInterface;

    static ErrorOr<Ptr<MyInterface>> __factory(
        Location location, uint32_t flags, const FactoryArgs &args) noexcept {
        return Factory::find<MyInterface>(location, flags, args.name, args);
    }

    Error close() noexcept {
        if (type() == 2)
            MyDerived2Closed = true;
        else if (type() == 1)
            MyDerived1Closed = true;
        return {};
    }

    virtual uint32_t type() noexcept = 0;

    Text m_name;
};

struct MyDerived1 : public MyInterface {
    using MyInterface::MyInterface;

    _const auto Factory =
        Factory::makeFactory<MyDerived1, MyInterface>("name1");

    uint32_t type() noexcept override { return 1; }
};

struct MyDerived2 : public MyInterface {
    using MyInterface::MyInterface;

    _const auto Factory =
        Factory::makeFactory<MyDerived2, MyInterface>("name2");

    uint32_t type() noexcept override { return 2; }
};

// An interface derived from MyInterface shares its factory registry
struct MyIntermediate : public MyInterface {
    using MyInterface::MyInterface;

    virtual uint32_t intermediateType() noexcept = 0;
};

struct MyDerived3 : public MyIntermediate {
    using MyIntermediate::MyIntermediate;

    _const auto Factory =
        Factory::makeFactory<MyDerived3, MyIntermediate>("name3");

    uint32_t type() noexcept override { return 3; }
    uint32_t intermediateType() noexcept override { return 33; }
};

// A derived interface stores and calls factory methods at its root's type
static_assert(std::is_same_v<Factory::Method<MyIntermediate>,
                             Factory::Method<MyInterface>>);

TEST_CASE("Factory") {
    Factory::registerFactory(MyDerived1::Factory);
    Factory::registerFactory(MyDerived2::Factory);
    {
        auto ptr = Factory::make<MyInterface>(_location, "NAME1");
        REQUIRE(ptr->m_name == "NAME1");
        REQUIRE(ptr->type() == 1);
        ptr = Factory::make<MyInterface>(_location, "NAME2");
        REQUIRE(ptr->m_name == "NAME2");
        REQUIRE(ptr->type() == 2);
    }
}

TEST_CASE("Factory with an interface derived from the factory root") {
    Factory::registerFactory(MyDerived3::Factory);
    {
        // Created and returned as the root interface
        auto root = Factory::make<MyInterface>(_location, "NAME3");
        REQUIRE(root);
        REQUIRE((*root)->m_name == "NAME3");
        REQUIRE((*root)->type() == 3);

        // Created and returned as the derived interface
        auto derived = Factory::find<MyIntermediate>(
            _location, 0, "NAME3", MyInterface::FactoryArgs{"NAME3"});
        REQUIRE(derived);
        REQUIRE((*derived)->m_name == "NAME3");
        REQUIRE((*derived)->intermediateType() == 33);
    }
}
