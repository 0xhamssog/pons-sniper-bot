import {
  createWalletClient,
  http,
  parseEther,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { unwrapError } from "./tx.js";
import type { StoredWallet } from "./wallets.js";

const GAS_BUFFER = parseEther("0.0004");

export async function fundWallets(input: {
  publicClient: PublicClient;
  rpcUrl: string;
  chain: Chain;
  master: Account;
  wallets: StoredWallet[];
  each: bigint;
}): Promise<Array<{ address: Address; hash?: Hex; error?: string }>> {
  if (input.each <= 0n) throw new Error("Fund amount must be > 0");
  const startNonce = await input.publicClient.getTransactionCount({
    address: input.master.address,
    blockTag: "pending",
  });
  const masterClient = createWalletClient({
    account: input.master,
    chain: input.chain,
    transport: http(input.rpcUrl),
  });

  const sent = await Promise.all(
    input.wallets.map(async (wallet, i) => {
      try {
        const hash = await masterClient.sendTransaction({
          account: input.master,
          chain: input.chain,
          to: wallet.address,
          value: input.each,
          nonce: startNonce + i,
        });
        return { address: wallet.address, hash };
      } catch (error) {
        return { address: wallet.address, error: unwrapError(error) };
      }
    }),
  );

  return Promise.all(
    sent.map(async (item) => {
      if (!item.hash) return item;
      const receipt = await input.publicClient.waitForTransactionReceipt({ hash: item.hash });
      if (receipt.status !== "success") return { ...item, error: "reverted" };
      return item;
    }),
  );
}

export async function sweepWallets(input: {
  publicClient: PublicClient;
  rpcUrl: string;
  chain: Chain;
  destination: Address;
  wallets: StoredWallet[];
}): Promise<Array<{ address: Address; hash?: Hex; amount?: bigint; error?: string }>> {
  // The node checks value + gas * maxFeePerGas against the balance, so the fee reserved
  // here must be the same maxFeePerGas the transaction is sent with, not eth_gasPrice.
  const { maxFeePerGas, maxPriorityFeePerGas } = await input.publicClient.estimateFeesPerGas();

  return Promise.all(
    input.wallets.map(async (wallet) => {
      const account = privateKeyToAccount(wallet.privateKey);
      const [balance, gas] = await Promise.all([
        input.publicClient.getBalance({ address: account.address }),
        input.publicClient.estimateGas({ account: account.address, to: input.destination, value: 0n }),
      ]);
      const gasCost = gas * maxFeePerGas;
      if (balance <= gasCost + GAS_BUFFER) {
        return { address: wallet.address, amount: 0n, error: "balance too low to sweep" };
      }
      const value = balance - gasCost;
      try {
        const client = createWalletClient({
          account,
          chain: input.chain,
          transport: http(input.rpcUrl),
        });
        const hash = await client.sendTransaction({
          account,
          chain: input.chain,
          to: input.destination,
          value,
          gas,
          maxFeePerGas,
          maxPriorityFeePerGas,
        });
        const receipt = await input.publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") return { address: wallet.address, hash, error: "reverted" };
        return { address: wallet.address, hash, amount: value };
      } catch (error) {
        return { address: wallet.address, error: unwrapError(error) };
      }
    }),
  );
}

export async function walletBalances(
  client: PublicClient,
  wallets: StoredWallet[],
): Promise<Array<{ address: Address; eth: bigint }>> {
  return Promise.all(
    wallets.map(async (wallet) => ({
      address: wallet.address,
      eth: await client.getBalance({ address: wallet.address }),
    })),
  );
}
