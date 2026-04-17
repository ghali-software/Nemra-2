import { WebSocketServer } from "ws";

export function createDashboardServer() {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  wss.on("connection", (ws) => {
    clients.add(ws);
    console.log(`[dashboard] client connected (${clients.size} total)`);
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
