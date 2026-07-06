import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { LoopEvent } from '@coderouter/core';
import { subscribeLoopEvents, type PlanOpenEvent, type PreviewOpenEvent } from './api';

type Listener = (e: LoopEvent) => void;
type PlanListener = (e: PlanOpenEvent) => void;
type PreviewListener = (e: PreviewOpenEvent) => void;

type EventsCtx = {
  connected: boolean;
  subscribe: (fn: Listener) => () => void;
  subscribePlan: (fn: PlanListener) => () => void;
  subscribePreview: (fn: PreviewListener) => () => void;
};

const Ctx = createContext<EventsCtx>({
  connected: false,
  subscribe: () => () => {},
  subscribePlan: () => () => {},
  subscribePreview: () => () => {},
});

/** Single SSE connection shared by the whole app; fans events out to subscribers. */
export function LoopEventsProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const listeners = useRef(new Set<Listener>());
  const planListeners = useRef(new Set<PlanListener>());
  const previewListeners = useRef(new Set<PreviewListener>());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let close: (() => void) | null = null;
    let cancelled = false;
    void subscribeLoopEvents((e) => {
      if ('type' in e && e.type === 'hello') {
        setConnected(true);
        return;
      }
      if ('type' in e && e.type === 'plan-open') {
        for (const l of planListeners.current) l(e as PlanOpenEvent);
        return;
      }
      if ('type' in e && e.type === 'preview-open') {
        for (const l of previewListeners.current) l(e as PreviewOpenEvent);
        return;
      }
      for (const l of listeners.current) l(e as LoopEvent);
    }).then((c) => {
      if (cancelled) c();
      else {
        close = c;
        setConnected(true);
      }
    });
    return () => {
      cancelled = true;
      close?.();
    };
  }, []);

  const value: EventsCtx = {
    connected,
    subscribe: (fn) => {
      listeners.current.add(fn);
      return () => listeners.current.delete(fn);
    },
    subscribePlan: (fn) => {
      planListeners.current.add(fn);
      return () => planListeners.current.delete(fn);
    },
    subscribePreview: (fn) => {
      previewListeners.current.add(fn);
      return () => previewListeners.current.delete(fn);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLoopEvents(fn: Listener, deps: React.DependencyList = []): void {
  const { subscribe } = useContext(Ctx);
  useEffect(() => subscribe(fn), deps); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Subscribe to CLI -> app plan-open handoffs. */
export function usePlanOpen(fn: PlanListener, deps: React.DependencyList = []): void {
  const { subscribePlan } = useContext(Ctx);
  useEffect(() => subscribePlan(fn), deps); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Subscribe to CLI -> app preview-open handoffs (open URL in the built-in browser). */
export function usePreviewOpen(fn: PreviewListener, deps: React.DependencyList = []): void {
  const { subscribePreview } = useContext(Ctx);
  useEffect(() => subscribePreview(fn), deps); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useDaemonConnected(): boolean {
  return useContext(Ctx).connected;
}
