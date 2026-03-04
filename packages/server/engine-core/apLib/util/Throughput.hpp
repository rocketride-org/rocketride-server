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

// A rolling window averaging rate calculator capable of calculating throughout
class Throughput {
public:
    // Declare our interval type, we use milliseconds here even though we
    // calculate rates as per/second so that we can calculate sub second
    // precision
    using Interval = time::milliseconds;

    // Declare our bucket entry, this describes a point in time
    // with a max and min amount of entries
    using Bucket = CountSize;

    // Gets returned to snapshot the current state of the throughput
    // during a run.
    struct Stats : public CountSize {
        long double rateSize = 0;
        long double rateCount = 0;

        Interval runTime;

        // Renders a these stats as a string in the form of:
        // rate_count:total_count(rate_size:total_size)[duration]
        template <typename Buffer>
        void __toString(Buffer &buf) const noexcept {
            // For the count precision don't bother if its above 10, its not
            // very helpful saying 1,000.41 files /sec
            _tsb(buf,
                 string::toHumanCount(
                     util::adjustPrecision(rateCount, rateCount < 10 ? 2 : 0)),
                 "/sec: ");
            if (rateSize)
                _tsb(buf, count, " (", _nc<Size>(rateSize).toString(false),
                     "/sec) Total:", size.toString(false), " [", runTime, "]");
            else
                _tsb(buf, "(", count, ") [", runTime, "]");
        }
    };

    // Returns started state
    bool started() const noexcept { return m_started; }

    // Access the total reported size
    CountSize counts() const noexcept {
        auto guard = lock();
        return m_counts;
    }

    // Sets up the throughput for use, sets the bucket count
    // on the rolling window.
    Throughput(uint32_t maxBuckets = 32, Interval interval = 1s) noexcept
        : m_maxBuckets(maxBuckets), m_interval(interval) {}

    // We provide a now call mostly so unit tests can mock this so we can
    //  manually be in control of the clock.
    virtual Interval currentTimestamp() const noexcept {
        return time::duration_cast<Interval>(
            time::nowSystem().time_since_epoch());
    }

    // Starts the throughput virtual timer (no actual thread is allocated)
    // and initializes our state.
    void start() noexcept {
        auto guard = lock();

        if (m_started) return;

        initializeBuckets();

        // Initialize our state
        m_startTime = currentTimestamp();
        m_stopTime = Interval::zero();
        m_started = true;
        m_counts.size = 0;
        m_counts.count = 0;
        m_lastUpdateTime = m_startTime;
    }

    // Stops the virtual timer and sets the final stop time for final
    // summary rate calculations.
    void stop() noexcept {
        auto guard = lock();
        if (m_started) {
            m_started = false;
            m_stopTime = currentTimestamp();
        }
    }

    // Stops/starts the virtual rate timer.
    void restart() noexcept {
        stop();
        start();
    }

    // Resets throughput state
    void reset(const CountSize &counts = {}) noexcept {
        auto guard = lock();
        stop();
        m_startTime = {};
        m_stopTime = {};
        m_buckets.clear();
        m_lastUpdateTime = {};
        m_counts = counts;
    }

    // Returns the total size processed till now.
    Size currentSize() noexcept {
        Size size;

        auto guard = lock();

        // If we've stopped, return total size
        if (!m_started && m_stopTime != Interval::zero())
            size = m_counts.size;
        else {
            // Update while we're here
            update();

            // Add up all the buckets sizes
            size += m_currentBucket.size;
            for (auto &bucket : m_buckets) size += bucket.size;
        }

        return size;
    }

    // Returns the total count of processed items till now.
    Count currentCount() noexcept {
        Count count;

        auto guard = lock();

        // If we've stopped, return total count
        if (!m_started && m_stopTime != Interval::zero())
            count = m_counts.count;
        else {
            // Update while we're here
            update();

            // Add up all the buckets sizes
            count += m_currentBucket.count;
            for (auto &bucket : m_buckets) count += bucket.count;
        }

        return count;
    }

    // This function is what gets called by the user as they complete work.
    void report(Size size = 0, Count count = 1) noexcept {
        auto guard = lock();

        // Start implicitly if need be
        if (!m_started) start();

        // Roll our windows forward if needed
        update();

        // Update the current bucket
        m_currentBucket.count += count;
        m_currentBucket.size += size;

        m_counts.size += size;
        m_counts.count += count;
    }

    // Moves time forward based on the current time distance from
    // next interval. Once we cross that threshold we move new buckets
    // in front, expiring old ones off the end as we go. This is the 'tick'
    // function of this class and its what drives our sliding window forward.
    void update() noexcept {
        auto guard = lock();

        // If we've been stopped, keep the buckets exactly as they are
        if (m_started == false) return;

        // Compare that to our last update, and divide that by our interval,
        // thats how many buckets we have to move forward
        auto elapsedTime = currentTimestamp() - m_lastUpdateTime;
        auto elapsedBuckets = elapsedTime / m_interval;

        // If we've gone beyond the current one, push as many in as we've
        // elapsed
        if (elapsedBuckets) {
            // We'll progress in fixed chunks of our interval time
            m_lastUpdateTime += m_interval * elapsedBuckets;

            // Roll our buckets forward x times
            rollForward(elapsedBuckets);
        }
    }

    // Calculates an average throughput in per seconds
    template <class Type>
    static long double calculateAverage(Type size, Interval duration) noexcept {
        // Divide the amount completed by the duration that has passed
        long double rate = 0;
        if (duration != Interval::zero()) {
            auto sec = time::seconds(duration / 1s);
            rate = size / sec;
        }

        return rate;
    }

