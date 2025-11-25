import "express";

declare module "express-serve-static-core" {
  interface Request {
    user?: {
      id: number;
      userId: number;
      role: "subscriber" | "driver" | "admin";
      phone?: string | null;
    };
  }
}
