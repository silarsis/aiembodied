import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelRoutingView, ModelServerView } from '../../../main/src/config/config-manager.js';
import { builtInServers, defaultRoutes } from '../../../main/src/config/model-routing.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../../../main/src/config/provider-settings.js';
import type { ServerProbe } from '../../../main/src/config/model-server-probe.js';
import type { ModelsBridge } from '../../src/preload-api.js';
import { ModelsDialog } from '../../src/settings/models-dialog.js';

const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value() {
      this.open = false;
    },
  });
});
afterAll(() => {
  for (const [name, descriptor] of [
    ['showModal', originalShow],
    ['close', originalClose],
  ] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});

function baseView(): ModelRoutingView {
  const servers: ModelServerView[] = builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }).map(
    (server) => ({ ...server, hasKey: false }),
  );
  return { servers, routes: defaultRoutes(DEFAULT_PROVIDER_SETTINGS) };
}

function bridge(initial = baseView()) {
  let view = initial;
  const api = {
    get: vi.fn(async () => view),
    probe: vi.fn(async (_target: { serverId?: string } | { draft: unknown }): Promise<ServerProbe> => ({
      status: 'up',
      models: { chat: ['qwen-next-flash', 'gemma'] },
      checkedAt: 1,
    })),
    saveServer: vi.fn(async (server: { id?: string; name?: string; type?: string; url?: string }) => {
      const id = server.id ?? 'server-new';
      const added: ModelServerView = {
        id,
        name: server.name ?? 'Chat model server',
        type: (server.type ?? 'chat') as ModelServerView['type'],
        url: server.url ?? '',
        builtIn: false,
        managed: false,
        hasKey: false,
      };
      view = { ...view, servers: [...view.servers.filter((entry) => entry.id !== id), added] };
      return { id, models: view };
    }),
    removeServer: vi.fn(async () => view),
    setRoute: vi.fn(async (use: string, route: ModelRoutingView['routes']['llm']) => {
      view = { ...view, routes: { ...view.routes, [use]: route } };
      return view;
    }),
    setKey: vi.fn(async (serverId: string, key: string) => {
      view = { ...view, servers: view.servers.map((entry) => (entry.id === serverId ? { ...entry, hasKey: Boolean(key) } : entry)) };
      return view;
    }),
  };
  return api as typeof api & ModelsBridge;
}

