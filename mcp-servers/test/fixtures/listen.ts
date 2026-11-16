import type { Server } from "node:http";

/** Preserve setup errors instead of hanging until a hook timeout. */
export async function listenLocal(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { cleanup(); reject(error); };
    const ready = () => { cleanup(); resolve(); };
    const cleanup = () => { server.off("error", failed); server.off("listening", ready); };
    server.once("error", failed);
    server.once("listening", ready);
    try { server.listen(0, "127.0.0.1"); } catch (error) { failed(error as Error); }
  });
}
