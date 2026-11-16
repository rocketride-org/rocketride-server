#pragma once
// MIT License
//
// Copyright (c) 2018 SignalWire
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
namespace ap::memory {

// A table of slots, each containing a type, addressible by
// a Handle, which is a combination of two numbers, a sequence (indicating the
// instance id of the allocated handle object), and an index (indicating where
// in this table's static array of slots the slot exists in).
template <typename Type, size_t MaxSlots = 1000>
class HandleTable final : public Singleton<HandleTable<Type, MaxSlots>> {
public:
    _const auto LogLevel = Lvl::HandleTable;

    using Parent = Singleton<HandleTable<Type, MaxSlots>>;
    using Parent::Parent;

    ~HandleTable() noexcept { deinit(); }

    void deinit() noexcept {
        m_init = false;
        for (auto i = 0; i < MaxSlots; i++) m_slots[i].release();
    }

    explicit operator bool() const noexcept { return m_init; }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << util::typeName(*this) << "-" << m_totalAllocated;
    }

    // No copy, no move
    HandleTable(const HandleTable &table) noexcept = delete;
    HandleTable &operator=(const HandleTable &table) noexcept = delete;

    HandleTable(HandleTable &&table) noexcept = delete;
    HandleTable &operator=(HandleTable &&table) noexcept = delete;

    // Allow the handle ptr class, and the slot class to call the internal apis
    friend class Ptr;
    friend struct Slot;

    // Effectively a number, containing two fields a sequence, and
    // an index, both referencing a slot in the table. Type safe to prevent
    // ambiguity.
    struct Handle {
        int m_sequence = 0;
        int m_index = 0;

        // Simply put a handle is valid if its index is within max slots.
        auto valid() const noexcept {
            return m_index < MaxSlots && m_index >= 0;
        }

        void reset() noexcept {
            m_sequence = 0;
            m_index = -1;
        }

        explicit operator bool() const noexcept { return valid(); }

        template <typename Buffer>
        auto __toString(Buffer &buff) const noexcept {
            if (!valid()) buff << "{Invalid}-";

            buff << string::toHex(m_sequence, 4) << "-"
                 << string::toHex(m_index, 4);
        }
    };

private:
    // The slot exists in exactly one of the following states, each state
    // describes the assumptions which can be made on the slot, making the slot
    // into a mini state machine of sorts.
    enum class STATE {
        Init,       // Handle is in its initialized default state
        Reserved,   // The slot has been reserved for allocation
        Allocated,  // The object has been allocated, no gets/puts allowed
        Ready,  // Open for buisiness, get/puts are allowed, object is allocated
        NotReady,  // Allocated, no gets allowed, puts allowed
    };

    // A slot is an entry in the statically constructed array within the
    // HandleTable. It contains atomically modified fields to synchronize access
    // and broker construction and deconstruction of the held object templated
    // type.
    struct Slot {
        _const auto LogLevel = Lvl::HandleTable;

        // The current state of this slot
        STATE m_state = STATE::Init;

        // Location for debugging
        Location m_location;

        // The number of check outs which have been made for this
        // slot, m_refCount must drop to zero before the held object
        // may be destroyed
        Atomic<int> m_refCount;

        // The index this slot resides in, set lazily as we ready them
        int m_index = -1;

        // Thread id which did the allocation (Debugging)
        async::Tid m_allocatorId = {};

        // A very primitive lock whih we spin hard on, there is no real
        // contention here requiring a context switch
        mutable std::atomic_flag m_lock;

        // The currently bound sequence, bound from the randomly initiated
        // then sequentially incremented sequence field in the HandleTable
        // this prevents us from allowing handles from other tables to be valid
        // (At least not without chance on our side), due to the type of the
        // handle table itself, it implicitly prevent cross types from
        // being incorrectly casted (hence no group field in the c++ version of
        // handles). Note: debug has the random stuff turned off so you can
        // trace problems with reproduceable indexes from time to time to find
        // patterns.
        int m_sequence = 0;

        // Here is where the object lives, its constructed when this slot is
        // allocated and reset when released.
        Opt<Type> m_object;

        // Just default constructable
        Slot() noexcept = default;

        // Not copyable, or moveable
        Slot(const Slot &) = delete;
        Slot &operator=(const Slot &) = delete;

        Slot(Slot &&) = delete;
        Slot &operator=(Slot &&) = delete;

