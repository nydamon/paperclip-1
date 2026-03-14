/**
 * Phase-2 Signer Service
 *
 * Design intent: Replace direct CONNIE_WALLET_PRIVATE_KEY env injection with a
 * process-scoped signer that loads the key from Paperclip's encrypted secret
 * store at startup. Agents request signatures without ever receiving the raw key.
 *
 * Migration path:
 *   1. Build SignerService backed by secretService.resolveSecretValue(companyId, "connie-wallet-private-key").
 *   2. Expose HTTP/IPC endpoint for agents to request signMessage / signTypedData.
 *   3. Remove CONNIE_WALLET_PRIVATE_KEY secret_ref from Treasury Operator adapterConfig.env.
 *   4. Revoke raw-key injection for all agents.
 *   5. Retain one board-level emergency recovery path (not normal agent use).
 *
 * Prerequisite: secretService.resolveSecretValue must work without an active
 * agent context (process-level call, not heartbeat-level). Verify this before
 * full implementation.
 */

export interface SignerService {
  /** Returns the wallet address (public, safe to log). */
  getAddress(): Promise<string>;

  /** Signs an arbitrary string message (EIP-191 personal_sign). */
  signMessage(message: string): Promise<string>;

  /**
   * Signs EIP-712 typed data (used by x402 TransferWithAuthorization).
   * Types follow the viem TypedData conventions.
   */
  signTypedData(
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: `0x${string}`;
    },
    types: Record<string, Array<{ name: string; type: string }>>,
    primaryType: string,
    value: Record<string, unknown>,
  ): Promise<string>;
}

/**
 * Phase-1 compatibility shim.
 *
 * Creates a SignerService backed by an env-injected private key.
 * Used by the Treasury Operator agent in phase 1. Drop in phase 2
 * when the process-level signer is ready.
 */
export function createEnvSignerService(): SignerService {
  // Defer import to keep the module loadable without viem in scope
  // when running in contexts that don't need signing.
  return {
    async getAddress() {
      const { getAddressFromKey } = await import("./connie-wallet.js");
      const key = process.env.CONNIE_WALLET_PRIVATE_KEY;
      if (!key) throw new Error("CONNIE_WALLET_PRIVATE_KEY not set");
      return getAddressFromKey(key);
    },

    async signMessage(message: string) {
      const { signMessageWithEnvKey } = await import("./connie-wallet.js");
      return signMessageWithEnvKey(message);
    },

    async signTypedData(domain, types, primaryType, value) {
      const { privateKeyToAccount } = await import("viem/accounts");
      const key = process.env.CONNIE_WALLET_PRIVATE_KEY;
      if (!key) throw new Error("CONNIE_WALLET_PRIVATE_KEY not set");
      const account = privateKeyToAccount(key as `0x${string}`);
      return account.signTypedData({ domain, types, primaryType, message: value } as Parameters<typeof account.signTypedData>[0]);
    },
  };
}
