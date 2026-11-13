import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlacesSnapshot } from '../../../main/src/places/place-manager.js';
import { ElsewhereChip } from '../../src/places/elsewhere-chip.js';
import { describeAbsent, estimateSpeechMs, stagePresence } from '../../src/places/stage-presence.js';

const places: PlacesSnapshot['places'] = [
  { id: 'home', name: 'the lounge', node: 'local' },
  { id: 'next-door', name: 'next door', node: 'offscreen' },
];
const snapshot = (locations: Record<string, string>, transit: PlacesSnapshot['transit'] = []): PlacesSnapshot => ({ places, locations, transit, localPlaceId: 'home' });
const IDS = ['echo', 'sage', 'rex'];

describe('stagePresence', () => {
  it('puts everybody on stage without a snapshot', () => {
    expect(stagePresence(null, IDS)).toEqual({ present: IDS, incoming: [], absent: [] });
  });

  it('puts everybody on stage when all are at the local place', () => {
    expect(stagePresence(snapshot({ echo: 'home', sage: 'home', rex: 'home' }), IDS).present).toEqual(IDS);
  });

  it('treats an avatar with no entry as being here', () => {
    expect(stagePresence(snapshot({}), IDS).present).toEqual(IDS);
  });

  it('keeps an avatar in another place off the stage, Echo included', () => {
    const result = stagePresence(snapshot({ echo: 'next-door', sage: 'home', rex: 'home' }), IDS);
    expect(result.present).toEqual(['sage', 'rex']);
    expect(result.absent).toEqual([{ id: 'echo', state: 'away', placeId: 'next-door' }]);
    expect(result.incoming).toEqual([]);
  });

  it('keeps avatars on the move off the stage, and lists the ones walking in', () => {
    const result = stagePresence(
      snapshot({ echo: 'home', sage: 'next-door', rex: 'home' }, [
        { avatarId: 'sage', from: 'next-door', to: 'home' },
        { avatarId: 'rex', from: 'home', to: 'next-door' },
      ]),
      IDS,
    );
    expect(result.present).toEqual(['echo']);
    expect(result.incoming).toEqual(['sage']);
    expect(result.absent).toEqual([
      { id: 'sage', state: 'arriving', placeId: 'home' },
      { id: 'rex', state: 'leaving', placeId: 'next-door' },
    ]);
  });
});

describe('describeAbsent', () => {
  it('names the place or the one it is heading to', () => {
    const snap = snapshot({});
    expect(describeAbsent({ id: 'echo', state: 'away', placeId: 'next-door' }, 'Echo', snap)).toBe('Echo is next door');
    expect(describeAbsent({ id: 'sage', state: 'arriving', placeId: 'home' }, 'Sage', snap)).toBe('Sage is on the way to the lounge');
    expect(describeAbsent({ id: 'sage', state: 'leaving', placeId: 'next-door' }, 'Sage', snap)).toBe('Sage is on the way to next door');
  });
});

describe('estimateSpeechMs', () => {
  it('grows with the words and ignores tags', () => {
    expect(estimateSpeechMs('{room:next door}')).toBe(0);
    expect(estimateSpeechMs('Give us a minute. {room:next door}')).toBeGreaterThan(500);
    expect(estimateSpeechMs('x'.repeat(5000))).toBe(8000);
  });
});

describe('ElsewhereChip', () => {
  const snap = snapshot({});

  it('renders nothing when nobody is away', () => {
    const { container } = render(<ElsewhereChip absent={[]} snapshot={snap} nameOf={(id) => id} onCall={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists who is elsewhere and calls an avatar back', () => {
    const onCall = vi.fn();
    render(
      <ElsewhereChip
        absent={[
          { id: 'echo', state: 'away', placeId: 'next-door' },
          { id: 'sage', state: 'arriving', placeId: 'home' },
        ]}
        snapshot={snap}
        nameOf={(id) => (id === 'echo' ? 'Echo' : 'Sage')}
        onCall={onCall}
      />,
    );
    expect(screen.getByText('Echo is next door')).toBeInTheDocument();
    expect(screen.getByText('Sage is on the way to the lounge')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Call Echo' }));
    expect(onCall).toHaveBeenCalledWith('echo');
    // Already on the way: nothing to call.
    expect(screen.getByRole('button', { name: 'Call Sage' })).toBeDisabled();
  });
});
