/**
 * Normalização de imagens antes de irem ao provedor.
 *
 * A Anthropic recusa requests com várias imagens quando qualquer uma passa de
 * 2000 px ("image dimensions exceed max allowed size for many-image
 * requests"), e cobra tokens por pixel (~w*h/750). Screenshots de Mac Retina
 * têm 3000+ px: cada um custa ~6-7k tokens e, a partir da segunda imagem no
 * histórico, derruba a chamada inteira. O Codex reduz do lado dele; a Anthropic
 * não. Aqui reduzimos para no máximo LADO_MAX (1568 px, o tamanho que a própria
 * Anthropic recomenda) — só quando necessário, com cache por conteúdo.
 */

import { createHash } from "node:crypto";

/** lado máximo recomendado pela Anthropic; abaixo do limite duro de 2000 px */
export const LADO_MAX = 1568;
/** base64 acima disto sempre é reprocessado, mesmo que as dimensões passem */
export const BYTES_MAX = 4 * 1024 * 1024;

export interface Dimensoes {
	width: number;
	height: number;
}

export interface ImagemNormalizada {
	data: string;
	mimeType: string;
}

export type Redimensionador = (bytes: Uint8Array, mimeType: string) => Promise<ImagemNormalizada | null>;

/** Lê largura/altura do cabeçalho sem decodificar a imagem. */
export function dimensoesDe(bytes: Uint8Array): Dimensoes | undefined {
	if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		return { width: dv.getUint32(16), height: dv.getUint32(20) };
	}
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let i = 2;
		while (i + 9 < bytes.length) {
			if (bytes[i] !== 0xff) {
				i++;
				continue;
			}
			const marker = bytes[i + 1]!;
			if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
				i += 2;
				continue;
			}
			const len = dv.getUint16(i + 2);
			const sof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
			if (sof) return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
			i += 2 + len;
		}
		return undefined;
	}
	if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
		return { width: bytes[6]! | (bytes[7]! << 8), height: bytes[8]! | (bytes[9]! << 8) };
	}
	if (bytes.length >= 30 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
		const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
		const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (chunk === "VP8 ") return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
		if (chunk === "VP8L") {
			const b = dv.getUint32(21, true);
			return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
		}
		if (chunk === "VP8X") return { width: (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1, height: (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1 };
	}
	return undefined;
}

/** Precisa reduzir? Desconhecido (cabeçalho ilegível) conta como "sim" se for grande em bytes. */
export function precisaReduzir(bytes: Uint8Array): boolean {
	if (bytes.byteLength > BYTES_MAX) return true;
	const d = dimensoesDe(bytes);
	if (!d) return false;
	return d.width > LADO_MAX || d.height > LADO_MAX;
}

export function chaveDe(data: string): string {
	return createHash("sha1").update(data).digest("hex");
}

/** Cache por conteúdo: a mesma imagem histórica volta em todo request, não pode ser reprocessada toda hora. */
export class CacheImagens {
	private mapa = new Map<string, ImagemNormalizada | null>();
	constructor(private readonly max = 64) {}
	get(k: string): ImagemNormalizada | null | undefined {
		const v = this.mapa.get(k);
		if (v !== undefined) {
			this.mapa.delete(k);
			this.mapa.set(k, v);
		}
		return v;
	}
	set(k: string, v: ImagemNormalizada | null): void {
		this.mapa.set(k, v);
		if (this.mapa.size > this.max) this.mapa.delete(this.mapa.keys().next().value!);
	}
	get size(): number {
		return this.mapa.size;
	}
}

/** Reduz uma imagem (base64) se necessário; devolve undefined quando já está boa. */
export async function normalizarImagem(data: string, mimeType: string, redimensionar: Redimensionador, cache: CacheImagens): Promise<ImagemNormalizada | null | undefined> {
	const chave = chaveDe(data);
	const hit = cache.get(chave);
	if (hit !== undefined) return hit;
	const bytes = Buffer.from(data, "base64");
	if (!precisaReduzir(bytes)) {
		cache.set(chave, null);
		return undefined;
	}
	let out: ImagemNormalizada | null = null;
	try {
		out = await redimensionar(bytes, mimeType);
	} catch {
		out = null;
	}
	cache.set(chave, out);
	return out;
}

export interface ResultadoPayload {
	payload: unknown;
	reduzidas: number;
	falhas: number;
}

/**
 * Anthropic Messages: `messages[*].content[*]` com `{type:"image", source:{type:"base64", media_type, data}}`.
 * Devolve payload novo só quando alguma imagem foi reduzida; senão undefined (mantém o original).
 */
export async function normalizarPayloadAnthropic(payload: any, redimensionar: Redimensionador, cache: CacheImagens): Promise<ResultadoPayload | undefined> {
	const msgs = payload?.messages;
	if (!Array.isArray(msgs)) return;
	let reduzidas = 0;
	let falhas = 0;
	const novasMsgs = await Promise.all(
		msgs.map(async (m: any) => {
			if (!Array.isArray(m?.content)) return m;
			let mudou = false;
			const content = await Promise.all(
				m.content.map(async (bloco: any) => {
					const src = bloco?.source;
					if (bloco?.type !== "image" || src?.type !== "base64" || typeof src.data !== "string") return bloco;
					const r = await normalizarImagem(src.data, src.media_type ?? "image/png", redimensionar, cache);
					if (r === undefined) return bloco;
					if (r === null) {
						falhas++;
						return bloco;
					}
					reduzidas++;
					mudou = true;
					return { ...bloco, source: { ...src, media_type: r.mimeType, data: r.data } };
				}),
			);
			return mudou ? { ...m, content } : m;
		}),
	);
	if (!reduzidas) return;
	return { payload: { ...payload, messages: novasMsgs }, reduzidas, falhas };
}
