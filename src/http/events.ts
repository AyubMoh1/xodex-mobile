import type { Request, Response } from "express";
import type { CompanionState } from "../codex/state.js";

export class EventHub {
  private readonly clients = new Set<Response>();

  constructor(private readonly state: CompanionState) {
    this.state.on("change", (event) => this.broadcast("xodex", event));
  }

  handle = (req: Request, res: Response) => {
    req.socket.setTimeout(0);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    this.clients.add(res);
    this.send(res, "snapshot", this.state.snapshot());

    req.on("close", () => {
      this.clients.delete(res);
      res.end();
    });
  };

  broadcast(event: string, payload: unknown) {
    for (const client of this.clients) {
      this.send(client, event, payload);
    }
  }

  private send(res: Response, event: string, payload: unknown) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}