describe('ModelsDialog', () => {
  it('checks every server when it opens, so every status dot is right without clicking', async () => {
    const api = bridge();
    const view = baseView();
    render(<ModelsDialog api={api} onClose={vi.fn()} />);
    await waitFor(() => expect(api.probe).toHaveBeenCalledTimes(view.servers.length));
    const checked = api.probe.mock.calls.map(([target]) => ('serverId' in target ? target.serverId : null));
    expect(new Set(checked)).toEqual(new Set(view.servers.map((server) => server.id)));
    const rail = screen.getByRole('navigation', { name: 'Model uses' });
    await waitFor(() => {
      const dots = within(rail).getAllByRole('img');
      expect(dots.length).toBeGreaterThan(1);
      // Every use shows its server's status, or Off when it has none; nothing is left unchecked.
      for (const dot of dots) expect(dot.className).toMatch(/is-(up|off)$/);
      expect(within(rail).queryAllByLabelText('Not checked')).toEqual([]);
    });
  });

  it('lists only the picked server’s models, and reads them again on Refresh list', async () => {
    const api = bridge();
    const lists: Record<string, string[]> = { 'local-llm': ['qwen-next-flash', 'gemma'], openai: ['gpt-4.1', 'gpt-4.1-mini'] };
    api.probe.mockImplementation(async (target) => ({
      status: 'up',
      models: { chat: lists['serverId' in target ? (target.serverId ?? '') : ''] ?? [] },
      checkedAt: 1,
    }));
    render(<ModelsDialog api={api} onClose={vi.fn()} />);
    const runsOn = (await screen.findByLabelText('Runs on')) as HTMLSelectElement;
    expect(runsOn.value).toBe('local-llm');
    const options = async () =>
      [...((await screen.findByLabelText('Model')) as HTMLSelectElement).options].map((option) => option.value);
    await waitFor(async () => expect(await options()).toEqual(['', 'qwen-next-flash', 'gemma', '__other']));

    fireEvent.change(runsOn, { target: { value: 'openai' } });
    await waitFor(async () => expect(await options()).toEqual(['', 'gpt-4.1', 'gpt-4.1-mini', '__other']));

    lists.openai = ['gpt-5'];
    fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }));
    await waitFor(async () => expect(await options()).toEqual(['', 'gpt-5', '__other']));
    expect(screen.getByRole('button', { name: /Concept image/ })).toBeTruthy();
  });

  it('moves a job to another server and saves a model picked or typed', async () => {
    const api = bridge();
    const onChanged = vi.fn();
    render(<ModelsDialog api={api} onClose={vi.fn()} onChanged={onChanged} />);
    fireEvent.change(await screen.findByLabelText('Runs on'), { target: { value: 'openai' } });
    await waitFor(() => expect(api.setRoute).toHaveBeenCalledWith('llm', expect.objectContaining({ server: 'openai', model: undefined })));
    await waitFor(() => expect(screen.getByLabelText('Model').tagName).toBe('SELECT'));
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gemma' } });
    await waitFor(() => expect(api.setRoute).toHaveBeenLastCalledWith('llm', expect.objectContaining({ server: 'openai', model: 'gemma' })));

    fireEvent.change(screen.getByLabelText('Model'), { target: { value: '__other' } });
    const typed = screen.getByLabelText('Model');
    expect(typed.tagName).toBe('INPUT');
    fireEvent.change(typed, { target: { value: 'gpt-4.1' } });
    fireEvent.blur(typed);
    await waitFor(() => expect(api.setRoute).toHaveBeenLastCalledWith('llm', expect.objectContaining({ server: 'openai', model: 'gpt-4.1' })));
    expect(onChanged).toHaveBeenCalled();
  });

  it('reads the image model list again when the step moves to another ComfyUI', async () => {
    const view = baseView();
    view.servers.push({ id: 'rack', name: 'ComfyUI on rack-1', type: 'comfy', url: 'http://rack-1:8188', builtIn: false, managed: false, hasKey: false });
    const api = bridge(view);
    const avatarApi = {
      listAvatarImageModels: vi
        .fn()
        .mockResolvedValueOnce({ models: [{ id: 'local', name: 'Local model', available: true }], selectedModelId: 'local' })
        .mockResolvedValue({ models: [{ id: 'remote', name: 'Rack model', available: true }], selectedModelId: 'remote' }),
      setAvatarImageModel: vi.fn(),
    };
    render(<ModelsDialog api={api} avatarApi={avatarApi as never} onClose={vi.fn()} initialUse="image" />);
    expect(await screen.findByRole('option', { name: 'Local model' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'rack' } });
    expect(await screen.findByRole('option', { name: 'Rack model' })).toBeTruthy();
    expect(screen.getByText('From ComfyUI on rack-1')).toBeTruthy();
    expect(avatarApi.listAvatarImageModels).toHaveBeenCalledTimes(2);
  });

  it('adds a server from a job and picks it, then sets backups', async () => {
    const api = bridge();
    render(<ModelsDialog api={api} onClose={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('Runs on'), { target: { value: '__add' } });
    const form = await screen.findByRole('form', { name: 'New server' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'vLLM on rack-1' } });
    fireEvent.change(within(form).getByLabelText('Address'), { target: { value: 'http://rack-1:8000/v1' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Test' }));
    await waitFor(() =>
      expect(api.probe).toHaveBeenCalledWith({ draft: { type: 'chat', url: 'http://rack-1:8000/v1', key: undefined } }),
    );
    expect(await within(form).findByText(/It answered/)).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: 'Add server' }));
    await screen.findByText('Added vLLM on rack-1 and picked it.');
    expect(api.saveServer).toHaveBeenCalledWith({ name: 'vLLM on rack-1', type: 'chat', url: 'http://rack-1:8000/v1', key: undefined });
    expect(api.setRoute).toHaveBeenCalledWith('llm', expect.objectContaining({ server: 'server-new' }));
    expect((screen.getByLabelText('Runs on') as HTMLSelectElement).value).toBe('server-new');

    const backups = screen.getByRole('group', { name: 'Backup servers' });
    fireEvent.click(within(backups).getByRole('button', { name: 'Language model on this PC' }));
    await waitFor(() =>
      expect(api.setRoute).toHaveBeenLastCalledWith('llm', expect.objectContaining({ server: 'server-new', backups: [{ server: 'local-llm' }] })),
    );
    await waitFor(() => expect(within(backups).getByRole('button', { name: /Language model on this PC/ }).getAttribute('aria-pressed')).toBe('true'));
  });

  it('saves the OpenAI key on its server page without showing it', async () => {
    const api = bridge();
    render(<ModelsDialog api={api} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Servers\d/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open OpenAI' }));
    const key = await screen.findByLabelText('API key');
    expect((key as HTMLInputElement).type).toBe('password');
    fireEvent.change(key, { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    await screen.findByText('Key saved.');
    expect(api.setKey).toHaveBeenCalledWith('openai', 'sk-test');
    expect((key as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'Remove key' })).toBeTruthy();
    const before = api.probe.mock.calls.filter(([target]) => 'serverId' in target && target.serverId === 'openai').length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }));
    await waitFor(() =>
      expect(api.probe.mock.calls.filter(([target]) => 'serverId' in target && target.serverId === 'openai').length).toBeGreaterThan(before),
    );
  });

  it('lets web search be turned off', async () => {
    const api = bridge();
    render(<ModelsDialog api={api} onClose={vi.fn()} initialUse="search" />);
    fireEvent.change(await screen.findByLabelText('Runs on'), { target: { value: '' } });
    await waitFor(() => expect(api.setRoute).toHaveBeenCalledWith('search', expect.objectContaining({ server: '' })));
    expect(await screen.findByText(/Web search is off/)).toBeTruthy();
  });

  it('picks a memory mirror (never this PC’s own database), with a password instead of a model', async () => {
    const view = baseView();
    view.servers.push({
      id: 'supa',
      name: 'Supabase',
      type: 'memory',
      url: 'postgresql://postgres.abcd@db.example.com:5432/postgres',
      builtIn: false,
      managed: false,
      hasKey: true,
    });
    const api = bridge(view);
    render(<ModelsDialog api={api} onClose={vi.fn()} initialUse="memorymirror" />);
    const select = (await screen.findByLabelText('Runs on')) as HTMLSelectElement;
    const options = [...select.options].map((option) => option.value);
    expect(options).toContain('');
    expect(options).toContain('supa');
    expect(options).not.toContain('local-memory');
    expect(screen.getByText(/No mirror/)).toBeTruthy();
    fireEvent.change(select, { target: { value: 'supa' } });
    await waitFor(() => expect(api.setRoute).toHaveBeenCalledWith('memorymirror', expect.objectContaining({ server: 'supa' })));
    expect(screen.queryByLabelText('Model')).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByLabelText('Password')).toBeTruthy();
    expect(screen.queryByText(/Models it offers/)?.closest('[hidden]')).toBeTruthy();
  });
});