        // Allocates a new object and sets the slot state to
        // allocate. This may throw since we are constructing an external type.
        template <typename... Args>
        void allocate(Location location, Args &&...args) noexcept(false) {
            m_location = location;

            // Great, lock is held now, change state to allocated
            m_state = STATE::Allocated;
            m_allocatorId = async::threadId();

            LOGT("Allocate");

            if (HandleTable::get()) ASSERT(!m_object);

            // Safe to construct in place, perfect forwarding the args
            m_object.emplace(std::forward<Args>(args)...);
        }

        // Sets the slot state to reserved.
        void setReserved() noexcept {
            LOGT("Reserve");

            if (HandleTable::get()) ASSERT(m_state == STATE::Init);

            m_state = STATE::Reserved;

            HandleTable::get().m_totalAllocated++;
        }

        // Sets the slot state to ready.
        void setReady(int sequenceId) noexcept {
            LOGT("Ready:", sequenceId);

            if (HandleTable::get()) ASSERT(m_state == STATE::Allocated);

            m_state = STATE::Ready;
            m_sequence = sequenceId;
        }

        // Sets the state to not ready and performs any assertions
        // needed to verify the sanity of the operation
        void setNotReady() noexcept {
            LOGT("SetNotReady");

            if (HandleTable::get()) {
                ASSERT(m_state == STATE::Ready || m_state == STATE::NotReady);
                ASSERT(m_refCount != 0);
            }

            // The handle is locked now, set state to not ready
            m_state = STATE::NotReady;
        }

        // Decrements the ref count, and does a few assertion checks to
        // verify sanity of the operation.
        void decRef() noexcept {
            LOGT("DecRef");

            ASSERT(m_refCount > 0);
            if (HandleTable::get())
                ASSERT(m_state == STATE::Ready || m_state == STATE::NotReady);

            m_refCount--;
        }

        // Increments the ref count, and does a few assertion checks to
        // verify sanity of the operation.
        void addRef() noexcept {
            LOGT("AddRef");

            ASSERT(m_refCount < std::numeric_limits<int>::max());
            if (HandleTable::get()) {
                ASSERT(m_state == STATE::Ready);
            }

            m_refCount++;
        }

        // Races to set the atomic flag to true first, returns a
        // scope to auto unlock using RAII semantics.
        [[nodiscard]] decltype(auto) lock() const noexcept {
            return util::Scope(
                [&] {
                    while (m_lock.test_and_set(std::memory_order_acquire)) {
                    }
                },
                [&] { unlock(); });
        }

        // Without spinning, attempts to atomically set the lock flag.
        [[nodiscard]] bool tryLock() const noexcept {
            return !m_lock.test_and_set(std::memory_order_acquire);
        }

        // Used internally when passing slot references back in a locked form
        // for atomic slot access.
        void unlock() const noexcept { m_lock.clear(); }

        // Releases the slot and destroys the bound object.
        void release() noexcept {
            LOGT("Release");

            if (HandleTable::get())
                ASSERT(m_state == STATE::Ready || m_state == STATE::NotReady);

            m_refCount = 0;
            m_sequence = 1;
            m_object.reset();
            m_state = STATE::Init;

            HandleTable::get().m_totalAllocated--;
        }

        explicit operator bool() const noexcept {
            return _cast<bool>(HandleTable::get());
        }

        // Renders information about the state of this slot.
        [[nodiscard]] Text __toString() const noexcept {
            Text stateText;

            switch (m_state) {
                case STATE::Allocated:
                    stateText = "Allocated";
                    break;
                case STATE::Init:
                    stateText = "Init";
                    break;
                case STATE::NotReady:
                    stateText = "NotReady";
                    break;
                case STATE::Ready:
                    stateText = "Ready";
                    break;
                case STATE::Reserved:
                    stateText = "Reserved";
                    break;
                default:
                    dev::fatality(_location, "Invalid handle state",
                                  _cast<int>(m_state));
                    break;
            }

            return string::format(
                "{} {} {}-({})-{}[{}]", m_location,
                _ts("[", m_location.m_function, "]"),
                Handle{m_sequence, m_index}, stateText,
                Count(m_refCount.load()), m_allocatorId,
                (m_object ? _ts(m_object.value()) : "{null}"_t));
        }
    };

public:
    // We never copy slots, we only reference them, define that type
    using SlotRef = Ref<Slot>;

