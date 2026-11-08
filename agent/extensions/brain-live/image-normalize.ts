/**
 * Image Normalize — imagens grandes não derrubam mais a chamada Anthropic.
 *
 * Antes de cada request Anthropic, reduz para ≤1568 px qualquer imagem do
 * histórico que passe disso (screenshots Retina têm 3000+ px). Resolve o
 * "image dimensions exceed max allowed size for many-image requests" e corta o
 * custo por imagem de ~7k para ~1.7k tokens. Cache por conteúdo: a imagem
 * histórica é reprocessada uma vez por processo, não a cada turno.
 *
 * Ver lib/image-normalize.ts para a lógica pura.
 */

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { resizeImage, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CacheImagens, LADO_MAX, normalizarPayloadAnthropic, type Redimensionador } from "./lib/image-normalize.ts";

const LOG = `${homedir()}/.pi/agent/garime-debug.log`;
function dbg(msg: string): void {
	// Sync append on every click/paste: opt-in only.
	if (process.env.GARIME_DEBUG !== "1") return;
	try {
		appendFileSync(LOG, `${new Date().toISOString()} [image-normalize] ${msg}\n`);
	} catch {}
}

export const redimensionar: Redimensionador = async (bytes, mimeType) => {
	const r = await resizeImage(bytes, mimeType, { maxWidth: LADO_MAX, maxHeight: LADO_MAX });
	if (!r) return null;
	return { data: r.data, mimeType: r.mimeType };
};

export default function imageNormalize(pi: ExtensionAPI) {
	const cache = new CacheImagens();

	pi.on("before_provider_request", async (event, ctx) => {
		if (ctx.model?.provider !== "anthropic") return;
		const t0 = Date.now();
		const r = await normalizarPayloadAnthropic(event.payload, redimensionar, cache);
		if (!r) return;
		dbg(`${r.reduzidas} imagem(ns) reduzida(s), ${r.falhas} falha(s), ${Date.now() - t0}ms, cache=${cache.size}`);
		if (r.falhas && ctx.hasUI) ctx.ui.notify(`image-normalize: ${r.falhas} imagem(ns) não puderam ser reduzidas`, "warning");
		return r.payload;
	});
}
