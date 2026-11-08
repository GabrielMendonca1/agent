import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { registerAskUserRequest } from "./ask-user-requests.mjs";

export const normalizeOption = option => option.replace(/\r?\n/g, " ").trim();

export function requestText(args) {
	return {
		title: args.title || args.question || "",
		body: (args.question || "") + (args.context ? `\n\n${args.context}` : "") + "\n\n[ask_user]" + (args.options ?? []).map(option => `\n- ${normalizeOption(option)}`).join(""),
	};
}
export function escalationDelay(value = process.env.MARK_ASK_USER_MEGAMIND_AFTER_MS) {
	if (value === "off" || value === "-1") return -1;
	const parsed = value?.trim() ? Number(value) : 60_000;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60_000;
}

/** Transporte local; falhas são tratadas pela tool. */
export async function createAskRequest(args, signal, piSessionId) {
	signal?.throwIfAborted();
	// No Pi a presença usa o id da sessão do Pi; o env vem do painel do app e não está registrado.
	const session = piSessionId || process.env.ARCA_MEGAMIND_SESSION_ID;
	if (!session) throw new Error("sem sessão");
	const config = JSON.parse(await readFile(process.env.ARCA_MEGAMIND_CONFIG || join(homedir(), ".config/arca-projects/config.json"), "utf8"));
	const endpoint = new URL(config.endpoint);
	if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== "https:" && !(process.env.ARCA_ALLOW_INSECURE_LOCALHOST === "1" && endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)))) throw new Error("endpoint inválido");
	const info = await lstat(config.token_file);
	if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077))) throw new Error("credencial inválida");
	const bearer = (await readFile(config.token_file, "utf8")).trim();
	if (!bearer) throw new Error("sem credencial");
	async function post(url, body, signal) {
		const response = await fetch(url, {
			method: "POST", redirect: "error",
			headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json", "MCP-Protocol-Version": "2025-03-26" },
			body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
		});
		if (!response.ok) throw new Error("Megamind indisponível");
		const data = await response.json();
		if (data.error) throw new Error("erro Megamind");
		return data;
	}
	async function call(name, args, signal) {
		const rpc = await post(endpoint, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, signal);
		const result = rpc.result;
		if (result?.isError) throw new Error("erro Megamind");
		return result?.content ? JSON.parse(result.content.find((item) => item.type === "text").text) : result;
	}
	const agents = await call("list_agents", {}, signal);
	const owner = agents.items?.find((item) => item.session_id === session)?.owner_id;
	if (!owner) throw new Error("sem dono");
	const requestId = randomUUID();
	// Registra antes do envio: o update pode chegar antes da resposta HTTP.
	registerAskUserRequest(requestId);
	const request = await call("request_create", { from_session: session, to: `actor:pb:${owner}`, ...requestText(args), request_id: requestId, ttl_hours: 1 }, signal);
	if (!request?.id) throw new Error("sem pedido");
	registerAskUserRequest(request.id);
	const controller = new AbortController();
	async function current(signal) {
		const data = await call("requests_list", { session_id: session, box: "outbox" }, signal);
		const item = data.items?.find((item) => item.id === request.id);
		if (!item) throw new Error("pedido ausente");
		return item;
	}
	const resultOf = item => item.status === "done" ? { answer: (item.result || "").trim() }
		: item.status === "declined" ? { dismissed: true } : undefined;
	const pause = ms => new Promise(resolve => {
		const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
		const timer = setTimeout(done, ms);
		controller.signal.addEventListener("abort", done, { once: true });
		if (controller.signal.aborted) done();
	});
	return {
		stop() { controller.abort(); },
		async wait(onRetry = () => {}) {
			let failures = 0;
			while (!controller.signal.aborted) {
				try {
					const item = await current(controller.signal);
					failures = 0;
					onRetry(false);
					const result = resultOf(item);
					if (result) return result;
					if (["failed", "expired"].includes(item.status)) return undefined;
				} catch {
					if (controller.signal.aborted) return;
					onRetry(true);
					failures++;
				}
				await pause(Math.min(30_000, 3_000 * 2 ** Math.min(failures, 4)));
			}
		},
		async close(answer) {
			controller.abort();
			const cleanup = AbortSignal.timeout(10_000);
			const url = new URL(endpoint);
			url.pathname = url.pathname.replace(/\/mcp\/?$/, `/me/requests/${encodeURIComponent(request.id)}/reply`);
			try {
				// O servidor decide; conflito exige leitura nova.
				let item = await current(AbortSignal.any([cleanup, AbortSignal.timeout(3_000)]));
				for (let attempt = 0; attempt < 4; attempt++) {
					const result = resultOf(item);
					if (result) return result;
					if (["failed", "expired"].includes(item.status)) return;
					const status = item.status === "sent" ? (answer ? "accepted" : "declined") : "done";
					try {
						await post(url, { status, result: status === "accepted" ? "" : answer ? `Respondida no terminal: ${answer}` : "Dispensada no terminal" }, cleanup);
						if (status !== "accepted") return;
					} catch {
						// Também reconcilia respostas perdidas na rede.
					}
					item = await current(cleanup);
				}
			} catch { /* Melhor esforço; TTL limita órfãos. */ }
		},
	};
}
