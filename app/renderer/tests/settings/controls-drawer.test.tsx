import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ControlGroup, ControlsDrawer } from '../../src/settings/controls-drawer.js';

function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <ControlsDrawer open={open} onOpenChange={setOpen}>
      <ControlGroup id="character" title="Character" keywords="avatar model" defaultOpen>
        <input aria-label="Base prompt" defaultValue="Hello" />
      </ControlGroup>
      <ControlGroup id="devices" title="Devices & wake word" keywords="microphone threshold">
        <label>
          Detection threshold
          <input defaultValue="0.5" />
        </label>
      </ControlGroup>
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

  it('searches collapsed groups and preserves edits and expansion when cleared', () => {
    render(<Fixture />);
    fireEvent.click(screen.getByRole('button', { name: 'Controls' }));
    const prompt = screen.getByLabelText('Base prompt');
    fireEvent.change(prompt, { target: { value: 'A new personality' } });
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'threshold' } });
    expect(screen.queryByRole('button', { name: /Character/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Detection threshold')).toBeVisible();
    fireEvent.change(search, { target: { value: '' } });
    expect(screen.getByLabelText('Base prompt')).toBe(prompt);
    expect(prompt).toHaveValue('A new personality');
    expect(screen.getByRole('button', { name: /Devices/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Controls' }));
    expect(screen.getByLabelText('Base prompt')).toBe(prompt);
  });

  it('keeps collapsed children mounted and out of keyboard navigation', () => {
    const mounted = vi.fn();
    function Child() {
      mounted();
      return <button type="button">Choose microphone</button>;
    }
    render(
      <ControlsDrawer open onOpenChange={() => undefined}>
        <ControlGroup id="test" title="Devices">
          <Child />
        </ControlGroup>
      </ControlsDrawer>,
    );
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Choose microphone' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Devices/ }));
    expect(
      within(screen.getByRole('complementary')).getByRole('button', { name: 'Choose microphone' }),
    ).toBeVisible();
    expect(mounted).toHaveBeenCalledTimes(1);
  });
});
