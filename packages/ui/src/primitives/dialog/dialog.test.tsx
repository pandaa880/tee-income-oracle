import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './dialog.tsx';

function Example({ className }: { className?: string }) {
  return (
    <Dialog>
      <DialogTrigger>Open it</DialogTrigger>
      <DialogContent {...(className === undefined ? {} : { className })}>
        <DialogHeader>
          <DialogTitle>Confirm</DialogTitle>
          <DialogDescription>Are you sure?</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose>Dismiss</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

describe('Dialog', () => {
  it('is closed until the trigger is clicked', () => {
    render(<Example />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens from the trigger with title and description', () => {
    render(<Example />);
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm' });
    expect(dialog).toHaveAccessibleDescription('Are you sure?');
  });

  it('closes from the Close button', () => {
    render(<Example />);
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('forwards className to the content', () => {
    render(<Example className="wide" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    expect(screen.getByRole('dialog')).toHaveClass('wide');
  });

  it('marks the content with data-slot="dialog-content"', () => {
    render(<Example />);
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    expect(screen.getByRole('dialog')).toHaveAttribute('data-slot', 'dialog-content');
  });

  it('forwards className on header, footer, title and description', () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogHeader className="h-x">
            <DialogTitle className="t-x">T</DialogTitle>
            <DialogDescription className="d-x">D</DialogDescription>
          </DialogHeader>
          <DialogFooter className="f-x">F</DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByText('T')).toHaveClass('t-x');
    expect(screen.getByText('D')).toHaveClass('d-x');
    expect(screen.getByText('F')).toHaveClass('f-x');
    expect(screen.getByText('T').closest('[data-slot="dialog-header"]')).toHaveClass('h-x');
  });
});
