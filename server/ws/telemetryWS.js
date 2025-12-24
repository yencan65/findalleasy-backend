import { WebSocketServer } from "ws";
import os from "os";

let wss = null;

export function createTelemetryWSS(server) {
  wss = new WebSocketServer({ server, path: "/ws/telemetry" });

  console.log("Telemetry WS aktif");

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "status", msg: "connected" }));

    // Her 2 saniyede sistem telemetrisi gönder
    const timer = setInterval(() => {
      try {
        ws.send(
          JSON.stringify({
            type: "metrics",
            cpu: process.cpuUsage(),
            memory: process.memoryUsage(),
            load: os.loadavg(),
            uptime: process.uptime(),
            time: new Date()
          })
        );
      } catch {}
    }, 2000);

    ws.on("close", () => clearInterval(timer));
  });
}

export function pushTelemetry(event) {
  if (!wss) return;
  const data = JSON.stringify(event);

  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(data);
    }
  });
}
