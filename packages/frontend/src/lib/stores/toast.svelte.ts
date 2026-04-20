export type ToastType = 'success' | 'error' | 'info';
export type Toast = {
  id: number;
  message: string;
  type: ToastType;
  // Optional click handler — when set, the toast becomes clickable and
  // the whole surface invokes this on click (and auto-dismisses).
  onClick?: () => void;
};

let toasts = $state<Toast[]>([]);
let nextId = 0;

export function getToasts() {
  return toasts;
}

export function showToast(
  message: string,
  type: ToastType = 'info',
  duration = 4000,
  onClick?: () => void,
) {
  const id = nextId++;
  toasts = [...toasts, { id, message, type, onClick }];
  setTimeout(() => {
    toasts = toasts.filter(t => t.id !== id);
  }, duration);
}

export function dismissToast(id: number) {
  toasts = toasts.filter(t => t.id !== id);
}

export function invokeToast(id: number) {
  const toast = toasts.find(t => t.id === id);
  if (toast?.onClick) toast.onClick();
  dismissToast(id);
}
