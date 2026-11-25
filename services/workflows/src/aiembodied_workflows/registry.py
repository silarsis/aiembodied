"""The workflow classes, the sandbox setup and the workers."""

from __future__ import annotations

from temporalio.client import Client
from temporalio.worker import Worker
from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner, SandboxRestrictions

from .activities import Activities
from .interceptors import ActivityLogInterceptor
from .settings import TASK_QUEUE, THINK_QUEUE
from .wf.flow import AgentFlow
from .wf.life import AgentLife
from .wf.simple import Reminder, WakeMe
from .wf.watch import Watch

WORKFLOWS = [AgentLife, Reminder, WakeMe, Watch, AgentFlow]
THINK_ACTIVITY_NAMES = ("app_act",)


def sandbox_runner() -> SandboxedWorkflowRunner:
    """The workflow sandbox, with this package passed through (its modules are pure and deterministic)."""
    return SandboxedWorkflowRunner(
        restrictions=SandboxRestrictions.default.with_passthrough_modules("aiembodied_workflows"))


def make_workers(client: Client, acts: Activities) -> list[Worker]:
    """Two workers: `agents` (workflows and light activities) and `think` (one model call or tool at a time)."""
    interceptors = [ActivityLogInterceptor()]
    agents = Worker(client, task_queue=TASK_QUEUE, workflows=WORKFLOWS, activities=acts.all(),
                    workflow_runner=sandbox_runner(), interceptors=interceptors)
    think = Worker(client, task_queue=THINK_QUEUE, activities=[acts.app_act], max_concurrent_activities=1,
                   interceptors=interceptors)
    return [agents, think]
