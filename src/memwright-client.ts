interface AddRequest {
  content: string;
  namespace: string;
  tags?: string[];
  category?: string;
  entity?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

interface RecallResult {
  content: string;
  score: number;
  source: string;
  id: string;
}

interface ApiResponse<T> {
  ok: boolean;
  data: T;
}

class MemwrightClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async add(req: AddRequest): Promise<{ id: string } | null> {
    try {
      const response = await fetch(`${this.baseUrl}/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });

      if (!response.ok) {
        console.warn(
          `[memwright] add failed with status ${response.status}`
        );
        return null;
      }

      const result: ApiResponse<{ id: string }> = await response.json();
      if (!result.ok) {
        console.warn(`[memwright] add returned ok=false`);
        return null;
      }

      return { id: result.data.id };
    } catch (err) {
      console.warn(`[memwright] add error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async recall(
    query: string,
    opts: { namespace: string; budget?: number }
  ): Promise<RecallResult[]> {
    try {
      const body: Record<string, unknown> = {
        query,
        namespace: opts.namespace,
      };

      if (opts.budget !== undefined) {
        body.budget = opts.budget;
      }

      const response = await fetch(`${this.baseUrl}/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        console.warn(
          `[memwright] recall failed with status ${response.status}`
        );
        return [];
      }

      const result: ApiResponse<RecallResult[]> = await response.json();
      if (!result.ok || !Array.isArray(result.data)) {
        console.warn(`[memwright] recall returned invalid data`);
        return [];
      }

      return result.data;
    } catch (err) {
      console.warn(
        `[memwright] recall error: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  async search(opts: {
    namespace: string;
    category?: string;
    entity?: string;
    limit?: number;
  }): Promise<any[]> {
    try {
      const body: Record<string, unknown> = {
        namespace: opts.namespace,
      };

      if (opts.category !== undefined) {
        body.category = opts.category;
      }

      if (opts.entity !== undefined) {
        body.entity = opts.entity;
      }

      if (opts.limit !== undefined) {
        body.limit = opts.limit;
      }

      const response = await fetch(`${this.baseUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        console.warn(
          `[memwright] search failed with status ${response.status}`
        );
        return [];
      }

      const result: ApiResponse<any[]> = await response.json();
      if (!result.ok || !Array.isArray(result.data)) {
        console.warn(`[memwright] search returned invalid data`);
        return [];
      }

      return result.data;
    } catch (err) {
      console.warn(
        `[memwright] search error: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  async batchAdd(
    requests: AddRequest[],
    concurrency: number = 10
  ): Promise<void> {
    try {
      for (let i = 0; i < requests.length; i += concurrency) {
        const chunk = requests.slice(i, i + concurrency);
        await Promise.all(chunk.map((req) => this.add(req)));
      }
    } catch (err) {
      console.warn(
        `[memwright] batchAdd error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async forget(memoryId: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/forget`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memory_id: memoryId }),
      });

      if (!response.ok) {
        console.warn(
          `[memwright] forget failed with status ${response.status}`
        );
        return false;
      }

      const result: ApiResponse<{ forgotten: boolean }> =
        await response.json();
      if (!result.ok) {
        console.warn(`[memwright] forget returned ok=false`);
        return false;
      }

      return result.data.forgotten;
    } catch (err) {
      console.warn(
        `[memwright] forget error: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);

      if (!response.ok) {
        return false;
      }

      const result: ApiResponse<unknown> = await response.json();
      return result.ok === true;
    } catch (err) {
      console.warn(
        `[memwright] health check error: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }
}

export const memwright = new MemwrightClient(
  process.env.MEMWRIGHT_URL ?? "http://localhost:8765"
);

export { MemwrightClient, AddRequest, RecallResult };
