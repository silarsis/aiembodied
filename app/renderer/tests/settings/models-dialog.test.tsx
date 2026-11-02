import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelRoutingView, ModelServerView } from '../../../main/src/config/config-manager.js';
import { builtInServers, defaultRoutes } from '../../../main/src/config/model-routing.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../../../main/src/config/provider-settings.js';
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
    probe: vi.fn(async () => ({ status: 'up' as const, models: { chat: ['qwen-next-flash', 'gemma'] }, checkedAt: 1 })),
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
  it('shows where each job runs and lists the models the server reports', async () => {
    const api = bridge();
    render(<ModelsDialog api={api} onClose={vi.fn()} />);
    const runsOn = (await screen.findByLabelText('Runs on')) as HTMLSelectElement;
    expect(runsOn.value).toBe('local-llm');
    await waitFor(() => expect(api.probe).toHaveBeenCalledWith({ serverId: 'local-llm' }));
    const options = document.querySelectorAll('#models-llm-found option');
    await waitFor(() => expect([...options].map((option) => option.getAttribute('value'))).toEqual(['qwen-next-flash', 'gemma']));
    expect(screen.getByRole('button', { name: /Concept image/ })).toBeTruthy();
  });

  it('moves a job to another server and saves a model name', async () => {
    const api = bridge();
    const onChanged = vi.fn();
    render(<ModelsDialog api={api} onClose={vi.fn()} onChanged={onChanged} />);
    fireEvent.change(await screen.findByLabelText('Runs on'), { target: { value: 'openai' } });
    await waitFor(() => expect(api.setRoute).toHaveBeenCalledWith('llm', expect.objectContaining({ server: 'openai', model: undefined })));
    const model = screen.getByLabelText('Model');
    fireEvent.change(model, { target: { value: 'gpt-4.1' } });
    fireEvent.blur(model);
    await waitFor(() => expect(api.setRoute).toHaveBeenLastCalledWith('llm', expect.objectContaining({ server: 'openai', model: 'gpt-4.1' })));
    expect(onChanged).toHaveBeenCalled();
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
  });

  it('lets web search be turned off', async () => {
    const api = bridge();
    render(<ModelsDialog api={api} onClose={vi.fn()} initialUse="search" />);
    fireEvent.change(await screen.findByLabelText('Runs on'), { target: { value: '' } });
    await waitFor(() => expect(api.setRoute).toHaveBeenCalledWith('search', expect.objectContaining({ server: '' })));
    expect(await screen.findByText(/Web search is off/)).toBeTruthy();
  });
});
