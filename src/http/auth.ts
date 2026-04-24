import type { NextFunction, Request, Response } from "express";

export function requireAccessToken(accessToken: string | null) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!accessToken || req.path === "/health") {
      next();
      return;
    }

    const header = req.header("authorization");
    const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    const custom = req.header("x-xodex-token");
    const query = typeof req.query.token === "string" ? req.query.token : null;

    if ([bearer, custom, query].includes(accessToken)) {
      next();
      return;
    }

    res.status(401).json({ error: "access token required" });
  };
}
