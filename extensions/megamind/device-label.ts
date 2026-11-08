// Como esta máquina se chama na presença. `hostname()` muda com a rede (`x@192`
// numa hora, `x@Gabriels-MacBook-Pro` noutra) e cada valor vira uma sessão com
// nome diferente aos olhos dos sócios; o rótulo do dispositivo é o do
// enrollment, e o servidor o devolve em `register_agent`/`list_agents`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { cacheDir, stripControl } from "./gateway.ts";

/** Rótulo do dispositivo aprendido do servidor, entre execuções. */
export function deviceLabelFile(): string {
  return join(cacheDir(), "device-label");
}

let cached: string | undefined;

export function readDeviceLabel(): string {
  if (cached !== undefined) return cached;
  try {
    cached = [...stripControl(readFileSync(deviceLabelFile(), "utf8")).trim()].slice(0, 80).join("");
  } catch {
    cached = "";
  }
  return cached;
}

export function rememberDeviceLabel(value: string | undefined): void {
  const label = [...stripControl(value ?? "").trim()].slice(0, 80).join("");
  if (!label || label === readDeviceLabel()) return;
  cached = label;
  try {
    mkdirSync(dirname(deviceLabelFile()), { recursive: true });
    writeFileSync(deviceLabelFile(), `${label}\n`);
  } catch {
    // cache é conforto: sem ele o nome volta a sair do hostname
  }
}

/** Nome desta máquina na presença; o hostname só como reserva. */
export function deviceName(): string {
  return readDeviceLabel() || hostname();
}

/** Só para teste: esquece o que já foi lido do disco. */
export function forgetDeviceLabel(): void {
  cached = undefined;
}
