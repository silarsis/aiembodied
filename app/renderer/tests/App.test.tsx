import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../src/App';

type PreloadWindow = Window & { aiembodied?: { ping?: () => string } };

describe('App component', () => {
  const originalConsoleError = console.error;

  beforeEach(() => {
    (window as PreloadWindow).aiembodied = undefined;
    console.error = vi.fn();
  });

  afterEach(() => {
    (window as PreloadWindow).aiembodied = undefined;
    console.error = originalConsoleError;
  });

  it('renders the MVP headline and bridge status when ping is available', () => {
    (window as PreloadWindow).aiembodied = { ping: () => 'pong' };

    render(<App />);

    expect(screen.getByRole('heading', { name: /Embodied Assistant MVP/i })).toBeInTheDocument();
    expect(screen.getByText(/Preload bridge status: pong/i)).toBeInTheDocument();
  });

  it('falls back to unavailable status when preload bridge is missing', () => {
    render(<App />);

    expect(screen.getByText(/Preload bridge status: unavailable/i)).toBeInTheDocument();
  });
});
