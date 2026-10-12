import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TONES, TONE_TINT } from '../../tokens/tokens.ts';
import { Badge } from './badge.tsx';

describe('Badge', () => {
  it('renders its children and merges className', () => {
    render(<Badge className="extra">Tier A</Badge>);
    expect(screen.getByText('Tier A')).toHaveClass('extra');
  });

  it('marks itself with data-slot="badge"', () => {
    render(<Badge>x</Badge>);
    expect(screen.getByText('x')).toHaveAttribute('data-slot', 'badge');
  });

  it('gives default and outline variants different class sets', () => {
    render(
      <>
        <Badge variant="default">a</Badge>
        <Badge variant="outline">b</Badge>
      </>,
    );
    expect(screen.getByText('a').className).not.toBe(screen.getByText('b').className);
  });

  it.each(TONES)('exposes tone %s as data-tone', (tone) => {
    render(<Badge tone={tone}>t</Badge>);
    expect(screen.getByText('t')).toHaveAttribute('data-tone', tone);
  });

  it('gives each tone a different class set', () => {
    const classSets = TONES.map((tone) => {
      const { unmount } = render(<Badge tone={tone}>t</Badge>);
      const cls = screen.getByText('t').className;
      unmount();
      return cls;
    });
    expect(new Set(classSets).size).toBe(TONES.length);
  });

  it.each(TONES)('fills a soft badge with a wash of tone %s, and no other badge', (tone) => {
    render(
      <>
        <Badge variant="soft" tone={tone}>
          soft
        </Badge>
        <Badge variant="outline" tone={tone}>
          outline
        </Badge>
      </>,
    );
    expect(screen.getByText('soft')).toHaveClass(TONE_TINT[tone]);
    expect(screen.getByText('outline')).not.toHaveClass(TONE_TINT[tone]);
  });

  it('sets a soft badge in sentence case, not mono caps', () => {
    render(<Badge variant="soft">fresh</Badge>);
    expect(screen.getByText('fresh')).toHaveClass('normal-case', 'font-sans');
    expect(screen.getByText('fresh')).not.toHaveClass('uppercase', 'font-mono');
  });
});
