import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs.tsx';

function Example() {
  return (
    <Tabs defaultValue="one" className="root-x">
      <TabsList className="list-x">
        <TabsTrigger value="one" className="trig-x">
          First
        </TabsTrigger>
        <TabsTrigger value="two">Second</TabsTrigger>
      </TabsList>
      <TabsContent value="one" className="panel-x">
        Panel one
      </TabsContent>
      <TabsContent value="two">Panel two</TabsContent>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('shows the default tab as selected with its panel', () => {
    render(<Example />);
    expect(screen.getByRole('tab', { name: 'First' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel one');
    expect(screen.queryByText('Panel two')).not.toBeInTheDocument();
  });

  it('switches content when another tab is activated', () => {
    render(<Example />);
    // Radix Tabs activate on mousedown, not click.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Second' }), { button: 0 });
    expect(screen.getByRole('tab', { name: 'Second' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel two');
    expect(screen.queryByText('Panel one')).not.toBeInTheDocument();
  });

  it('forwards className on every part', () => {
    render(<Example />);
    expect(screen.getByRole('tablist')).toHaveClass('list-x');
    expect(screen.getByRole('tab', { name: 'First' })).toHaveClass('trig-x');
    expect(screen.getByRole('tabpanel')).toHaveClass('panel-x');
    expect(screen.getByRole('tablist').parentElement).toHaveClass('root-x');
  });
});