    // The user facing object which contains the checked out
    // reference to the handle, and provides apis to manage the handles
    // lifetime.
    class Ptr {
    protected:
        // Protected constructor which constructs from a SlotRef,
        // only callable by the HandleTable's allocate method.
        Ptr(Opt<SlotRef> &&reference) noexcept
            : m_reference(std::forward<Opt<SlotRef>>(reference)) {}

    public:
        // Allow the handle table to access our private constructor, which
        // constructs from the internal Slot
        friend class HandleTable;

        Ptr() noexcept = default;

        // Copy constructor/copy assignment operator both increment
        // the ref count and copy the slot reference if the state of the slot is
        // Ready.
        Ptr(const Ptr &ptr) noexcept { operator=(ptr); }

        Ptr &operator=(const Ptr &ptr) noexcept {
            if (this == &ptr) return *this;

            // Put our ref if we're holding one
            putRef();

            // Get the ref from the peer
            m_reference = ptr.getRef();

            return *this;
        }

        // Move construct/move assign, moves the reference from one ptr to
        // another.
        Ptr(Ptr &&ptr) noexcept { operator=(_mv(ptr)); }

        Ptr &operator=(Ptr &&ptr) noexcept {
            // Move the other reference's state over
            m_reference = _mv(ptr.m_reference);
            ptr.m_reference.reset();

            return *this;
        }

        // puts the ref and decrements the refcount implicitly
        // in the backing slot.
        ~Ptr() noexcept { reset(); }

        // Returns a ptr to the bound type, asserts if null.
        const auto *get() const noexcept {
            ASSERT(m_reference);
            return &m_reference.value().get().m_object.value();
        }

        auto *get() noexcept {
            ASSERT(m_reference);
            return &m_reference.value().get().m_object.value();
        }

        // Access the stored reference by ptr, aborts if
        // not set.
        Type *operator->() noexcept { return get(); }

        const Type *operator->() const noexcept { return get(); }

        // Flags this items resource as invalid, preventing
        // further clones of the reference.
        bool setNotReady() noexcept {
            if (m_reference) {
                HandleTable::get().setNotReady(m_reference.value());
                return true;
            }
            return false;
        }

        // Returns true if this is a valid resource. For
        // checking whether the resource was set not ready, use
        // isReady/isNotReady apis.
        explicit operator bool() const noexcept {
            return m_reference.has_value();
        }

        // Returns the number of references the current handle has.
        // Negative value returned on error, no implicit checkout occurs here.
        int refCount() const noexcept {
            ASSERT(m_reference);
            return m_reference->get().m_refCount;
        }

        // The standard method that will clear the ownership and handle value
        // from this object.
        void reset() noexcept { putRef(); }

        // Returns true if this handle has a state of Ready.
        // A ready state indicates this resource is ready for use and has
        // not been marked for deletion.
        bool isReady() const noexcept {
            if (m_reference) return m_reference->get().m_state == STATE::Ready;
            return false;
        }

        // Returns the handle to this ptr, which can then be
        // sued to create a weak ref.
        Handle handle() const noexcept {
            if (m_reference)
                return {m_reference->get().m_sequence,
                        m_reference->get().m_index};
            return {};
        }

        Location location() const noexcept {
            if (m_reference) return {m_reference->get().m_location};
            return {};
        }

    private:
        // Attempts atomically increment the reference count and
        // return a clone of the slot ref. If the state of the reference is
        // not ready this will return an empty optional result.
        Opt<SlotRef> getRef() const noexcept {
            if (!m_reference) return {};

            auto &slot = m_reference->get();
            auto guard = slot.lock();

            // Check for not ready state
            if (slot.m_state == STATE::NotReady) return {};

            // Bump the ref and return the value
            slot.addRef();

            // And give them a copy of ours
            return m_reference;
        }

        // If we have a valid reference, calls the handle table back to
        // put, may destroy the object if the ref count drops to zero.
        void putRef() noexcept {
            if (!m_reference) return;

            HandleTable::get().put(_mv(m_reference.value()));
            m_reference.reset();
        }

        // If we hold a checked out reference, this member will contain it.
        Opt<SlotRef> m_reference = {};
    };

    // WeakPtr, works just like you'd expect. Instead of keeping
    // a ref around its basically a Ptr factory if you think about it, with
    // one trick in that it can be loosly bound to the hande address
    // that it holds only.
    class WPtr {
    public:
        WPtr() noexcept = default;

