import { fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ControlButton, ControlsDrawer } from '../../src/settings/controls-drawer.js';
import { PanelDialog } from '../../src/settings/panel-dialog.js';

function Fixture({ onOpenCharacter = () => undefined }: { onOpenCharacter?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <ControlsDrawer open={open} onOpenChange={setOpen}>
      <ControlButton id="character" title="Characters" keywords="avatar model" onOpen={onOpenCharacter} />
      <ControlButton id="devices" title="Devices and wake words" keywords="microphone threshold" onOpen={() => undefined} />
    </ControlsDrawer>
  );
}

describe('stage controls drawer', () => {
  it('opens by shortcut, focuses search, and restores the handle on Escape', () => {
    render(<Fixture />);
    const handle = screen.getByRole('button', { name: 'Controls' });
    handle.focus();
    fireEvent.keyDown(window, { key: '/', ctrlKey: true });
    expect(screen.getByRole('searchbox')).toHaveFocus();
    expect(screen.getByRole('complementary', { name: 'Controls' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.getElementById('controls-drawer')).toHaveAttribute('inert');
    expect(handle).toHaveFocus();
    fireEvent.keyDown(window, { key: '/', metaKey: true });
    expect(screen.getByRole('searchbox')).toHaveFocus();
  });

  it('filters the buttons by search and opens a pop-up on click', () => {
    const onOpenCharacter = vi.fn();
    render(<Fixture onOpenCharacter={onOpenCharacter} />);
    fireEvent.click(screen.getByRole('button', { name: 'Controls' }));
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'threshold' } });
    expect(screen.queryByRole('button', { name: /Characters/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Devices/ })).toBeVisible();
    fireEvent.change(search, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Characters/ }));
    expect(onOpenCharacter).toHaveBeenCalledTimes(1);
  });
});

describe('settings pop-up', () => {
  it('keeps its contents mounted while closed, and closes from its button', () => {
    const mounted = vi.fn();
    function Child() {
      useEffect(() => mounted(), []);
      return <input aria-label="Base prompt" defaultValue="Hello" />;
    }
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open character
          </button>
          <PanelDialog id="character" title="Characters" open={open} onClose={() => setOpen(false)}>
            <Child />
          </PanelDialog>
        </>
      );
    }
    render(<Host />);
    const prompt = screen.getByLabelText('Base prompt');
    fireEvent.change(prompt, { target: { value: 'A new personality' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open character' }));
    const dialog = document.getElementById('panel-character');
    expect(dialog).toHaveAttribute('open');
    fireEvent.click(screen.getByRole('button', { name: 'Close characters' }));
    expect(dialog).not.toHaveAttribute('open');
    expect(screen.getByLabelText('Base prompt')).toBe(prompt);
    expect(prompt).toHaveValue('A new personality');
    expect(mounted).toHaveBeenCalledTimes(1);
  });
});
