import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { GITHUB_URL, HomePage } from './home-page.tsx';

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset['theme'];
});

describe('HomePage', () => {
  it('renders the headline', () => {
    render(<HomePage />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/prove it blind/i);
  });

  it('puts the site header outside main, with a theme toggle', () => {
    render(<HomePage />);
    const banner = screen.getByRole('banner');
    expect(screen.getByRole('main')).not.toContainElement(banner);
    expect(screen.getByRole('button', { name: /theme/i })).toBeInTheDocument();
  });

  it('links the proof bar to the repository', () => {
    render(<HomePage />);
    expect(screen.getByRole('link', { name: /github/i })).toHaveAttribute('href', GITHUB_URL);
  });

  it('labels the sample seal as an example, not a verified result', () => {
    render(<HomePage />);
    expect(screen.getByText('Example')).toBeInTheDocument();
    expect(screen.queryByText(/verified/i)).not.toBeInTheDocument();
  });
});
