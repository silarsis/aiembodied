import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizeCodingConfig, seedCodingConfig, slugifyWorkspaceId, toRunnerWorkspace } from '../src/coding/config.js';
import { SELF_PROTECTED_PATHS } from '../src/coding/types.js';

describe('coding config', () => {
  it('keeps well-formed workspaces and drops the rest', () => {
    const coding = sanitizeCodingConfig({
      runner: ' rack ',
      coderGguf: ' D:\\m\\coder.gguf ',
      workspaces: [
        { id: 'notes', name: 'Notes', path: 'C:\\src\\notes', kind: 'project', baseBranch: 'develop', checks: ' npm test ', protectedPaths: ['db/', '', ' keys/ '] },
        { id: 'notes', path: 'C:\\dup' },
        { id: 'Bad Id', path: 'C:\\x' },
        { id: 'nopath' },
        { id: 'app', path: 'C:\\app', kind: 'weird' },
        'junk',
      ],
    });
    expect(coding).toEqual({
      runner: 'rack',
      coderGguf: 'D:\\m\\coder.gguf',
      workspaces: [
        { id: 'notes', name: 'Notes', path: 'C:\\src\\notes', kind: 'project', baseBranch: 'develop', checks: 'npm test', protectedPaths: ['db/', 'keys/'] },
        { id: 'app', name: 'app', path: 'C:\\app', kind: 'project', baseBranch: 'main' },
      ],
    });
    expect(sanitizeCodingConfig(undefined)).toBeUndefined();
    expect(sanitizeCodingConfig([])).toBeUndefined();
    expect(sanitizeCodingConfig({})).toEqual({ runner: 'local-coder-runner', workspaces: [] });
  });

  it('seeds the app repository when it is a git checkout', () => {
    const exists = (file: string) => file === path.join(path.resolve('/src/aiembodied'), '.git');
    expect(seedCodingConfig('/src/aiembodied', exists)).toEqual({
      runner: 'local-coder-runner',
      workspaces: [
        { id: 'aiembodied', name: 'aiembodied', path: path.resolve('/src/aiembodied'), kind: 'self', baseBranch: 'main', checks: 'pnpm -w typecheck && pnpm test' },
      ],
    });
    expect(seedCodingConfig('/elsewhere', exists)).toBeNull();
  });

  it('sends the runner its workspaces, adding the default protected paths for Echo’s own code', () => {
    const self = toRunnerWorkspace({ id: 'a', name: 'A', path: '/a', kind: 'self', baseBranch: 'main', checks: 'pnpm test', protectedPaths: ['extra/', 'services/coder/'] });
    expect(self).toEqual({
      id: 'a',
      name: 'A',
      path: '/a',
      kind: 'self',
      base_branch: 'main',
      checks: 'pnpm test',
      protected_paths: [...SELF_PROTECTED_PATHS, 'extra/'],
    });
    const project = toRunnerWorkspace({ id: 'b', name: 'B', path: '/b', kind: 'project', baseBranch: 'dev' });
    expect(project).toEqual({ id: 'b', name: 'B', path: '/b', kind: 'project', base_branch: 'dev', protected_paths: [] });
  });

  it('makes workspace ids from names', () => {
    expect(slugifyWorkspaceId('My Notes App!')).toBe('my-notes-app');
    expect(slugifyWorkspaceId('???')).toBe('workspace');
  });
});
