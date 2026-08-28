import assert from "node:assert/strict";

/**
 * Minimal fetch mock for unit tests. Records all calls and returns canned
 * responses matched by a predicate. Restore with the returned function.
 */
export interface FetchCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | Buffer | undefined;
}

export interface MockResponse {
	status: number;
	body: string | object | Buffer;
	headers?: Record<string, string>;
}

export type Matcher = (call: FetchCall) => MockResponse | undefined;

export function mockFetch(matcher: Matcher): { restore: () => void; calls: FetchCall[] } {
	const original = globalThis.fetch;
	const calls: FetchCall[] = [];
	const handler = async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = (init?.method ?? "GET").toUpperCase();
		const headers: Record<string, string> = {};
		const rawHeaders = init?.headers;
		if (rawHeaders) {
			const set = (k: string, v: string) => {
				headers[k.toLowerCase()] = String(v);
			};
			if (rawHeaders instanceof Headers) {
				rawHeaders.forEach((v, k) => set(k, v));
			} else if (Array.isArray(rawHeaders)) {
				for (const [k, v] of rawHeaders) set(k, String(v));
			} else {
				for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
					set(k, v);
				}
			}
		}
		let body: string | Buffer | undefined;
		if (init?.body !== undefined && init.body !== null) {
			if (typeof init.body === "string") body = init.body;
			else if (init.body instanceof Uint8Array) body = Buffer.from(init.body);
			else body = String(init.body);
		}
		const call: FetchCall = { url, method, headers, body };
		calls.push(call);
		const res = matcher(call);
		if (!res) throw new Error(`Unexpected fetch: ${method} ${url}`);
		const bodyBytes =
			typeof res.body === "string"
				? new TextEncoder().encode(res.body)
				: res.body instanceof Buffer
					? new Uint8Array(res.body)
					: new TextEncoder().encode(JSON.stringify(res.body));
		const responseHeaders = new Headers(res.headers ?? {});
		return new Response(bodyBytes, { status: res.status, headers: responseHeaders });
	};
	globalThis.fetch = handler as typeof fetch;
	return { restore: () => void (globalThis.fetch = original), calls };
}

export function assertHeader(call: FetchCall | undefined, name: string, value: string): void {
	assert(call, "no fetch call captured");
	assert(
		call.headers[name.toLowerCase()] === value,
		`expected header ${name}=${value}, got ${call.headers[name.toLowerCase()]}`,
	);
}