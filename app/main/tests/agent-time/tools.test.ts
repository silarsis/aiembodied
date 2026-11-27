import { describe, expect, it, vi } from 'vitest';
import { WORKFLOW_TOOL_NAMES, createAgentTimeTools } from '../../src/agent-time/tools.js';
import { WorkflowsClient, WorkflowsError } from '../../src/agent-time/workflows-client.js';

type Call = { method: string; url: string; body: unknown; auth: string | null };

function setup(handler: (call: Call) => { status?: number; body: unknown } = () => ({ body: {} })) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get('authorization'),
    };
    calls.push(call);
    const answer = handler(call);
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as unknown as typeof fetch;
  const client = new WorkflowsClient({ baseUrl: 'http://wf', token: 'tok', fetchFn });
  const tools = Object.fromEntries(
    createAgentTimeTools({ client, now: () => new Date('2026-11-26T00:00:00Z') }).map((tool) => [
      tool.toolName,
      tool,
    ]),
  );
  return { calls, tools };
}

describe('agent time tools', () => {
  it('registers every tool under the workflows server with the right levels', () => {
    const { tools } = setup();
    expect(Object.keys(tools).sort()).toEqual([...WORKFLOW_TOOL_NAMES].sort());
    expect(tools.remind_me.confirmationLevel).toBe('notify');
    for (const name of WORKFLOW_TOOL_NAMES.filter((n) => n !== 'remind_me'))
      expect(tools[name].confirmationLevel).toBe('none');
    expect(tools.my_flows.readOnly).toBe(true);
    expect(tools.my_plans.readOnly).toBe(true);
    expect(tools.write_flow.serverId).toBe('workflows');
    expect(tools.write_flow.description).toContain('wait_for');
    expect(tools.write_flow.description).toContain('{{name}}');
  });

  it('remind_me posts for the calling avatar, defaulting to echo', async () => {
    const { calls, tools } = setup(() => ({
      body: { workflowId: 'remind:1', intentionId: 'i', dueAt: '2026-11-26T01:00:00Z' },
    }));
    expect(
      await tools.remind_me.execute(
        { text: 'Bins', inSeconds: 3600, alarm: true },
        { avatarId: 'sage' },
      ),
    ).toContain('2026-11-26T01:00:00Z');
    await tools.remind_me.execute({ text: 'Tea', at: '2026-11-26T18:00:00+08:00' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'http://wf/v1/reminders',
      auth: 'Bearer tok',
      body: { avatarId: 'sage', text: 'Bins', inSeconds: 3600, alarm: true },
    });
    expect(calls[1].body).toEqual({
      avatarId: 'echo',
      text: 'Tea',
      at: '2026-11-26T10:00:00.000Z',
    });
    await tools.remind_me.execute({ text: 'x', when: 90 });
    expect(calls[2].body).toMatchObject({ inSeconds: 90 });
    await expect(tools.remind_me.execute({ text: 'x' })).rejects.toThrow(/Say when/);
    await expect(tools.remind_me.execute({ text: 'x', at: 'soon' })).rejects.toThrow(
      /could not read the time/,
    );
    await expect(tools.remind_me.execute({ inSeconds: 5 })).rejects.toThrow(/needs "text"/);
  });

  it('wake_me_later and watch_for send their bodies', async () => {
    const { calls, tools } = setup(() => ({
      body: { workflowId: 'w:1', intentionId: 'i', dueAt: 'D' },
    }));
    await tools.wake_me_later.execute({ note: 'Look again', inSeconds: 60 });
    expect(calls[0]).toMatchObject({
      url: 'http://wf/v1/wakeups',
      body: { avatarId: 'echo', note: 'Look again', inSeconds: 60 },
    });
    await tools.watch_for.execute({
      condition: { kind: 'entity', entityId: 'binary_sensor.door', state: 'on' },
      then: '{"say": "Door!"}',
      untilHours: 2,
    });
    expect(calls[1]).toMatchObject({
      url: 'http://wf/v1/watches',
      body: {
        condition: { entityId: 'binary_sensor.door' },
        then: { say: 'Door!' },
        untilHours: 2,
      },
    });
    await expect(tools.watch_for.execute({ condition: {} })).rejects.toThrow(/then/);
  });

  it('write_flow saves, and a 422 comes back as a list the model can fix', async () => {
    const { calls, tools } = setup((call) =>
      call.method === 'PUT' && (call.body as { description: string }).description === 'bad'
        ? {
            status: 422,
            body: {
              detail: {
                errors: ['steps[2].wait: needs seconds or until', 'steps[3]: unknown step "dance"'],
              },
            },
          }
        : { body: { name: 'f', version: 3 } },
    );
    const good = {
      name: 'morning',
      description: 'Morning',
      definition: { steps: [{ say: 'hi' }] },
      trigger: { kind: 'schedule', cron: '30 7 * * 1-5' },
    };
    expect(await tools.write_flow.execute(good, { avatarId: 'echo' })).toContain('version 3');
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: 'http://wf/v1/flows/echo/morning',
      body: { description: 'Morning', trigger: good.trigger },
    });
    // A definition given as JSON text is accepted.
    await tools.write_flow.execute({ ...good, definition: JSON.stringify(good.definition) });
    expect((calls[1].body as { definition: unknown }).definition).toEqual(good.definition);
    const error = await tools.write_flow
      .execute({ ...good, description: 'bad' })
      .catch((e: Error) => e);
    expect((error as Error).message).toContain('steps[2].wait: needs seconds or until');
    expect((error as Error).message).toContain('unknown step "dance"');
    await expect(tools.write_flow.execute({ ...good, trigger: undefined })).rejects.toThrow(
      /trigger/,
    );
  });

  it('flows, plans, intentions, signals and sleep use the right routes', async () => {
    const { calls, tools } = setup((call) =>
      call.url.includes('/v1/flows?') ? { body: { flows: [] } } : { body: { ok: true } },
    );
    expect(await tools.my_flows.execute({}, { avatarId: 'sage' })).toContain('not written any');
    await tools.my_flows.execute({ name: 'morning' });
    await tools.run_flow.execute({ name: 'morning', inputs: { city: 'Perth' } });
    await tools.my_plans.execute({});
    await tools.set_goal.execute({ text: 'Learn his tastes', why: 'dinners' });
    await tools.set_intention.execute({
      text: 'Ask about the interview',
      dueAt: '2026-11-27T01:00:00Z',
    });
    await tools.change_plan.execute({
      workflowId: 'watch:1',
      signal: 'snooze',
      args: { seconds: 3600 },
    });
    await tools.drop_plan.execute({ workflowId: 'sched:echo:morning', why: 'no longer needed' });
    await tools.go_to_sleep.execute({ reason: 'late' });
    expect(calls.map((call) => `${call.method} ${call.url.replace('http://wf', '')}`)).toEqual([
      'GET /v1/flows?avatarId=sage',
      'GET /v1/flows/echo/morning',
      'POST /v1/flows/echo/morning/run',
      'GET /v1/plans?avatarId=echo',
      'POST /v1/intentions',
      'POST /v1/intentions',
      'POST /v1/plans/watch%3A1/signal',
      'DELETE /v1/plans/sched%3Aecho%3Amorning?why=no%20longer%20needed',
      'POST /v1/agents/echo/sleep',
    ]);
    expect(calls[2].body).toEqual({ inputs: { city: 'Perth' } });
    expect(calls[4].body).toEqual({
      avatarId: 'echo',
      kind: 'goal',
      text: 'Learn his tastes',
      why: 'dinners',
    });
    expect(calls[5].body).toMatchObject({ kind: 'intention', dueAt: '2026-11-27T01:00:00.000Z' });
    expect(calls[6].body).toEqual({ signal: 'snooze', args: { seconds: 3600 } });
    expect(calls[8].body).toEqual({ reason: 'late' });
  });

  it('turns an unreachable service into a tool error', async () => {
    const client = new WorkflowsClient({
      baseUrl: 'http://wf',
      fetchFn: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    const tools = Object.fromEntries(
      createAgentTimeTools({ client }).map((tool) => [tool.toolName, tool]),
    );
    await expect(tools.my_plans.execute({})).rejects.toThrow(/not reachable/);
    await expect(client.health()).rejects.toBeInstanceOf(WorkflowsError);
  });
});
