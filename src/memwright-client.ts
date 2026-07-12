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
  memory?: {
    category?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

interface SearchResult {
  id: string;
  content: string;
  [key: string]: unknown;
}

interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
}

class MemwrightClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async add(req: AddRequest): Promise<{ id: string } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(`${this.baseUrl}/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
        signal: controller.signal,
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

      return result.data ? { id: result.data.id } : null;
    } catch (err) {
      console.warn(`[memwright] add error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async recall(
    query: string,
    opts: { namespace: string; budget?: number }
  ): Promise<RecallResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const body: Record<string, unknown> = {
        query,
        namespace: opts.namespace,
        ...(opts.budget !== undefined && { budget: opts.budget }),
      };

      const response = await fetch(`${this.baseUrl}/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
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
    } finally {
      clearTimeout(timer);
    }
  }

  async search(opts: {
    namespace: string;
    category?: string;
    entity?: string;
    limit?: number;
  }): Promise<SearchResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const body: Record<string, unknown> = {
        namespace: opts.namespace,
        ...(opts.category !== undefined && { category: opts.category }),
        ...(opts.entity !== undefined && { entity: opts.entity }),
        ...(opts.limit !== undefined && { limit: opts.limit }),
      };

      const response = await fetch(`${this.baseUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        console.warn(
          `[memwright] search failed with status ${response.status}`
        );
        return [];
      }

      const result: ApiResponse<SearchResult[]> = await response.json();
      if (!result.ok || !Array.isArray(result.data)) {
        console.warn(`[memwright] search returned invalid data`);
        return [];
      }

      return (result.data as SearchResult[]) ?? [];
    } catch (err) {
      console.warn(
        `[memwright] search error: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async batchAdd(
    requests: AddRequest[],
    concurrency: number = 10
  ): Promise<void> {
    for (let i = 0; i < requests.length; i += concurrency) {
      const chunk = requests.slice(i, i + concurrency);
      await Promise.all(chunk.map((req) => this.add(req)));
    }
  }

  async forget(memoryId: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(`${this.baseUrl}/forget`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memory_id: memoryId }),
        signal: controller.signal,
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

      return result.data?.forgotten ?? false;
    } catch (err) {
      console.warn(
        `[memwright] forget error: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal,
      });

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
    } finally {
      clearTimeout(timer);
    }
  }
}

export const memwright = new MemwrightClient(
  process.env.MEMWRIGHT_URL ?? "http://localhost:8765"
);

export { MemwrightClient, AddRequest, RecallResult, SearchResult };
