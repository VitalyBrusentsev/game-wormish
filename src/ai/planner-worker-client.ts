import type {
  AiPlannerRequest,
  AiPlannerResponse,
  AiPlannerSnapshot,
  AiPlannerTurnPlan,
} from "./planner-worker-types";
import type { GameAiSettings } from "./types";

type PendingRequest = {
  resolve: (plan: AiPlannerTurnPlan | null) => void;
  reject: (error: Error) => void;
};

class AiPlannerWorkerClient {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();

  isAvailable() {
    return typeof Worker !== "undefined";
  }

  async planTurn(
    snapshot: AiPlannerSnapshot,
    settings?: GameAiSettings
  ): Promise<AiPlannerTurnPlan | null> {
    const worker = this.ensureWorker();
    if (!worker) return null;

    const requestId = this.nextRequestId++;
    return new Promise<AiPlannerTurnPlan | null>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      const request: AiPlannerRequest = {
        kind: "plan-turn",
        requestId,
        snapshot,
      };
      if (settings) request.settings = settings;
      worker.postMessage(request, [snapshot.terrain.solid.buffer]);
    });
  }

  private ensureWorker(): Worker | null {
    if (!this.isAvailable()) return null;
    if (this.worker) return this.worker;

    const worker = new Worker(new URL("./planner.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.addEventListener("message", (event: MessageEvent<AiPlannerResponse>) => {
      this.handleResponse(event.data);
    });
    worker.addEventListener("error", (event) => {
      this.failAllPending(new Error(event.message || "AI planner worker crashed"));
      this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  private handleResponse(response: AiPlannerResponse) {
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    if (response.kind === "plan-turn-error") {
      pending.reject(new Error(response.message));
      return;
    }
    pending.resolve(response.plan);
  }

  private failAllPending(error: Error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export const aiPlannerWorkerClient = new AiPlannerWorkerClient();
