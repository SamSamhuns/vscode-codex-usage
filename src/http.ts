import * as http from "http";
import * as https from "https";

export interface HttpResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

// Read-only GET shared by the live usage sources. No retries here: each caller
// owns its own fallback and backoff policy.
export function httpGetJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(Buffer.from(c)));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: res.headers,
        }),
      );
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.end();
  });
}
