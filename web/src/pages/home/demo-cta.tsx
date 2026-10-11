import { Link } from '@tanstack/react-router';
import { Button } from '@tio/ui/button';

export type DemoCtaProps = {
  /** When the service is down, the CTA is a disabled button and this is the reason shown. */
  disabledReason: string | null;
};

/** "Run the live demo": a link to /borrow, or a disabled button that says why. */
export function DemoCta({ disabledReason }: DemoCtaProps) {
  if (disabledReason === null) {
    return (
      <Button asChild size="lg">
        <Link to="/borrow">Run the live demo</Link>
      </Button>
    );
  }
  return (
    <>
      <Button size="lg" disabled>
        Run the live demo
      </Button>
      <p className="text-sm text-tone-negative">{disabledReason}</p>
    </>
  );
}
