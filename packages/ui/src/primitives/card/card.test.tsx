import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './card.tsx';

describe('Card', () => {
  it('renders every part with its content', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Desc</CardDescription>
        </CardHeader>
        <CardContent>Body</CardContent>
        <CardFooter>Foot</CardFooter>
      </Card>,
    );
    for (const text of ['Title', 'Desc', 'Body', 'Foot']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it('marks each part with a data-slot', () => {
    const { container } = render(
      <Card>
        <CardHeader>
          <CardTitle>T</CardTitle>
          <CardDescription>D</CardDescription>
        </CardHeader>
        <CardContent>B</CardContent>
        <CardFooter>F</CardFooter>
      </Card>,
    );
    for (const slot of [
      'card',
      'card-header',
      'card-title',
      'card-description',
      'card-content',
      'card-footer',
    ]) {
      expect(container.querySelector(`[data-slot="${slot}"]`)).not.toBeNull();
    }
  });

  it('forwards className on every part', () => {
    render(
      <Card className="c-card">
        <CardHeader className="c-header">
          <CardTitle className="c-title">T</CardTitle>
          <CardDescription className="c-desc">D</CardDescription>
        </CardHeader>
        <CardContent className="c-content">B</CardContent>
        <CardFooter className="c-footer">F</CardFooter>
      </Card>,
    );
    expect(screen.getByText('T')).toHaveClass('c-title');
    expect(screen.getByText('D')).toHaveClass('c-desc');
    expect(screen.getByText('B')).toHaveClass('c-content');
    expect(screen.getByText('F')).toHaveClass('c-footer');
    expect(screen.getByText('T').closest('[data-slot="card-header"]')).toHaveClass('c-header');
    expect(screen.getByText('T').closest('[data-slot="card"]')).toHaveClass('c-card');
  });

  it('styles a double-rule header differently from the default header', () => {
    const { container } = render(
      <>
        <CardHeader>a</CardHeader>
        <CardHeader rule="double">b</CardHeader>
      </>,
    );
    const [plain, double] = Array.from(container.querySelectorAll('[data-slot="card-header"]'));
    expect(plain?.className).not.toBe(double?.className);
  });
});