        WPtr(Ptr ptr) noexcept : m_handle(ptr.handle()) {}

        WPtr(Handle handle) noexcept : m_handle(handle) {}

        // just copy the handle around with no special state change needed
        // as we never hold any state in a weak ptr besides the handle value.
        WPtr(const WPtr &ptr) noexcept = default;
        WPtr &operator=(const WPtr &ptr) noexcept = default;

        WPtr(WPtr &&ptr) noexcept = default;
        WPtr &operator=(WPtr &&ptr) noexcept = default;

        [[nodiscard]] auto handle() const noexcept { return m_handle; }

        // Well now we sure do look like std::weak_ptr however
        // we have cache locality with frequency of access encouraged through
        // the last free slot.
        [[nodiscard]] decltype(auto) lock() const noexcept {
            return HandleTable::get().checkout(m_handle);
        }

        // Won't check out, but it will validate the state and handle
        explicit operator bool() const noexcept {
            return HandleTable::get().isValidAndReady(m_handle);
        }

        template <typename Buffer>
        auto __toString(Buffer &buff) const noexcept {
            buff << m_handle;
        }

    private:
        Handle m_handle;
    };

private:
    // Decrements the reference count on the slot.
    void put(SlotRef &&ref) noexcept {
        if (!m_init) return;

        auto &slot = ref.get();
        auto guard = slot.lock();

        ASSERT(slot.m_refCount > 0);

        LOGT("Put:", slot);

        slot.decRef();

        // A ref count of zero means we need to destroy it
        if (slot.m_refCount != 0) return;

        LOGT("Release:", slot);

        slot.release();

        // Unlock first, so an allocator doesn't needlessly try to trylock
        // us first
        guard.exec();

#if !defined(ROCKETRIDE_BUILD_DEBUG)
        // Now set the next free
        m_nextFreeIndex = slot.m_index;
#endif
    }

    // Flags the handle as not ready, we retain this logic in the
    // handle table itself to facilitate future notifications to external
    // parties interested in the life time of the slot.
    void setNotReady(SlotRef &ref) noexcept {
        if (!m_init) return;

        auto &slot = ref.get();
        auto guard = slot.lock();

        slot.setNotReady();

        // @@TODO perhaps notify someone, call mom or something...
    }

    // Looks up a slot atomically by its handle address, and retains the lock
    // allowing for atomic opreations between the calling function
    // and this one including optional state requirements and ability to leave
    // the slot locked on successful return.
    ErrorOr<SlotRef> lookup(Handle handle, bool keepLocked,
                            std::vector<STATE> &&rstates = {}) noexcept {
        // Sanity
        if (!handle) return {Ec::HandleInvalid, _location};

        // Look it up
        auto &slot = m_slots[handle.m_index];

        // Lock its state
        auto lockGuard = slot.lock();

        // Firstly, sequence id has to match
        if (slot.m_sequence != handle.m_sequence)
            return {Ec::HandleInvalidSeq, _location};

        // Now lookup required state, if specified
        if (!rstates.empty()) {
            if (util::noneOf(rstates, [&](auto &&rstate) {
                    return slot.m_state == rstate;
                }))
                return {Ec::HandleInvalidState, _location};
        }

        // See if they want the lock held
        if (keepLocked) lockGuard.cancel();

        return SlotRef{slot};
    }

