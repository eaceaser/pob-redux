export interface ConfirmRequest {
  title: string;
  message: string;
  ok?: string;
  cancel?: string;
}

/**
 * An in-app yes/no dialog (ConfirmModal.svelte), in place of the native one.
 * One at a time: a new request answers the pending one with "no".
 */
class ConfirmStore {
  current = $state<(ConfirmRequest & { resolve: (v: boolean) => void }) | null>(null);

  ask(req: ConfirmRequest): Promise<boolean> {
    this.current?.resolve(false);
    return new Promise((resolve) => {
      this.current = { ...req, resolve };
    });
  }

  answer(v: boolean) {
    const c = this.current;
    this.current = null;
    c?.resolve(v);
  }
}

export const confirm = new ConfirmStore();
