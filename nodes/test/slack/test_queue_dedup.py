# =============================================================================
# MIT License
# =============================================================================

from nodes.slack.slack_events import TtlDedupCache


def test_dedup_cache_tracks_ids_until_the_ttl_expires():
    now = [100.0]
    cache = TtlDedupCache(clock=lambda: now[0])

    assert not cache.contains('Ev1')
    cache.add('Ev1')
    assert cache.contains('Ev1')

    now[0] += 600
    assert not cache.contains('Ev1')


def test_dedup_cache_uses_a_supplied_ttl_while_defaulting_to_600_seconds():
    now = [100.0]
    configured = TtlDedupCache(ttl_seconds=7, clock=lambda: now[0])
    default = TtlDedupCache(clock=lambda: now[0])
    configured.add('Ev1')
    default.add('Ev2')

    now[0] += 7

    assert not configured.contains('Ev1')
    assert default.contains('Ev2')


def test_dedup_cache_evicts_the_oldest_id_beyond_its_hard_cap():
    now = [100.0]
    cache = TtlDedupCache(clock=lambda: now[0])
    for index in range(10_001):
        cache.add(f'Ev{index}')

    assert not cache.contains('Ev0')
    assert cache.contains('Ev10000')
