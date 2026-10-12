import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './accordion.tsx';

function Example() {
  return (
    <Accordion type="single" collapsible className="acc-x">
      <AccordionItem value="a">
        <AccordionTrigger>Why</AccordionTrigger>
        <AccordionContent>Because</AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

describe('Accordion', () => {
  it('starts collapsed', () => {
    render(<Example />);
    expect(screen.getByRole('button', { name: 'Why' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Because')).not.toBeInTheDocument();
  });

  it('expands and collapses on trigger click', () => {
    render(<Example />);
    const trigger = screen.getByRole('button', { name: 'Why' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Because')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('forwards className to the root', () => {
    const { container } = render(<Example />);
    expect(container.querySelector('[data-slot="accordion"]')).toHaveClass('acc-x');
  });

  it('forwards className on item, trigger and content', () => {
    const { container } = render(
      <Accordion type="single" defaultValue="a">
        <AccordionItem value="a" className="i-x">
          <AccordionTrigger className="t-x">Q</AccordionTrigger>
          <AccordionContent className="c-x">A</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );
    expect(container.querySelector('[data-slot="accordion-item"]')).toHaveClass('i-x');
    expect(screen.getByRole('button', { name: 'Q' })).toHaveClass('t-x');
    expect(screen.getByText('A')).toHaveClass('c-x');
  });

  it('slots a custom trigger element with asChild, marker inside it', () => {
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="a">
          <AccordionTrigger asChild>
            <button type="button" className="own-x">
              Question
            </button>
          </AccordionTrigger>
          <AccordionContent>Answer</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );
    const trigger = screen.getByRole('button', { name: 'Question' });
    expect(trigger).toHaveClass('own-x');
    expect(trigger).toHaveTextContent('+');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });
});
