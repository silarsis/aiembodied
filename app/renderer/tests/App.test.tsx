import { render, screen } from '@testing-library/react';
import App from '../src/App';

describe('App component', () => {
  it('renders the MVP headline', () => {
    render(<App />);
    expect(screen.getByText(/Embodied Assistant MVP/i)).toBeInTheDocument();
  });
});
