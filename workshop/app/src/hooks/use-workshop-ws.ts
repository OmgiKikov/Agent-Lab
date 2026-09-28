import { useEffect, useState, useRef } from "react";

type Listener<T = unknown> = (data: T) => void;
type ReplayableMessage = object & { type?: unknown };

interface WorkshopEnvelope {
  event?: string;
  data?: unknown;
}

interface Broker {
  ws: WebSocket | null;
  connected: boolean;
  listeners: Map<string, Set<Listener>>;
  messageListeners: Set<Listener>;
  subscribe<T>(event: string, fn: Listener<T>): () => void;
  subscribeMessage<T>(fn: Listener<T>): () => void;
  connectionListeners: Set<(connected: boolean) => void>;
  send(msg: object): void;
  // Messages registered here are automatically re-sent on every (re)connection,
  // keyed by `type`. Latest-wins so a rapid series of ui_view updates only
  // replays the final state.
  replayOnConnect: Map<string, object>;
}

let singleton: Broker | null = null;

function isWorkshopEnvelope(value: unknown): value is WorkshopEnvelope {
  return !!value && typeof value === "object";
}

function getBroker(): Broker {
  if (singleton) return singleton;

  const listeners = new Map<string, Set<Listener>>();
  const messageListeners = new Set<Listener>();
  const connectionListeners = new Set<(c: boolean) => void>();
  const replayOnConnect = new Map<string, object>();
  const broker: Broker = {
    ws: null,
    connected: false,
    listeners,
    messageListeners,
    connectionListeners,
    replayOnConnect,
    subscribe<T>(event: string, fn: Listener<T>) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      const listener: Listener = (data) => fn(data as T);
      listeners.get(event)!.add(listener);
      return () => {
        listeners.get(event)?.delete(listener);
      };
    },
    subscribeMessage<T>(fn: Listener<T>) {
      const listener: Listener = (data) => fn(data as T);
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    },
    send(msg) {
      const type = (msg as ReplayableMessage).type;
      if (typeof type === "string") replayOnConnect.set(type, msg);
      const ws = broker.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(msg)); } catch {}
      }
    },
  };

  function setConnected(c: boolean) {
    broker.connected = c;
    for (const l of connectionListeners) l(c);
  }

  function connect() {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
    const ws = new WebSocket(url);
    broker.ws = ws;
    ws.onopen = () => {
      setConnected(true);
      for (const msg of replayOnConnect.values()) {
        try { ws.send(JSON.stringify(msg)); } catch {}
      }
    };
    ws.onclose = () => {
      setConnected(false);
      broker.ws = null;
      setTimeout(connect, 2000);
    };
    ws.onerror = () => setConnected(false);
    ws.onmessage = (e) => {
      try {
        const msg: unknown = JSON.parse(e.data);
        for (const h of messageListeners) h(msg);
        if (!isWorkshopEnvelope(msg) || typeof msg.event !== "string") return;
        const handlers = listeners.get(msg.event);
        if (handlers) for (const h of handlers) h(msg.data);
      } catch {}
    };
  }

  connect();
  singleton = broker;
  return broker;
}

/** Subscribe to every backend WS message. Use sparingly for top-level refreshes. */
export function useWorkshopMessage<T = unknown>(handler: Listener<T>) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const broker = getBroker();
    return broker.subscribeMessage<T>((data) => handlerRef.current(data));
  }, []);
}

/** Subscribe to a named WS event from the backend. Returns nothing; unsubscribes on unmount. */
export function useWorkshopEvent<T = unknown>(event: string, handler: Listener<T>) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const broker = getBroker();
    return broker.subscribe<T>(event, (data) => handlerRef.current(data));
  }, [event]);
}

/** Whether the UI's WS connection to the backend is up. */
export function useWorkshopConnected(): boolean {
  const [connected, setConnected] = useState(() => getBroker().connected);

  useEffect(() => {
    const broker = getBroker();
    broker.connectionListeners.add(setConnected);
    setConnected(broker.connected);
    return () => {
      broker.connectionListeners.delete(setConnected);
    };
  }, []);

  return connected;
}

/** Send a message to the backend over the shared WS. Auto-replays on reconnect (latest-wins by `type`). */
export function sendWorkshopMessage(msg: object): void {
  getBroker().send(msg);
}