    // Returns the duration of the total time ran between start and now
    // or start and stop.
    Interval runTime() const noexcept {
        auto guard = lock();
        if (m_started)
            return currentTimestamp() - m_startTime;
        else if (m_stopTime != Interval::zero())
            return m_stopTime - m_startTime;
        else
            return Interval::zero();
    }

    // Returns a summarized stats structure of all possible
    // stored statistics, it is with this api that we allow for a
    // custom bucket limit, allowing the caller to get stats for
    // portions of the window.
    Stats stats() noexcept {
        Stats stats;

        auto guard = lock();

        update();

        stats.runTime = runTime();
        stats.size = m_counts.size;
        stats.count = m_counts.count;

        // If we are started and have some samples use the live sliding window
        // rate
        if (m_started && !m_buckets.empty()) {
            auto [rateSize, rateCount] = calculateRate();
            stats.rateSize = rateSize;
            stats.rateCount = rateCount;
        }
        // Otherwise if we are not started, or we are started but have no
        // samples, use an overall average of the amount completed and the
        // current runtime. This allows the scenario where you started the rate
        // calculator, you fed it some data, but the first window time hasn't
        // passed yet to still render some useful numbers.
        else if (m_counts.count || m_counts.size) {
            stats.rateSize = calculateAverage(stats.size, stats.runTime);
            stats.rateCount = calculateAverage(stats.count, stats.runTime);
        }

        return stats;
    }

    // Returns the number of samples at the interval window
    auto sampleCount() const noexcept { return completedBucketCount(); }

    // Acquire a lock to the rate calculator
    async::MutexLock::Guard lock() const noexcept { return m_lock.acquire(); }

    // Assignment (assumed locked)
    decltype(auto) operator=(const Throughput &other) noexcept {
        if (this == &other) return *this;
        m_interval = other.m_interval;
        m_counts = other.m_counts;
        m_started = other.m_started;
        m_stopTime = other.m_stopTime;
        m_lastUpdateTime = other.m_lastUpdateTime;
        m_buckets = other.m_buckets;
        m_currentBucket = other.m_currentBucket;
        m_maxBuckets = other.m_maxBuckets;
        if (m_started && !m_startTime.count()) m_startTime = currentTimestamp();
        return *this;
    }

    // Add (assumed locked)
    decltype(auto) operator+=(const Throughput &other) noexcept {
        if (this == &other) return *this;
        m_interval = other.m_interval;
        m_counts += other.m_counts;
        m_started = other.m_started;
        m_stopTime = other.m_stopTime;
        m_lastUpdateTime = other.m_lastUpdateTime;
        m_buckets = other.m_buckets;
        m_currentBucket = other.m_currentBucket;
        m_maxBuckets = other.m_maxBuckets;

        if (m_started && !m_startTime.count()) m_startTime = currentTimestamp();

        return *this;
    }

protected:
    // Returns the number of buckets if we are started, otherwise we
    // return 0 since the buckets are inactive when stopped.
    uint32_t completedBucketCount() const noexcept {
        auto guard = lock();
        if (!m_started) return 0;
        return numericCast<uint32_t>(m_buckets.size());
    }

    // Roll the virutal time position forward in the bucket chain
    template <class Type>
    void rollForward(Type count) noexcept {
        if (count >= m_maxBuckets) {
            m_buckets.clear();
            m_currentBucket = Bucket();
        }
        for (auto i = 0; i < count; i++) rollForward();
    }

    // Roll the virtual time position forward by one in the bucket chain
    void rollForward() noexcept {
        m_buckets.push_front(m_currentBucket);
        m_currentBucket = Bucket();
        if (m_buckets.size() > m_maxBuckets) m_buckets.pop_back();
    }

    // Internal function that sums up the rates of all our buckets
    // then averages them across the sample size
    Pair<long double, long double> calculateRate() noexcept {
        // No samples no rate
        if (m_buckets.empty()) return {};

        // Add up all the rates from each of our samples
        long double sizeRate = 0, countRate = 0;
        for (auto &sample : m_buckets) {
            sizeRate += calculateAverage(sample.size, m_interval);
            countRate += calculateAverage(sample.count, m_interval);
        }

        // Now divide them by the sample size
        sizeRate /= m_buckets.size();
        countRate /= m_buckets.size();

        return {sizeRate, countRate};
    }

    // Clears our bucket array and current bucket stats
    void initializeBuckets() noexcept {
        auto guard = lock();
        m_buckets.clear();
        m_currentBucket = Bucket();
    }

    // Avoid the heap, use stack allocators for our bucket list
    using BucketAllocator = memory::ShortAllocator<Bucket, 512>;
    using BucketArena = typename BucketAllocator::arena_type;

    // The interval for the bucket calculator, anytime we get
    // called to update we'll figure out how long its been since the
    // last and roll the buckets forward
    Interval m_interval;

    // This flag indicates whether we are started or not
    bool m_started = false;

    // Timestamps for calls to start and stop.
    Interval m_startTime = {}, m_stopTime = {};

    // Totals kept between start/stop runs.
    CountSize m_counts;

    // This is our 'current position' in time.
    Interval m_lastUpdateTime;

    // Lock for our class
    mutable async::MutexLock m_lock;

    // Our fixed queue, where each bucket lives, using a stack allocator to
    // ensure low overhead during rate reporting
    BucketArena m_bucketArena;
    std::list<Bucket, BucketAllocator> m_buckets{m_bucketArena};

    // This is our current bucket that gets lobbed onto the bucket
    // list when the next interval passes
    Bucket m_currentBucket;

    // Max cap on the buckets
    uint32_t m_maxBuckets = 0;
};

}  // namespace ap::util
