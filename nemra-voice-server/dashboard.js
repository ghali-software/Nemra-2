import { WebSocketServer } from "ws";
import { getStats, getHistory } from "./call-history.js";

export function createDashboardServer() {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  wss.on("connection", (ws) => {
    clients.add(ws);
    console.log(`[dashboard] client connected (${clients.size} total)`);

    // Send current stats and history on connect
    try {
      ws.send(JSON.stringify({ type: "stats_update", stats: getStats() }));
      ws.send(JSON.stringify({ type: "history_update", history: getHistory(20) }));
    } catch {}

    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  return {
    wss,
    broadcast(event) {
      const data = JSON.stringify(event);
      for (const c of clients) {
        try { c.send(data); } catch {}
      }
    },
  };
}
