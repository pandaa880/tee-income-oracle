import { useNavigate } from '@tanstack/react-router';
import { Button } from '@tio/ui/button';
import { Input, Label } from '@tio/ui/input';
import { type FormEvent, useState } from 'react';

export type WalletFormProps = {
  /** What `?wallet=` holds, shown back in the box. */
  initial: string;
  /** The search param is text but not an address: say so under the box. */
  invalid: boolean;
  /** Check pressed with the wallet already in the URL: the page runs the check again. */
  onRepeat: () => void;
};

const ERROR_ID = 'verify-wallet-error';

/** The wallet box and its Check button; submitting puts the text in the URL, nothing more. */
export function WalletForm({ initial, invalid, onRepeat }: WalletFormProps) {
  const navigate = useNavigate();
  const [text, setText] = useState(initial);

  /** A blank box asks for nothing: the URL loses its wallet instead of carrying an empty one. */
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const wallet = text.trim();
    // A same-URL navigation changes nothing, so an unchanged wallet asks for a fresh read instead.
    if (wallet !== '' && wallet === initial.trim()) {
      onRepeat();
      return;
    }
    void navigate({ to: '/verify', search: wallet === '' ? {} : { wallet } });
  };

  return (
    <section
      aria-label="Check a wallet"
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-6"
    >
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-[1_1_26rem] flex-col gap-1.5">
          <Label htmlFor="verify-wallet">Borrower wallet</Label>
          <Input
            id="verify-wallet"
            className="font-mono text-sm"
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? ERROR_ID : undefined}
          />
        </div>
        <Button type="submit">Check</Button>
      </form>
      {invalid && (
        <p id={ERROR_ID} role="alert" className="text-sm text-tone-negative">
          Not a Solana address
        </p>
      )}
    </section>
  );
}
