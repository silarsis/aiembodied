import { describe, expect, it, vi } from 'vitest';
import { TIME_NOTE, withTimeNote } from '../../src/agent-time/prompt.js';
import { QuietSaves, MAX_QUIET_SAVES } from '../../src/agent-time/quiet-saves.js';
import { agentTimeSettingsFromEnv } from '../../src/agent-time/settings.js';
import { AgentSleep } from '../../src/agent-time/sleep.js';
import { QUESTION_TOOL_ID, withQuestionTool } from '../../src/agent-time/ask.js';
import { WorkflowsClient, describeDetail } from '../../src/agent-time/workflows-client.js';

describe('agent time parts', () => {
  it('reads the settings: on by default, off with WORKFLOWS_ENABLED=0, life off with AGENT_LIFE=0', () => {
    expect(agentTimeSettingsFromEnv({})).toMatchObject({
      enabled: true,
      agentLife: true,
      url: 'http://127.0.0.1:8198',
      token: null,
      temporalUiUrl: 'http://127.0.0.1:8233',
    });
    expect(agentTimeSettingsFromEnv({ WORKFLOWS_ENABLED: '0' })).toMatchObject({
      enabled: false,
      agentLife: false,
    });
    expect(agentTimeSettingsFromEnv({ AGENT_LIFE: '0' })).toMatchObject({
      enabled: true,
      agentLife: false,
    });
    expect(
      agentTimeSettingsFromEnv({ WORKFLOWS_URL: 'http://x:1/', WORKFLOWS_API_TOKEN: ' t ' }),
    ).toMatchObject({ url: 'http://x:1', token: 't' });
  });

  it('keeps the time note short and adds it after the instructions', () => {
    expect(TIME_NOTE.split(/\s+/).length).toBeLessThan(120);
    expect(withTimeNote('You are Echo.')).toBe(`You are Echo.\n\n${TIME_NOTE}`);
    expect(withTimeNote(undefined)).toBe(TIME_NOTE);
  });

  it('keeps the last five quiet saves and clears them', () => {
    const saves = new QuietSaves();
    for (let n = 1; n <= 7; n += 1) saves.add('echo', `save ${n}`);
    saves.add('echo', '   ');
    expect(saves.list('echo')).toHaveLength(MAX_QUIET_SAVES);
    expect(saves.list('echo')[0]).toBe('save 3');
    expect(saves.list('sage')).toEqual([]);
    saves.clear('echo');
    expect(saves.list('echo')).toEqual([]);
  });

  it('tells listeners when sleep changes, once per change', () => {
    const sleep = new AgentSleep();
    const seen: string[][] = [];
    sleep.onChanged((list) => seen.push(list));
    expect(sleep.set('echo', true, 'late')).toBe(true);
    expect(sleep.set('echo', true)).toBe(false);
    sleep.forget('echo');
    expect(seen).toEqual([['echo'], []]);
  });

  it('answers the question tool itself and passes other tools through', async () => {
    const execute = vi.fn(async () => ({ success: true, data: 'x', durationMs: 1 }));
    const registry = withQuestionTool({ execute, get: () => undefined });
    expect(await registry.execute(QUESTION_TOOL_ID, {})).toMatchObject({
      success: true,
      data: 'yes',
    });
    await registry.execute('other', { a: 1 });
    expect(execute).toHaveBeenCalledWith('other', { a: 1 }, undefined);
  });

  it('reads service error details', () => {
    expect(describeDetail('nope')).toEqual({ message: 'nope', errors: [] });
    expect(describeDetail({ errors: ['a', 'b'] })).toEqual({ message: 'a; b', errors: ['a', 'b'] });
    expect(describeDetail([{ loc: ['body', 'text'], msg: 'field required' }]).message).toBe(
      'text: field required',
    );
  });

  it('client health and error text', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/health')
        ? new Response(
            JSON.stringify({ ok: true, temporal: true, agentLife: true, agents: ['echo'] }),
          )
        : new Response(JSON.stringify({ detail: 'Workflow not found' }), { status: 404 }),
    ) as unknown as typeof fetch;
    const client = new WorkflowsClient({ baseUrl: 'http://wf', fetchFn });
    expect((await client.health()).agents).toEqual(['echo']);
    await expect(client.life('echo')).rejects.toMatchObject({
      message: 'Workflow not found',
      status: 404,
    });
  });
});
