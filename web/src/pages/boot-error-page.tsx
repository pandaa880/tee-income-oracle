export type BootErrorPageProps = { message: string };

/** Shown instead of a blank page when the config is wrong or the browser lacks Ed25519. */
export function BootErrorPage({ message }: BootErrorPageProps) {
  return (
    <main className="mx-auto flex max-w-(--content-max) flex-col gap-4 px-4 py-12">
      <h1 className="font-display text-2xl leading-tight">The app could not start</h1>
      <p className="text-muted-foreground">{message}</p>
      <p className="text-sm text-muted-foreground">
        The app needs a current browser: WebCrypto Ed25519 and AbortSignal.any (Chrome or Edge 137+,
        Firefox 129+, Safari 17.4+).
      </p>
    </main>
  );
}
