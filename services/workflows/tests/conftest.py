import asyncio
import os
import sys
from pathlib import Path

import pytest
import pytest_asyncio

sys.path.insert(0, str(Path(__file__).parent))  # lets tests import fakes.py


_UNAVAILABLE: str | None = None


@pytest_asyncio.fixture
async def temporal_env():
    """A time-skipping Temporal test server. Skips the test when the server cannot be downloaded or started
    (the sandbox has no access to temporal.download; GitHub Actions does)."""
    if os.environ.get("SKIP_TEMPORAL_TESTS"):
        pytest.skip("SKIP_TEMPORAL_TESTS is set")
    global _UNAVAILABLE
    if _UNAVAILABLE:
        pytest.skip(_UNAVAILABLE)
    from temporalio.testing import WorkflowEnvironment

    try:
        env = await asyncio.wait_for(WorkflowEnvironment.start_time_skipping(), timeout=60)
    except Exception as exc:  # noqa: BLE001
        _UNAVAILABLE = f"Temporal test server is not available here: {type(exc).__name__}: {str(exc)[:100]}"
        pytest.skip(_UNAVAILABLE)
    try:
        yield env
    finally:
        await env.shutdown()
