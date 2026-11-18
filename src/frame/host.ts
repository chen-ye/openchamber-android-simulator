import { connectHost, type HostReadyContext } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import type { SimulatorState } from '../shared/types.ts';

export type GuestHostClient = ReturnType<typeof connectHost>;

export interface FrameController {
  readonly host: GuestHostClient;
  readonly getState: () => SimulatorState | null;
  readonly getReady: () => HostReadyContext | null;
  readonly act: (path: string, body?: unknown) => Promise<SimulatorState | null>;
  readonly refresh: () => Promise<void>;
}

export function startFrame(options: {
  onState: (state: SimulatorState, ctrl: FrameController) => void;
  onReady?: (ctx: HostReadyContext, ctrl: FrameController) => void;
  targetId?: () => string | null;
}): FrameController {
  const host = connectHost();
  let currentState: SimulatorState | null = null;
  let readyCtx: HostReadyContext | null = null;
  let busy = false;
  let pollTimer: number | null = null;
  let stopped = false;

  const ctrl: FrameController = {
    host,
    getState: () => currentState,
    getReady: () => readyCtx,
    act: async (path: string, body?: unknown) => {
      if (busy) return currentState;
      busy = true;
      try {
        const res = await host.serviceRequest({
          method: 'POST',
          path,
          body: JSON.stringify(body ?? {}),
        });
        if (res.status >= 400) {
          let msg = `Action failed (${res.status})`;
          try {
            const parsed = JSON.parse(res.body) as { error?: string };
            if (parsed.error) msg = parsed.error;
          } catch {
            // ignore
          }
          await host.toast({ kind: 'error', message: msg });
          return currentState;
        }
        const next = JSON.parse(res.body) as SimulatorState & { detail?: string };
        currentState = next;
        options.onState(next, ctrl);
        if (next.detail) {
          await host.toast({ kind: 'success', message: next.detail });
        }
        return next;
      } catch (err) {
        await host.toast({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
        return currentState;
      } finally {
        busy = false;
      }
    },
    refresh: async () => {
      await pollOnce(true);
    },
  };

  async function pollOnce(forceRefresh = false): Promise<void> {
    if (stopped) return;
    try {
      const target = options.targetId?.();
      const params = new URLSearchParams();
      if (forceRefresh) params.set('refresh', '1');
      if (target) params.set('id', target);
      const q = params.toString();
      const res = await host.serviceRequest({
        method: 'GET',
        path: q ? `/state?${q}` : '/state',
      });
      if (res.status === 200) {
        currentState = JSON.parse(res.body) as SimulatorState;
        options.onState(currentState, ctrl);
      }
    } catch {
      // ignore transient service wakeups
    }
  }

  function schedulePoll(): void {
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    if (stopped || document.visibilityState === 'hidden') return;
    const isBusy =
      currentState?.devices.some((d) => d.state === 'booting') ||
      currentState?.stream.running === false;
    pollTimer = window.setTimeout(async () => {
      await pollOnce(true);
      schedulePoll();
    }, isBusy ? 1500 : 3000);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void pollOnce(true).then(() => schedulePoll());
    } else if (pollTimer !== null) {
      window.clearTimeout(pollTimer);
      pollTimer = null;
    }
  });

  window.addEventListener('unload', () => {
    stopped = true;
    if (pollTimer !== null) window.clearTimeout(pollTimer);
  });

  host.onReady((ctx) => {
    readyCtx = ctx;
    applyHostReady(ctx, document.documentElement);
    options.onReady?.(ctx, ctrl);
    if (!currentState) {
      void pollOnce(true).then(() => schedulePoll());
    }
  });

  return ctrl;
}
