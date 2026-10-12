import { useWallet } from '../../app/use-wallet.ts';
import { shortAddress } from '../../domain/format.ts';

/** The tab's demo wallet, labelled as such: devnet only, created here, gone with the tab. */
export function WalletChip() {
  const { address } = useWallet();
  return (
    <div className="flex flex-col items-end text-right">
      <span className="font-mono text-xs tracking-(--tracking-caps) uppercase">
        DEMO WALLET · {shortAddress(address)}
      </span>
      <span className="text-xs text-muted-foreground">Devnet only · made in this tab</span>
    </div>
  );
}
