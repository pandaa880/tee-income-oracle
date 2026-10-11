// Links to the public explorer. The values come from chain reads or verified signatures only.
const EXPLORER = 'https://explorer.solana.com';

export function explorerAddressUrl(cluster: string, address: string): string {
  return `${EXPLORER}/address/${address}?cluster=${cluster}`;
}

export function explorerTxUrl(cluster: string, signature: string): string {
  return `${EXPLORER}/tx/${signature}?cluster=${cluster}`;
}
