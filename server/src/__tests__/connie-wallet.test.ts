import { describe, it, expect, beforeEach } from "vitest";
import { getAddressFromKey, validateWalletEnv } from "../wallet/connie-wallet.js";

// Anvil default test key #0 — public, safe to use in tests
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("connie-wallet", () => {
  beforeEach(() => {
    delete process.env.CONNIE_WALLET_PRIVATE_KEY;
    delete process.env.CONNIE_WALLET_ADDRESS;
  });

  it("derives correct address from private key", () => {
    expect(getAddressFromKey(TEST_KEY).toLowerCase()).toBe(TEST_ADDR.toLowerCase());
  });

  it("validateWalletEnv returns error when key missing", () => {
    const result = validateWalletEnv();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not set/);
  });

  it("validateWalletEnv returns ok when key and address match", () => {
    process.env.CONNIE_WALLET_PRIVATE_KEY = TEST_KEY;
    process.env.CONNIE_WALLET_ADDRESS = TEST_ADDR;
    const result = validateWalletEnv();
    expect(result.ok).toBe(true);
    expect(result.address?.toLowerCase()).toBe(TEST_ADDR.toLowerCase());
  });

  it("validateWalletEnv returns error when address mismatches", () => {
    process.env.CONNIE_WALLET_PRIVATE_KEY = TEST_KEY;
    process.env.CONNIE_WALLET_ADDRESS = "0x0000000000000000000000000000000000000001";
    const result = validateWalletEnv();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/mismatch/);
  });
});
