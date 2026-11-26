import io
import logging
import re

from aiembodied_workflows.activities import format_memory_hits, format_results
from aiembodied_workflows.interceptors import describe_call
from aiembodied_workflows.logs import LineFormatter, get_logger, setup_logging
from aiembodied_workflows.settings import Settings

LINE = re.compile(r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} (INFO |WARNING) \S.*")


def test_line_format_with_workflow_id_column():
    rec = logging.LogRecord("x", logging.INFO, "f", 1, 'decision: SAY "Morning!" (think 4.2 s)', None, None)
    rec.wfid = "life:echo"
    line = LineFormatter().format(rec)
    assert re.match(
        r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} INFO  life:echo {14}decision: SAY \"Morning!\" \(think 4\.2 s\)$", line
    ), line


def test_column_falls_back_to_the_short_logger_name():
    rec = logging.LogRecord("aiembodied.bridge", logging.WARNING, "f", 1, "lost it", None, None)
    assert " WARNING bridge " in LineFormatter().format(rec) or " WARNI" in LineFormatter().format(rec)
    assert "bridge" in LineFormatter().format(rec)


def test_setup_writes_stdout_and_a_rotating_file(tmp_path):
    buf = io.StringIO()
    path = tmp_path / "sub" / "workflows.log"
    handlers = setup_logging("INFO", str(path), stream=buf)
    try:
        get_logger("api").info("PUT /v1/agents -> 200 (3 ms)")
        get_logger("api").debug("hidden")
        for h in handlers:
            h.flush()
        assert "PUT /v1/agents" in buf.getvalue() and "hidden" not in buf.getvalue()
        assert LINE.match(path.read_text().splitlines()[0])
        assert any(
            type(h).__name__ == "RotatingFileHandler" and h.maxBytes == 5 * 1024 * 1024 and h.backupCount == 5
            for h in handlers
        )
    finally:
        for h in handlers:
            logging.getLogger().removeHandler(h)
            h.close()


def test_log_file_setting():
    assert Settings.from_env({"WORKFLOWS_LOG_FILE": "off"}).log_file is None
    assert Settings.from_env({"WORKFLOWS_LOG_FILE": "/x/y.log"}).log_file == "/x/y.log"
    assert Settings.from_env({"LOCALAPPDATA": "C:\\L"}).log_file.endswith("workflows.log")
    assert "aiembodied" in Settings.from_env({}).log_file


def test_describe_call():
    assert describe_call("app_act", [{"kind": "think", "avatarId": "echo"}]) == "act think for echo"
    assert describe_call("mem_get_flow", [{"avatarId": "echo", "name": "w"}]) == "mem_get_flow echo w"
    assert describe_call("web_search", ["rain"]) == "web_search rain"
    assert describe_call("mem_run_summaries", []) == "mem_run_summaries"


def test_formatters():
    assert format_results([]) == "(no results)"
    assert "Title: body (http://u)" in format_results([{"title": "Title", "content": "body", "url": "http://u"}])
    assert format_memory_hits([{"text": " a  b "}, {"text": ""}]) == "- a b"


def test_settings_defaults_and_env():
    s = Settings.from_env({})
    assert (
        s.temporal_address,
        s.namespace,
        s.port,
        s.agent_life,
        s.sleep_after_hours,
        s.sleep_hours,
        s.quiet_hours,
    ) == ("127.0.0.1:7233", "aiembodied", 8198, True, 24.0, 7.0, "22-7")
    e = Settings.from_env(
        {
            "AGENT_LIFE": "0",
            "SLEEP_AFTER_HOURS": "12",
            "MEMORY_TIMEZONE": "Asia/Singapore",
            "WORKFLOWS_PORT": "9000",
            "MEMORY_SERVICE_URL": "http://m:1/",
        }
    )
    assert not e.agent_life and e.sleep_after_hours == 12 and e.timezone == "Asia/Singapore" and e.port == 9000
    assert e.memory_url == "http://m:1"
    assert Settings.from_env({"WORKFLOWS_TIMEZONE": "UTC", "MEMORY_TIMEZONE": "Asia/Tokyo"}).timezone == "UTC"
    assert e.flow_config()["sleepAfterHours"] == 12
