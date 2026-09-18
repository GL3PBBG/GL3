import { ServerFrameSchema, type ServerFrame } from "@gl3/shared";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";

interface FrameQueue { queue: ServerFrame[]; waiting: ((frame: ServerFrame) => void) | null }
const frameQueues = new WeakMap<WebSocket, FrameQueue>();

/** See ws.test.ts for why the listener is attached synchronously inside open(). */
export const openSocket = (url: string, options?: WebSocket.ClientOptions): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    const state: FrameQueue = { queue: [], waiting: null };
    frameQueues.set(socket, state);
    socket.on("message", (raw) => {
      // Every frame the server sends must parse — a schema drift shows up
      // here as a thrown error in whichever test received it.
      const frame = ServerFrameSchema.parse(JSON.parse(raw.toString()));
      if (state.waiting) { const deliver = state.waiting; state.waiting = null; deliver(frame); }
      else state.queue.push(frame);
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });

export const nextFrame = (socket: WebSocket, timeoutMs = 4000): Promise<ServerFrame> => {
  const state = frameQueues.get(socket);
  if (!state) throw new Error("socket was not opened via openSocket()");
  if (state.queue.length > 0) return Promise.resolve(state.queue.shift()!);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`nextFrame: no frame within ${timeoutMs}ms`)), timeoutMs);
    state.waiting = (frame) => { clearTimeout(timer); resolve(frame); };
  });
};

/** Drains frames until one of `kind` arrives; frames of other kinds are discarded. */
export async function frameOfKind<K extends ServerFrame["kind"]>(
  socket: WebSocket, kind: K, timeoutMs = 4000,
): Promise<Extract<ServerFrame, { kind: K }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frame = await nextFrame(socket, Math.max(1, deadline - Date.now()));
    if (frame.kind === kind) return frame as Extract<ServerFrame, { kind: K }>;
  }
}

/** Resolves true if a frame of `kind` arrives within `withinMs`, false otherwise. Other kinds are discarded. */
export async function receivedFrameOfKind(socket: WebSocket, kind: ServerFrame["kind"], withinMs: number): Promise<boolean> {
  try { await frameOfKind(socket, kind, withinMs); return true; } catch { return false; }
}

export async function mintTicket(app: FastifyInstance, token: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/ws/ticket", headers: { authorization: `Bearer ${token}` } });
  if (res.statusCode !== 201) throw new Error(`mintTicket: ${res.statusCode} ${res.body}`);
  return (res.json() as { ticket: string }).ticket;
}

export const sendFrame = (socket: WebSocket, frame: unknown): void => { socket.send(JSON.stringify(frame)); };
