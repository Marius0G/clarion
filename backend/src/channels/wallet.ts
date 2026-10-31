import { Wallet as SharedWallet, type WalletEnv, type WalletStore } from '../wallet.js';
import { engineRuntime } from '../runtime.js';

export class Wallet extends SharedWallet {
  constructor(env: WalletEnv = {}, file?: string) {
    super(env, {
      saved: file && engineRuntime.exists(file) ? engineRuntime.read(file) as WalletStore : undefined,
      persist: file ? store => engineRuntime.write(file, store) : undefined,
    });
  }
}
