"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import "./global-toast.css";

export interface GlobalToastProps {
  message: string;
  tone?: "success" | "error" | "info";
  onDismiss: () => void;
}

const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;
const surfaceSelector = 'dialog, .exp-modal[aria-modal="true"]';

function containsSurface(node: Node) {
  return node instanceof Element && (node.matches(surfaceSelector) || !!node.querySelector(surfaceSelector));
}
function hideToast(element: HTMLElement) {
  try { if (typeof element.hidePopover === "function" && element.matches(":popover-open")) element.hidePopover(); } catch { /* Its former dialog may already have been removed. */ }
}
function showToast(element: HTMLElement) {
  if (!element.isConnected) return;
  if (typeof element.showPopover === "function") {
    try {
      element.setAttribute("popover", "manual");
      hideToast(element);
      element.showPopover();
      element.removeAttribute("data-popover-fallback");
      return;
    } catch { /* Keep the notification visible in the current modal if the API is unavailable. */ }
  }
  element.removeAttribute("popover");
  element.setAttribute("data-popover-fallback", "");
}

/** Lives inside the active modal for interaction, then enters the top layer for visibility. */
export function GlobalToast({ message, tone = "success", onDismiss }: GlobalToastProps) {
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const host = useMemo(() => {
    if (!ready) return null;
    const container = document.createElement("div");
    container.className = "global-toast-host";
    container.setAttribute("data-global-toast-host", "");
    return container;
  }, [ready]);
  const toastRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const toast = toastRef.current;
    if (!host || !message || !toast) return;
    let order = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]"));
    function currentScope(): HTMLElement {
      const dialogs = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]"));
      let modals = dialogs;
      try { const nativeModals = dialogs.filter(dialog => dialog.matches(":modal")); if (nativeModals.length) modals = nativeModals; } catch { /* Older browsers can still use an open dialog as the host. */ }
      order = order.filter(dialog => modals.includes(dialog));
      for (const dialog of modals) if (!order.includes(dialog)) order.push(dialog);
      const focusedDialog = document.activeElement?.closest<HTMLDialogElement>("dialog[open]");
      if (focusedDialog && modals.includes(focusedDialog)) return focusedDialog;
      if (order.length) return order[order.length - 1];
      const customModals = Array.from(document.querySelectorAll<HTMLElement>('.exp-modal[aria-modal="true"]'));
      const focusedCustom = document.activeElement?.closest<HTMLElement>('.exp-modal[aria-modal="true"]');
      return focusedCustom || customModals[customModals.length - 1] || document.body;
    }
    function rememberFocus() {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && !host?.contains(active)) previousFocus.current = active;
    }
    function refresh() {
      const scope = currentScope();
      if (host?.parentElement !== scope) {
        hideToast(toast!);
        scope.appendChild(host!);
      }
      rememberFocus();
      showToast(toast!);
    }
    const observer = new MutationObserver(records => {
      let relevant = !host.isConnected || !host.parentElement?.isConnected;
      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof HTMLDialogElement) {
          order = order.filter(dialog => dialog !== record.target);
          if (record.target.open) order.push(record.target);
          relevant = true;
        } else if (record.type === "childList") {
          const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
          if (nodes.some(node => node === host || node.contains(host) || containsSurface(node))) relevant = true;
        }
      }
      if (relevant) refresh();
    });
    rememberFocus(); refresh();
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    document.addEventListener("focusin", rememberFocus, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", rememberFocus, true);
      hideToast(toast);
      host.remove();
    };
  }, [host, message, tone]);

  function dismiss() {
    const hadFocus = !!toastRef.current?.contains(document.activeElement);
    const scope = host?.parentElement;
    const previous = previousFocus.current;
    onDismiss();
    if (!hadFocus || !scope?.isConnected) return;
    const permitted = (element: HTMLElement) => element.isConnected && !element.matches(":disabled") && !element.closest('[inert], [aria-hidden="true"]') && !element.closest("[data-global-toast-host]") && (scope === document.body || scope.contains(element)) && element.getClientRects().length > 0;
    const target = previous && permitted(previous) ? previous : Array.from(scope.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')).find(permitted);
    target?.focus({ preventScroll: true });
  }

  if (!host || !message) return null;
  const Icon = tone === "error" ? AlertCircle : tone === "info" ? Info : CheckCircle2;
  return createPortal(<div ref={toastRef} className={`global-toast global-toast-${tone}`} data-global-toast="" popover="manual" role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"} aria-atomic="true">
    <span className="global-toast-icon"><Icon size={19} aria-hidden="true"/></span>
    <span className="global-toast-message">{message}</span>
    <button type="button" className="global-toast-dismiss" aria-label="关闭提示" onClick={dismiss}><X size={16} aria-hidden="true"/></button>
  </div>, host);
}
