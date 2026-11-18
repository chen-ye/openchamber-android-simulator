import { GUEST_UI_LOOK_CSS } from '@openchamber/sdk/ui';
import { startFrame } from '../host.ts';
import { createToolbar, type ToolbarHandle } from '../toolbar.ts';

const style = document.createElement('style');
style.textContent = GUEST_UI_LOOK_CSS;
document.head.append(style);

const root = document.querySelector<HTMLElement>('#root')!;
let toolbar: ToolbarHandle | null = null;
let lastMeasured = 0;

function syncDockHeight(ctrl: ReturnType<typeof startFrame>): void {
  window.requestAnimationFrame(() => {
    const h = Math.max(44, Math.ceil(root.getBoundingClientRect().height));
    if (h !== lastMeasured) {
      lastMeasured = h;
      void ctrl.host.setHeight(h);
    }
  });
}

const ctrl = startFrame({
  onReady: () => {
    if (!toolbar) {
      toolbar = createToolbar(root, ctrl, {
        showFrameToggle: false,
        onExtrasToggle: () => syncDockHeight(ctrl),
      });
      new ResizeObserver(() => syncDockHeight(ctrl)).observe(root);
    }
    syncDockHeight(ctrl);
  },
  onState: (state) => {
    toolbar?.update(state);
    syncDockHeight(ctrl);
  },
});
