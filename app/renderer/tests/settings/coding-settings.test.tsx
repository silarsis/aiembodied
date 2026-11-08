import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelRoutingView, ModelServerView } from '../../../main/src/config/config-manager.js';
import type { CodingBridge, CodingConfig, CodingStatus, CodingView } from '../../../main/src/coding/bridge-types.js';
import { builtInServers, defaultRoutes } from '../../../main/src/config/model-routing.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../../../main/src/config/provider-settings.js';
import type { ServerProbe } from '../../../main/src/config/model-server-probe.js';
import type { ModelsBridge } from '../../src/preload-api.js';
import { CodingStatusLine } from '../../src/status/coding-status.js';
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

const status = (overrides: Partial<CodingStatus> = {}): CodingStatus => ({
  runnerUp: true,
  runnerUrl: 'http://127.0.0.1:8195',
  localModelNeeded: false,
  swap: { phase: 'idle', message: 'Not needed now.' },
  detectedGguf: 'D:\\models\\Qwen3-Coder-Next-Q4_K_M-00001-of-00003.gguf',
  workspaceError: null,
  ...overrides,
});

function modelsBridge() {
  const servers: ModelServerView[] = builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }).map((server) => ({ ...server, hasKey: false }));
  const view: ModelRoutingView = { servers, routes: defaultRoutes(DEFAULT_PROVIDER_SETTINGS) };
  return {
    get: vi.fn(async () => view),
    probe: vi.fn(async (): Promise<ServerProbe> => ({ status: 'up', models: { chat: ['qwen3-coder-next'] }, checkedAt: 1 })),
    saveServer: vi.fn(),
    removeServer: vi.fn(),
    setRoute: vi.fn(async () => view),
    setKey: vi.fn(),
  } as unknown as ModelsBridge;
}

function codingBridge(initial: CodingConfig) {
  let coding = initial;
  const view = (): CodingView => ({ coding, runnerId: 'local-coder-runner', status: status() });
  const api = {
    get: vi.fn(async () => view()),
    set: vi.fn(async (next: CodingConfig) => {
      coding = next;
      return view();
    }),
    status: vi.fn(async () => status()),
    pickGguf: vi.fn(async () => 'E:\\picked.gguf'),
    pickFolder: vi.fn(async () => 'C:\\src\\notes'),
    suggestChecks: vi.fn(async () => 'npm test'),
  };
  return api as typeof api & CodingBridge;
}

const seeded: CodingConfig = {
  runner: 'local-coder-runner',
  workspaces: [{ id: 'aiembodied', name: 'aiembodied', path: 'C:\\src\\aiembodied', kind: 'self', baseBranch: 'main', checks: 'pnpm -w typecheck && pnpm test' }],
};

async function openCoding(api: CodingBridge) {
  render(<ModelsDialog api={modelsBridge()} codingApi={api} onClose={vi.fn()} />);
  const rail = await screen.findByRole('navigation', { name: 'Model uses' });
  fireEvent.click(await within(rail).findByText('Coding', { selector: '.modelsDialog__item > span' }));
  await screen.findByText('Workspaces');
}

describe('Coding page', () => {
  it('shows the coding model, the runner state, the detected model file and the workspaces', async () => {
    const api = codingBridge(seeded);
    await openCoding(api);
    expect(await screen.findByLabelText('Runs on')).toHaveProperty('value', 'local-coder-llm');
    expect(screen.getByLabelText('Runner running')).toBeTruthy();
    expect(screen.getByText(/Detected: D:\\models\\Qwen3-Coder-Next/)).toBeTruthy();
    expect(screen.getByText('aiembodied', { selector: 'b' })).toBeTruthy();
    expect(screen.getByText("Echo’s own code")).toBeTruthy();
    expect(screen.getByText('Models: Not needed now.')).toBeTruthy();
  });

  it('picks the coder model file with a file dialog and saves it', async () => {
    const api = codingBridge(seeded);
    await openCoding(api);
    const row = screen.getByLabelText('Qwen3-Coder-Next GGUF').closest('.modelsDialog__model') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Browse…' }));
    await waitFor(() => expect(api.set).toHaveBeenCalledWith({ ...seeded, coderGguf: 'E:\\picked.gguf' }));
    expect(await screen.findByDisplayValue('E:\\picked.gguf')).toBeTruthy();
  });

  it('adds a workspace: folder dialog, suggested checks, protected paths', async () => {
    const api = codingBridge(seeded);
    await openCoding(api);
    fireEvent.click(screen.getByRole('button', { name: 'Add a workspace' }));
    const form = screen.getByRole('form', { name: 'New workspace' });
    fireEvent.click(within(form).getByRole('button', { name: 'Browse…' }));
    await waitFor(() => expect((within(form).getByLabelText('Folder') as HTMLInputElement).value).toBe('C:\\src\\notes'));
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('notes');
    fireEvent.change(within(form).getByLabelText('Protected paths'), { target: { value: 'db/\n\nsecrets/' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Suggest' }));
    await waitFor(() => expect((within(form).getByLabelText('Checks') as HTMLInputElement).value).toBe('npm test'));
    // Suggest saved the row first, because the runner can only look at workspaces it knows.
    expect(api.set).toHaveBeenCalledTimes(1);
    expect(api.suggestChecks).toHaveBeenCalledWith('notes');
    fireEvent.click(within(form).getByRole('button', { name: 'Save workspace' }));
    await waitFor(() => expect(api.set).toHaveBeenCalledTimes(2));
    const saved = api.set.mock.calls[1][0] as CodingConfig;
    expect(saved.workspaces).toHaveLength(2);
    expect(saved.workspaces[1]).toEqual({
      id: 'notes',
      name: 'notes',
      path: 'C:\\src\\notes',
      kind: 'project',
      baseBranch: 'main',
      checks: 'npm test',
      protectedPaths: ['db/', 'secrets/'],
    });
  });

  it('shows the default protected paths of Echo’s own code as read-only text, and removes a workspace', async () => {
    const api = codingBridge(seeded);
    await openCoding(api);
    fireEvent.click(screen.getByRole('button', { name: 'Edit aiembodied' }));
    const form = screen.getByRole('form', { name: 'Edit workspace' });
    expect(within(form).getByText(/services\/coder\//)).toBeTruthy();
    expect(within(form).getByLabelText('Extra protected paths')).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: 'Remove workspace' }));
    await waitFor(() => expect(api.set).toHaveBeenCalledWith({ ...seeded, workspaces: [] }));
    expect(await screen.findByText(/No workspaces yet/)).toBeTruthy();
  });

  it('shows why the runner refused the workspaces', async () => {
    const api = codingBridge(seeded);
    api.get.mockResolvedValue({ coding: seeded, runnerId: 'local-coder-runner', status: status({ workspaceError: '"C:\\x" is not a git repository' }) });
    await openCoding(api);
    expect(await screen.findByText(/The runner refused the workspaces/)).toBeTruthy();
  });
});

describe('Coding status line', () => {
  it('shows the runner and the swap state', async () => {
    const api = {
      status: vi.fn(async () => status({ runnerUp: false, swap: { phase: 'coder-loaded', message: 'The coder model is loaded.' } })),
    } as unknown as CodingBridge;
    render(<CodingStatusLine api={api} active />);
    await waitFor(() => expect(screen.getByTestId('coding-status').textContent).toBe('Coding: Runner down. The coder model is loaded.'));
  });

  it('asks nothing while the panel is closed', () => {
    const api = { status: vi.fn() } as unknown as CodingBridge;
    render(<CodingStatusLine api={api} active={false} />);
    expect(api.status).not.toHaveBeenCalled();
  });
});
