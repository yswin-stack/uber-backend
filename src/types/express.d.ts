import "express";

declare module "express-serve-static-core" {
  interface Request {
    user?: {
      userId: number;
      role: "subscriber" | "driver" | "admin";
    };
  }
}
