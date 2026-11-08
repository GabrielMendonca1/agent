// Qual Megamind esta sessão usa. O enrollment é por empresa (ARCA, Omni) e mora
// em `~/.config/<empresa>/config.json`: é o caminho da config que diz de quem é
// o servidor, e é isso que a barra de status e o `/megamind` mostram.
// Módulo puro: nada de `pi`, nada de rede.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * Empresa → enrollment, rótulo, app, pasta da config e canal do servidor.
 * Empresa nova é uma linha aqui; a primeira é a padrão (a que o nome do
 * produto já diz, e a que vale sem enrollment nenhum).
 */
const COMPANY_LIST = [
  { id: "arca", label: "ARCA", app: "ARCA Desktop", dir: "arca-projects", group: "arca", setup: "INSTALAR.md, seção 6" },
  { id: "omni", label: "Omni", app: "Omni", dir: "omni-megamind", group: "omni", env: "OMNI_MEGAMIND_CONFIG" },
] as const;

export type MegamindCompanyId = (typeof COMPANY_LIST)[number]["id"];
export type MegamindProfileId = MegamindCompanyId | "none" | "custom";

export type MegamindCompany = {
  id: MegamindCompanyId;
  /** Nome da empresa para a UI. */
  label: string;
  /** App da empresa, para quando o peers não alcança a outra sessão. */
  app: string;
  /** Pasta do enrollment em `~/.config/`. */
  dir: string;
  /** Canal de grupo do chat e chave de `capabilities` deste servidor. */
  group: string;
  /** Env que move a config desta empresa, como no app dela. */
  env?: string;
  /** Onde o setup desta empresa está documentado, quando há documento. */
  setup?: string;
};

export const COMPANIES: readonly MegamindCompany[] = COMPANY_LIST;

/** Empresa padrão: a primeira linha da tabela. */
export const DEFAULT_COMPANY: MegamindCompany = COMPANY_LIST[0];

export type MegamindProfile = {
  id: MegamindProfileId;
  /** Nome da empresa para a UI; `none` não tem. */
  label?: string;
  /** Config do enrollment, como o chamador a declarou (sem resolver links). */
  configPath?: string;
};

/** Sentinela de "este projeto não fala com Megamind nenhum". */
export const MEGAMIND_NONE = "none";

/** Empresa deste perfil; `none` e `custom` não estão na tabela. */
export function companyOf(profile: MegamindProfileId): MegamindCompany | undefined {
  return COMPANIES.find((company) => company.id === profile);
}

/** Nome deste Megamind em texto de gente: `ARCA Megamind`, `Omni Megamind`. */
export function megamindName(profile: MegamindProfile = megamindProfile()): string {
  return profile.label ? `${profile.label} Megamind` : "Megamind";
}

/** App da empresa deste perfil, por onde se combina fora do peers. */
export function megamindApp(profile: MegamindProfile = megamindProfile()): string {
  return companyOf(profile.id)?.app ?? (profile.label ? `app ${profile.label}` : "o app da empresa");
}

export function defaultConfigPath(home = homedir()): string {
  return join(home, ".config", DEFAULT_COMPANY.dir, "config.json");
}

/** Config do enrollment desta empresa; a env dela a move, como no app. */
function companyConfigPath(company: MegamindCompany, env: NodeJS.ProcessEnv | Record<string, string | undefined>, home: string): string {
  const declared = ((company.env ? env[company.env] : undefined) ?? "").trim();
  return declared ? absolute(declared, home) : join(home, ".config", company.dir, "config.json");
}

/** `~/…` no env vira caminho real; relativo resolve contra o cwd. */
function absolute(value: string, home: string): string {
  const expanded = value === "~" || value.startsWith(`~${sep}`) || value.startsWith("~/")
    ? join(home, value.slice(1))
    : value;
  return resolve(expanded);
}

/** `true` quando o caminho está dentro do diretório (nunca em um irmão de nome parecido). */
function inside(path: string, directory: string): boolean {
  return path.startsWith(directory.endsWith(sep) ? directory : `${directory}${sep}`);
}

/**
 * Perfil desta sessão a partir de `ARCA_MEGAMIND_CONFIG`: sem a variável vale o
 * enrollment que a máquina tem (a ordem da tabela decide o empate), e sem
 * enrollment nenhum fica a empresa padrão inerte — sem credencial não há rede.
 * Caminho dentro da pasta de uma empresa conhecida é dela; qualquer outro é um
 * Megamind próprio, nomeado pela pasta da config. A pasta vale fora do HOME
 * também (teste, HOME alternativo): é ela que o setup cria por empresa.
 */
export function megamindProfile(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env, home = homedir()): MegamindProfile {
  const raw = (env.ARCA_MEGAMIND_CONFIG ?? "").trim();
  if (raw.toLowerCase() === MEGAMIND_NONE) return { id: "none" };
  if (!raw) {
    for (const company of COMPANIES) {
      const path = companyConfigPath(company, env, home);
      if (existsSync(path)) return { id: company.id, label: company.label, configPath: path };
    }
    const fallback = companyConfigPath(DEFAULT_COMPANY, env, home);
    return { id: DEFAULT_COMPANY.id, label: DEFAULT_COMPANY.label, configPath: fallback };
  }
  const path = absolute(raw, home);
  const config = join(home, ".config");
  const folder = basename(dirname(path));
  for (const company of COMPANIES) {
    if (inside(path, join(config, company.dir)) || folder === company.dir) {
      return { id: company.id, label: company.label, configPath: raw };
    }
  }
  // Enrollment fora dos conhecidos: a pasta que guarda a config dá o nome.
  return { id: "custom", label: folder, configPath: raw };
}
