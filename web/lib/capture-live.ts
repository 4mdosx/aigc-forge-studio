// 采集页和 runner 的握手。只有这个页面开着才报 ready。
// 不走 Next 的 HTTP 代理：升级不了 WebSocket，直接连本机 runner。

export type CaptureJob = {
  id: string;
  url: string;
  mediaUrl?: string;
};

export type CaptureReport = {
  id: string;
  state: "queued" | "active" | "done" | "duplicate" | "failed";
  message?: string;
};

export type CaptureLink = {
  connected: boolean;
  extensions: number;
};

const LIVE = "ws://127.0.0.1:8787/capture/live";

export function connectCaptureLive(handlers: {
  onCapture: (job: CaptureJob) => void;
  onLink: (link: CaptureLink) => void;
}): {
  close: () => void;
  report: (status: CaptureReport) => void;
} {
  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer = 0;

  function send(body: unknown) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(body));
  }

  function open() {
    if (closed) return;
    const ws = new WebSocket(LIVE);
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      ws.send(JSON.stringify({ type: "hello", role: "web" }));
      ws.send(JSON.stringify({ type: "ready", ready: true }));
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message !== "object") return;
      const body = message as Record<string, unknown>;
      if (body.type === "state") {
        handlers.onLink({
          connected: true,
          extensions: typeof body.extensions === "number" ? body.extensions : 0,
        });
        return;
      }
      if (body.type !== "capture") return;
      if (typeof body.id !== "string" || typeof body.url !== "string") return;
      handlers.onCapture({
        id: body.id,
        url: body.url,
        ...(typeof body.mediaUrl === "string" ? { mediaUrl: body.mediaUrl } : {}),
      });
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      handlers.onLink({ connected: false, extensions: 0 });
      if (closed) return;
      const delay = Math.min(5000, 300 * 2 ** attempt);
      attempt += 1;
      timer = window.setTimeout(open, delay);
    };
  }

  open();

  return {
    report(status) {
      const body: {
        type: "status";
        id: string;
        state: CaptureReport["state"];
        message?: string;
      } = { type: "status", id: status.id, state: status.state };
      if (status.message) body.message = status.message;
      send(body);
    },
    close() {
      closed = true;
      window.clearTimeout(timer);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ready", ready: false }));
      }
      socket?.close();
      socket = null;
    },
  };
}