    // Looks up a new slot, using the nextSlot_ index as a hint as to where
    // to start its iteration in the slot table. Each thread here will 'race' to
    // lock a slot, to set its state to Reserved.
    ErrorOr<SlotRef> reserve() noexcept {
        // Use the hint and atomically increment it for the next guy
        int startIndex;

        // Fix the wrap
        if (m_nextFreeIndex < 0 || m_nextFreeIndex >= MaxSlots)
            m_nextFreeIndex = 0;

        // Increment and continue to reserve
        startIndex = m_nextFreeIndex++;

        // Two passes, first will use the hint, second will start at the front
        for (auto pass = 1; pass <= 2; pass++) {
            // Second pass
            if (pass == 2) {
                // If we didn't already start at 0, we're done
                if (startIndex == 0) break;

                // Start at zero and find a free slot
                startIndex = 0;
            }

            for (auto index = startIndex; index < MaxSlots; index++) {
                auto &slot = m_slots[index];

                // Try to lock the slot, proceed to the next otherwise
                if (!slot.tryLock()) continue;

                if (slot.m_index == -1)
                    slot.m_index = index;
                else
                    ASSERT(slot.m_index == index);

                auto unlockGuard = util::Scope{[&] { slot.unlock(); }};

                // We locked it, see if its available for use
                if (slot.m_state != STATE::Init) continue;

                // Fantastic, set it reserved
                slot.setReserved();

                // And return a ref (leave locked)
                unlockGuard.cancel();
                return SlotRef{slot};
            }
        }

        // Failed to find a free one, return error
        dev::enterDebugger(_location);
        return Error{Ec::HandleOutOfSlots, _location};
    }

public:
    // Reserves a new slot, and constructs the object in place with no moves
    // (in fact the objects you can store in here don't even have to support
    // move as we use references in the slot using the handy Ref feature). It
    // then marks the slot as ready. The Checkout template argument when true
    // will cause this to return a Ptr ready to go with a checked out reference
    // to the object.
    template <bool Checkout = true, typename... Args>
    ErrorOr<Ptr> allocate(Location location, Args &&...args) noexcept {
        auto res = reserve();
        if (!res) return res.ccode();
        auto &slot = res->get();

        // Tell the slot to go to allocated state
        slot.allocate(location, std::forward<Args>(args)...);

        // Set ready state
        slot.setReady(++m_sequence);

        // Add a reference
        slot.addRef();

        // Manually unlock as we didn't get a guard this time around
        slot.unlock();

        // And return a ref into the ptr
        return Ptr{SlotRef{_mv(*res)}};
    }

    // Kinda like alloc but, we don't construct the type we look it up
    // by its handle address. On failure returns an empty Ptr.
    Ptr checkout(Handle handle) noexcept {
        auto res = lookup(handle, true, {{STATE::Ready}});
        if (!res) return res.ccode();
        auto &slot = res->get();

        // Well we can add a ref now
        slot.addRef();

        // All done with it
        slot.unlock();

        // And return a ref into the ptr
        return SlotRef{_mv(*res)};
    }

    // Checks if a handle address is valid, and marked Ready. On failure
    // returns false.
    bool isValidAndReady(Handle handle) noexcept {
        return lookup(handle, false, {{STATE::READY}});
    }

    // Returns the current allocation size from the atomic counter.
    [[nodiscard]] int size() const noexcept { return m_totalAllocated; }

    // Returns a vector of slots which are currently allocated,
    // used during leak detection and debugging.
    [[nodiscard]] std::vector<int> allocated() const noexcept {
        std::vector<int> result;

        for (auto index = 0; index < MaxSlots; index++) {
            auto &slot = m_slots[index];

            auto guard = slot.lock();
            if (slot.m_state != STATE::Init) result.push_back(index);
        }

        return result;
    }

    // Returns the string renderings sorted in a vector.
    [[nodiscard]] std::vector<Text> allocatedSlots(
        Opt<std::vector<int>> slotList = {}) noexcept {
        std::vector<Text> result;

        if (slotList) {
            result.reserve(slotList->size());
            for (auto &index : slotList.value()) {
                ASSERT(index < MaxSlots && index >= 0);
                auto &slot = m_slots[index];
                auto guard = slot.lock();
                if (slot.m_state == STATE::Init) continue;
                result.emplace_back(_ts(slot));
            }
        } else {
            result.reserve(size());
            for (auto index = 0; index < MaxSlots; index++) {
                auto &slot = m_slots[index];
                auto guard = slot.lock();
                if (slot.m_state == STATE::Init) continue;
                result.emplace_back(_ts(slot));
            }
        }

        std::sort(result.begin(), result.end());

        return result;
    }

private:
    // The next sequence, initialized to a random positive value, not including
    // the value 1
    Atomic<int> m_sequence = plat::IsDebug ? 1 : crypto::randomNumber<int>(1);

    // A hint where we may find the next free slot
    Atomic<int> m_nextFreeIndex =
        plat::IsDebug ? 0 : crypto::randomNumber<int>(0, MaxSlots);

    // The static array containing all possible slots
    Array<Slot, MaxSlots> m_slots = {};

    // Basic init flat as we are statically allocated, the handle system shuts
    // off and turns into a null op after this flag is cleared on a call to
    // deinit
    Atomic<bool> m_init = {true};

    // The total number of consumed handles
    Atomic<int> m_totalAllocated = {0};
};

}  // namespace ap::memory
