import { privateKeyToAccount } from "viem/accounts";

export function getAddressFromKey(privateKey: string): string {
  return privateKeyToAccount(privateKey as `0x${string}`).address;
}

export function validateWalletEnv(): { ok: boolean; address: string | null; error?: string } {
  const key = process.env.CONNIE_WALLET_PRIVATE_KEY;
  const expectedAddress = process.env.CONNIE_WALLET_ADDRESS;
  if (!key) return { ok: false, address: null, error: "CONNIE_WALLET_PRIVATE_KEY not set" };
  let derived: string;
  try {
    derived = getAddressFromKey(key);
  } catch (e) {
    return { ok: false, address: null, error: `Invalid private key format: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (expectedAddress && derived.toLowerCase() !== expectedAddress.toLowerCase())
    return { ok: false, address: derived, error: `Address mismatch: got ${derived}, expected ${expectedAddress}` };
  return { ok: true, address: derived };
}

export async function signMessageWithEnvKey(message: string): Promise<string> {
  const key = process.env.CONNIE_WALLET_PRIVATE_KEY;
  if (!key) throw new Error("CONNIE_WALLET_PRIVATE_KEY not set");
  const account = privateKeyToAccount(key as `0x${string}`);
  return account.signMessage({ message });
}
