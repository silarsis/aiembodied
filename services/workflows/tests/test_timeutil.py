from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest
from aiembodied_workflows.timeutil import (
    due_from,
    hhmm,
    in_quiet_hours,
    iso_z,
    next_local_time,
    parse_iso,
    parse_quiet_hours,
)


def test_parse_quiet_hours():
    assert parse_quiet_hours("22-7") == (22, 7)
    assert parse_quiet_hours(" 9 - 17 ") == (9, 17)
    assert parse_quiet_hours("24-6") == (0, 6)
    for bad in (None, "", "5-5", "25-3", "abc", "22"):
        assert parse_quiet_hours(bad) is None


def test_in_quiet_hours_wraps_midnight():
    q = parse_quiet_hours("22-7")
    assert in_quiet_hours(q, 22) and in_quiet_hours(q, 23) and in_quiet_hours(q, 0) and in_quiet_hours(q, 6)
    assert not in_quiet_hours(q, 7) and not in_quiet_hours(q, 12) and not in_quiet_hours(q, 21)
    day = parse_quiet_hours("9-17")
    assert in_quiet_hours(day, 9) and not in_quiet_hours(day, 17)
    assert not in_quiet_hours(None, 3)


def test_parse_iso_and_iso_z():
    assert parse_iso("2026-11-26T01:02:03Z") == datetime(2026, 11, 26, 1, 2, 3, tzinfo=timezone.utc)
    assert parse_iso("2026-11-26T01:02:03+08:00").utcoffset().total_seconds() == 8 * 3600
    assert parse_iso("2026-11-26T01:02:03").tzinfo is not None
    assert (
        iso_z(datetime(2026, 11, 26, 9, 2, 3, 456000, tzinfo=ZoneInfo("Asia/Singapore"))) == "2026-11-26T01:02:03.456Z"
    )
    with pytest.raises(ValueError):
        parse_iso("tomorrow")


def test_next_local_time():
    tz = ZoneInfo("Asia/Singapore")
    now = datetime(2026, 11, 25, 22, 0, tzinfo=timezone.utc)  # 06:00 local on the 26th
    assert next_local_time(now, "07:30", tz) == datetime(2026, 11, 25, 23, 30, tzinfo=timezone.utc)
    later = datetime(2026, 11, 25, 23, 30, tzinfo=timezone.utc)  # exactly 07:30 local: next is tomorrow
    assert next_local_time(later, "07:30", tz) == datetime(2026, 11, 26, 23, 30, tzinfo=timezone.utc)
    with pytest.raises(ValueError):
        next_local_time(now, "7pm", tz)
    with pytest.raises(ValueError):
        next_local_time(now, "25:00", tz)


def test_due_from():
    now = datetime(2026, 11, 25, 12, 0, tzinfo=timezone.utc)
    assert due_from(now, None, 90) == datetime(2026, 11, 25, 12, 1, 30, tzinfo=timezone.utc)
    assert due_from(now, "2026-11-25T13:00:00Z", 5) == datetime(2026, 11, 25, 13, 0, tzinfo=timezone.utc)
    with pytest.raises(ValueError):
        due_from(now, None, None)
    with pytest.raises(ValueError):
        due_from(now, None, -1)


def test_hhmm():
    assert hhmm(datetime(2026, 11, 25, 12, 5, tzinfo=timezone.utc), ZoneInfo("Asia/Singapore")) == "20:05"
