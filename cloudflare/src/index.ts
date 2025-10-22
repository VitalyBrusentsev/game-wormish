export interface Env {}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export default {
  async fetch(_request: Request, _env: Env, _ctx: WorkerExecutionContext): Promise<Response> {
    const currentTime = new Date().toISOString();

    return new Response(
      JSON.stringify({ currentTime }),
      {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      }
    );
  },
};
