import type { ApiError as ApiErrorBody } from "@cybercheck/contracts";

/** An API error with a message and a fix written for the user. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as Partial<ApiErrorBody>;
    if (body.code && body.message) return new ApiError(res.status, body.code, body.message, body.fix);
  } catch {
    // not JSON
  }
  if (res.status === 401) return new ApiError(401, "unauthenticated", "Your session has ended.", "Sign in again.");
  return new ApiError(
    res.status,
    "unexpected",
    "Something went wrong on our side.",
    "Try again in a moment. If it keeps happening, check that the API is running.",
  );
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      cache: "no-store",
    });
  } catch (error) {
    if ((error as Error).name === "TimeoutError") throw new ApiError(0, "timeout", "The server took too long to answer.", "Try again. If a check is already running, open it from the recent runs list.");
    throw new ApiError(0, "network", "We couldn't reach the server.", "Check your connection and try again.");
  }
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

/** Upload with progress (fetch can't report upload progress). */
export function uploadWithProgress<T>(
  url: string,
  form: FormData,
  headers: Record<string, string>,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = async () => {
      const res = new Response(xhr.responseText, { status: xhr.status, headers: { "content-type": "application/json" } });
      if (xhr.status >= 200 && xhr.status < 300) resolve((await res.json()) as T);
      else reject(await toApiError(res));
    };
    xhr.onerror = () =>
      reject(new ApiError(0, "network", "The upload was interrupted.", "Check your connection and try again."));
    xhr.onabort = () => reject(new ApiError(0, "aborted", "Upload cancelled.", "Choose the file again to retry."));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(form);
  });
}
