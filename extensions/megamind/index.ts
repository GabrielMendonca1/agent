import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { blamesIdleField, CORE_V6, FIELD, LIMITS, OPEN_STATUS, rejectsIdleField, rejectsValidation, TOOL } from "./contract.ts";
import { lastPromptPreview } from "./last-prompt.ts";
import {
  resetCore,
  resolveCore,
  type CoreHello,
  type CoreItem,
  type CorePerson,
  type CorePriority,
  type CoreSession,
  type HelloArgs,
  type MegamindCore,
} from "./core.ts";
import {
  cacheDir,
  checkedToolCall,
  configPath,
  ERROR_DETAIL,
  gatewayStatus,
  MEGAMIND_OFF,
  megamindDisabled,
  metadata,
  object,
  openEvents,
  redactBearer,
  resultList,
  resultRecord,
  safeMessage,
  stripControl,
  text,
  token,
  type EventsHandle,
} from "./gateway.ts";
import { fetchCatalog, resolveProjectId } from "./catalog.ts";
import {
  Inbox,
  MESSAGE_TYPE,
  looksSecret,
  optional,
  outgoing,
  overlapNotice,
  safeInline,
} from "./messaging.ts";
import {
  normalizeNote,
  registerMegamindTools,
  shortId,
  type Presence,
} from "./tools.ts";
import { MEGAMIND_STATUS_KEY, megamindStatus, type MegamindState } from "./status.ts";
import { companyOf, DEFAULT_COMPANY, megamindName, megamindProfile } from "./profile.ts";
import { changedPaths, currentBranch, repoKeyOf, repoRoot } from "./repos.ts";
import { coordinateHint, localityOf } from "./devices.ts";
import {
  priorityStatus,
} from "./priorities.ts";
import { deviceName, rememberDeviceLabel } from "./device-label.ts";
import { provisionSsh, type SshProvisionResult } from "./ssh-provision.ts";

/**
 * Módulo de renderização da TUI. Ele depende de `@earendil-works/pi-tui`, que
 * só é resolvível dentro do runtime do Pi, então entra por import tardio: fora
 * do Pi (teste, CI) a extensão segue funcionando com os cards padrão.
 */
type RenderModule = typeof import("./render.ts");

const HEARTBEAT_MS = 60_000;
const IDLE_LIMIT_MS = 15 * 60_000;
/**
 * Enquanto o Pi estiver aberto, a presença continua existindo: ociosa, ela se
 * renova a cada 5 min com `idle: true`, e o servidor a mostra como parada em vez
 * de sumir. Servidor sem o campo (antigo) volta ao comportamento de expirar.
 */
const IDLE_REGISTER_MS = 5 * 60_000;
/** Throttle da resolução cwd→projeto (catálogo + git). */
const RESOLVE_MS = 10 * 60_000;
const INBOX_MIN_INTERVAL_MS = 5_000;
/**
 * Leitura de inbox com a sessão ociosa. O `inbox` do Mainframe atualiza
 * `last_seen`, então ler a cada 60 s manteria a presença eternamente "active"
 * mesmo sem ninguém trabalhando: ocioso, a leitura espaça para ~15 min.
 */
const IDLE_POLL_MS = 15 * 60_000;
/** Backoff limitado; tentativas param quando a sessão fica ociosa. */
const REGISTER_RETRY_MS = [5_000, 30_000, 120_000] as const;
const LABEL_MAX = 60;
/** `arcaLabel` do gateway exige 8 chars no mínimo. */
const LABEL_MIN = 8;
/** `bye` no shutdown é best-effort: não segura o encerramento. */
const BYE_TIMEOUT_MS = 3_000;
/** Mensagem custom do aviso de sobreposição (entra no contexto, não dispara turno). */
const PEER_TYPE = "arca-megamind-peer";
/** Prefixo das tools desta extensão (o hook de resultado só olha as nossas). */
const TOOL_PREFIX = "megamind_";
const PRIORITY_STATUS_KEY = "arca-megamind-priority";

function setupHintFile(): string {
  return join(cacheDir(), "setup-hint");
}

/** Label curto e válido: sem quebra de linha, sem colchete, sem caminho, 8..60 chars. */
export function sessionLabel(root: string | undefined, cwd: string, machine = deviceName()): string {
  const clean = (value: string) => stripControl(value.replace(/[\[\]\r\n]/gu, "")).trim();
  const repo = clean(basename(root ?? cwd)) || "pi";
  const host = clean(machine.split(".")[0] ?? "");
  const label = clean(`pi ${repo}${host ? `@${host}` : ""}`).slice(0, LABEL_MAX).trim();
  // Repo e host curtos dariam label de 4 chars, que o servidor recusa.
  return label.length >= LABEL_MIN ? label : clean(`pi session ${repo}`).slice(0, LABEL_MAX).trim();
}

/** Item de `overlaps` da sessão devolvida pelo `hello` (emenda 1). */
type Overlap = {
  session_id: string;
  label?: string;
  owner_name?: string;
  branch?: string;
  same_branch?: boolean;
  paths: string[];
};

/** `overlaps` da sessão devolvida pelo `hello`; item sem interseção é ignorado. */
function parseOverlaps(value: unknown): Overlap[] {
  const overlaps: Overlap[] = [];
  for (const item of resultList(value, FIELD.overlaps)) {
    if (!object(item)) continue;
    const session_id = text(item.session_id);
    const paths = Array.isArray(item.paths)
      ? item.paths.filter((path): path is string => typeof path === "string").slice(0, 20)
      : [];
    if (!session_id || paths.length === 0) continue;
    overlaps.push({
      session_id,
      paths,
      ...optional(item, "label"),
      ...optional(item, "owner_name"),
      ...optional(item, "branch"),
      ...(item.same_branch === true ? { same_branch: true } : {}),
    });
  }
  return overlaps;
}

export type ExtensionOptions = { now?: () => number; inboxDeliveryTimeoutMs?: number; inboxDeliveryRetryMs?: number };

export default function arcaMegamindExtension(pi: ExtensionAPI, options: ExtensionOptions = {}) {
  const now = options.now ?? Date.now;
  let active = false;
  let sshTask: Promise<SshProvisionResult> | undefined;
  // Geração da sessão: resposta de requisição antiga nunca reativa presença.
  let epoch = 0;
  let registered = false;
  let presence: Presence | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let resolveTimer: ReturnType<typeof setInterval> | undefined;
  let events: EventsHandle | undefined;
  /** Avisos já dados nesta sessão: cada falha fala uma vez só. */
  const warnedOnce = new Set<string>();
  let lastActivity = now();
  /** Último `hello` mandado com a sessão ociosa. */
  let lastIdleHelloAt = 0;
  /**
   * Servidor aceita o campo `idle`. Uma recusa de validação por causa dele
   * (servidor antigo) desliga o campo e o heartbeat ocioso para o resto da sessão.
   */
  let idleFieldSupported = true;
  /**
   * Servidor recusou `last_prompt` por validação: o campo é opcional, então some
   * pelo resto da sessão em vez de repetir a recusa a cada heartbeat.
   */
  let lastPromptRefused = false;
  let lastResolveAt = 0;
  let lastResolveOk = false;
  let notify: ((message: string, level: "info" | "warning") => void) | undefined;
  let isIdle: (() => boolean) | undefined;
  let sessionId: string | undefined;
  let sessionCwd: string | undefined;
  /** Handle do dono desta sessão, como o `hello` o devolve. */
  let selfHandle: string | undefined;
  let autoRegistering = false;
  let autoAttempt = 0;
  let bootstrapAttempt = 0;
  let bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  // Estado do repo do cwd (diagnóstico e presença).
  let repo: { root?: string; repo_key?: string; project_id?: string } = {};
  let cwdProjectId: string | undefined;
  /** Primeira linha do último prompt do usuário: base da nota automática. */
  let lastPrompt = "";
  let resolving = false;
  /** Pares já avisados por interseção de arquivos nesta sessão. */
  const announced = new Set<string>();
  /** Última interseção anunciada por par (aviso forte repete quando muda). */
  const overlapsSeen = new Map<string, string>();
  /** Sessões que o `who` mostrou na última rodada: é de lá que vem `same_device`. */
  let peerSessions = new Map<string, CoreSession & { owner?: string }>();
  /** Pedidos de colega em atendimento nesta sessão: `id -> título`. */
  const openRequests = new Map<string, string>();
  /** Leitura de inbox adiada pelo intervalo mínimo (dica de SSE não se perde). */
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let inboxWakeTimer: ReturnType<typeof setTimeout> | undefined;
  let priorityContext: ExtensionContext | undefined;
  let currentPriority: CorePriority | undefined;
  /** Estado mostrado na barra de status; só transição mexe na UI. */
  let connection: MegamindState | undefined;
  let renderModule: RenderModule | undefined;
  let renderFailed = false;
  let messageRenderers = false;
  /** Cota de conexões SSE do dispositivo estourada: só o polling entrega. */
  let eventsQuota = false;
  /** `true` enquanto o núcleo é o adaptador v5, onde a caixa ainda exige ack. */
  let acknowledges = true;
  /** `capabilities.<empresa>.core` do servidor desta sessão (diagnóstico). */
  let coreVersion: number | undefined;

  /** Empresa deste Megamind (barra de status); a padrão não marca o bloco da caixa. */
  function profileLabel(): string | undefined {
    return megamindProfile().label;
  }

  /** Marca da empresa dentro do bloco da caixa: só quando não é a padrão. */
  function inboxLabel(): string | undefined {
    const profile = megamindProfile();
    return profile.id === DEFAULT_COMPANY.id ? undefined : profile.label;
  }

  /** Núcleo desta sessão (v6 ou adaptador v5), com o regime de ack junto. */
  async function core(signal?: AbortSignal, requireProbe = false): Promise<MegamindCore> {
    const resolved = await resolveCore(signal, requireProbe);
    acknowledges = resolved.acknowledges;
    coreVersion = resolved.core;
    return resolved;
  }

  /** Aviso de falha: uma vez por motivo, até a sessão reiniciar. */
  function warnOnce(key: string, message: string): void {
    if (warnedOnce.has(key)) return;
    warnedOnce.add(key);
    notify?.(message, "warning");
  }

  /** Solta a presença. Remapear o projeto não muda a sessão dona da inbox. */
  function dropPresence(): void {
    presence = undefined;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
    events?.close();
    events = undefined;
    announced.clear();
    overlapsSeen.clear();
    peerSessions = new Map();
    clearInboxWake();
    // Mantenha os estacionados e o estado dos envios ainda em voo até o shutdown.
    currentPriority = undefined;
    setPriorityStatus(undefined);
    // Sem projeto vinculado o ícone some: o Megamind não vale para este cwd.
    if (active) setConnection(cwdProjectId ? "connecting" : undefined);
  }

  /** Estado por sessão num lugar só: o shutdown devolve tudo isto ao zero. */
  function freshSession(): void {
    sshTask = undefined;
    dropPresence();
    inbox.reset();
    isIdle = undefined;
    notify = undefined;
    sessionId = undefined;
    sessionCwd = undefined;
    cwdProjectId = undefined;
    repo = {};
    lastPrompt = "";
    lastPromptRefused = false;
    autoRegistering = false;
    autoAttempt = 0;
    bootstrapAttempt = 0;
    lastResolveAt = 0;
    lastResolveOk = false;
    openRequests.clear();
    priorityContext = undefined;
    currentPriority = undefined;
    selfHandle = undefined;
    eventsQuota = false;
    coreVersion = undefined;
    setConnection(undefined);
    resetCore();
    warnedOnce.clear();
  }

  function messagingFailed(error: unknown) {
    warnOnce("messaging", `${megamindName()} messaging failed: ${safeMessage(error)}`);
  }

  const inbox = new Inbox({
    now,
    deliveryTimeoutMs: options.inboxDeliveryTimeoutMs,
    deliveryRetryMs: options.inboxDeliveryRetryMs,
    // O núcleo lança quando o gateway recusa (503, rate limit): recusa nunca
    // pode passar por "caixa vazia", senão o prune apagaria fila, ack pendente e
    // memória do que já foi entregue, e o item voltaria duplicado.
    fetch: async (session_id, cursor, limit) => {
      const engine = await core(undefined, true);
      return engine.readInbox ? engine.readInbox(session_id, cursor, limit) : engine.read(session_id, {});
    },
    ack: async (session_id, ids) => (await core()).ack(session_id, ids),
    get acknowledges() {
      return acknowledges;
    },
    deliver: (content, _signal, marker) => {
      const active = pi.getActiveTools?.();
      if (active && !active.includes("megamind_reply")) pi.setActiveTools([...active, "megamind_reply"]);
      pi.sendMessage(
        { customType: MESSAGE_TYPE, content, display: true, details: { inboxInsertion: marker } },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      // O Pi expõe send_message assíncrono só no runner interno, sem identidade do
      // envio. Só um throw desta chamada comprova falha e permite um novo envio.
      return "await-insertion";
    },
    warn: (error, category) => {
      if (category === "malformed") warnOnce("inbox-malformed", safeMessage(error));
      else if (category === "parked") {
        const message = safeMessage(error);
        pi.appendEntry("megamind-inbox-parked", { message });
        warnOnce(`inbox-parked:${message}`, message);
      } else messagingFailed(error);
    },
    onDiscarded: (count) => pi.appendEntry("megamind-inbox-discarded", { count }),
    onDelivered: (item) => trackDelivered(item),
    self: () => selfHandle,
    megamind: () => inboxLabel(),
  });

  /** Mantém a lista de pedidos entregues em atendimento. */
  function trackDelivered(item: CoreItem): void {
    if (item.kind === "ask") openRequests.set(item.id, item.ask?.title ?? "");
    if (item.kind === "reply" && item.ask?.status && !OPEN_STATUS.includes(item.ask.status)) {
      openRequests.delete(item.id);
    }
  }

  /** Reconcilia os pedidos em atendimento com o servidor. */
  async function reconcileRequests(current: Presence, reload = false): Promise<void> {
    if (!reload && openRequests.size === 0) return;
    const generation = epoch;
    let items: unknown[];
    try {
      items = resultList(await checkedToolCall(TOOL.requestsList, { session_id: current.session_id, box: "inbox" }));
    } catch (error) {
      messagingFailed(error);
      return;
    }
    if (!active || generation !== epoch || presence !== current) return;
    const live = new Map<string, { status?: string; handled_by_session?: string; title?: string }>();
    for (const item of items) {
      if (!object(item)) continue;
      const id = text(item.id);
      if (!id) continue;
      live.set(id, { ...optional(item, "status"), ...optional(item, "handled_by_session"), ...optional(item, "title") });
    }
    for (const id of [...openRequests.keys()]) {
      const entry = live.get(id);
      // Pedido fora da página (50 mais recentes): mantém o acompanhamento local.
      if (!entry) continue;
      const mine = !entry.handled_by_session || entry.handled_by_session === current.session_id;
      if (!mine || !entry.status || !OPEN_STATUS.includes(entry.status)) {
        openRequests.delete(id);
      }
    }
    if (reload) {
      for (const [id, entry] of live) {
        if (openRequests.has(id)) continue;
        if (entry.handled_by_session !== current.session_id) continue;
        if (entry.status !== "accepted" && entry.status !== "in_progress") continue;
        openRequests.set(id, entry.title ?? "");
      }
    }
  }

  /** `megamind_read` sem `with`: lê a caixa agora e entrega tudo de uma vez. */
  async function readInbox(): Promise<CoreItem[]> {
    const current = presence;
    if (!active) return [];
    if (!current || !cwdProjectId) return inbox.takeParked();
    await inbox.poll(current.session_id, now());
    if (!active) return [];
    if (presence !== current) return inbox.takeParked();
    confirmInboxInsertion(priorityContext);
    return inbox.takeAll(current.session_id);
  }

  function clearInboxWake(): void {
    if (inboxWakeTimer !== undefined) clearTimeout(inboxWakeTimer);
    inboxWakeTimer = undefined;
  }

  function scheduleInboxWake(): void {
    clearInboxWake();
    if (!active || !presence || isIdle?.() !== true) return;
    const at = inbox.nextRetryAt();
    if (at === undefined) return;
    inboxWakeTimer = setTimeout(deliverNext, Math.max(0, at - now()));
    inboxWakeTimer.unref?.();
  }

  // Entrega só com a sessão ociosa (modelo do pi-relay); ack só depois de entregar.
  function deliverNext() {
    clearInboxWake();
    if (!active || !presence || isIdle?.() !== true) return;
    const current = presence;
    if (confirmInboxInsertion(priorityContext)) pollSoon();
    const delivery = inbox.drain(current.session_id, true);
    if (!delivery) scheduleInboxWake();
    else void delivery.then(() => {
      if (!active || presence !== current) return;
      scheduleInboxWake();
      pollSoon();
    }).catch(messagingFailed);
  }

  /** Leitura antecipada da inbox (evento SSE ou sessão ociosa), com intervalo mínimo de 5 s. */
  function pollSoon() {
    if (!active || !presence) return;
    const since = now() - inbox.lastPollAt;
    if (since < INBOX_MIN_INTERVAL_MS) {
      // Dica recente demais: agenda em vez de descartar (senão o evento SSE
      // esperaria o tick de 60 s).
      if (pollTimer !== undefined) return;
      pollTimer = setTimeout(() => {
        pollTimer = undefined;
        pollSoon();
      }, INBOX_MIN_INTERVAL_MS - since);
      pollTimer.unref?.();
      return;
    }
    const current = presence;
    void inbox.poll(current.session_id, now())
      .then(() => {
        if (active && presence === current) deliverNext();
      })
      .catch(messagingFailed);
  }

  function stopTimers() {
    clearInboxWake();
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
    if (resolveTimer !== undefined) clearInterval(resolveTimer);
    resolveTimer = undefined;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    if (bootstrapTimer !== undefined) clearTimeout(bootstrapTimer);
    bootstrapTimer = undefined;
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = undefined;
    events?.close();
    events = undefined;
  }

  /** Nota genérica: o que dá para dizer sem publicar o prompt do usuário. */
  function genericNote(): string {
    const where = repo.repo_key ?? (repo.root ? basename(repo.root) : undefined) ?? cwdProjectId ?? presence?.project_id;
    return where ? normalizeNote(`trabalhando em ${where}`) : "";
  }

  /**
   * Nota da presença: automática, a primeira linha do último pedido do usuário.
   * Ela vai para a coleção de agentes do Mainframe, legível por todo sócio,
   * então prompt com cara de segredo nunca é publicado — vira uma linha genérica.
   */
  function currentNote(): string {
    if (process.env.ARCA_MEGAMIND_AUTO_NOTE === "0") return "";
    const auto = normalizeNote(redactBearer(lastPrompt.split("\n")[0] ?? ""));
    if (!auto) return "";
    return looksSecret(auto) ? genericNote() : auto;
  }

  /**
   * Ícone do Megamind na barra de status. Substitui o antigo aviso no
   * transcript: a presença se vê, não se lê.
   */
  function setConnection(state: MegamindState | undefined): void {
    if (state === connection) return;
    connection = state;
    const ctx = priorityContext;
    if (!ctx?.hasUI || typeof ctx.ui.setStatus !== "function") return;
    ctx.ui.setStatus(MEGAMIND_STATUS_KEY, state && repo.project_id ? megamindStatus(state, ctx.ui.theme, profileLabel()) : undefined);
  }

  function setPriorityStatus(priority: CorePriority | undefined): void {
    const ctx = priorityContext;
    if (!ctx?.hasUI || typeof ctx.ui.setStatus !== "function") return;
    if (!priority) {
      ctx.ui.setStatus(PRIORITY_STATUS_KEY, undefined);
      return;
    }
    const value = priorityStatus(priority);
    ctx.ui.setStatus(PRIORITY_STATUS_KEY, priority.blocked.length > 0 ? ctx.ui.theme.fg("error", value) : value);
  }

  /** Prioridade do `hello`: só na barra de status; no contexto do agente era ruído repetido. */
  function updatePriority(priority: CorePriority | undefined): void {
    currentPriority = priority;
    setPriorityStatus(priority);
  }

  function projectName(): string {
    return presence?.project_id ?? cwdProjectId ?? (repo.root ? basename(repo.root) : "") ?? "";
  }

  /** Branch e caminhos tocados do clone (uma rodada só de git). */
  async function repoSnapshot(root: string | undefined, signal?: AbortSignal): Promise<{ branch: string | null; paths: string[] }> {
    if (!root) return { branch: null, paths: [] };
    const options = signal ? { signal } : {};
    const [branch, paths] = await Promise.all([currentBranch(root, options), changedPaths(root, options)]);
    return { branch, paths };
  }

  /** Prévia do último prompt humano: omitida enquanto ninguém digitou nada (omitir mantém a anterior). */
  function promptPreview(): { last_prompt?: string } {
    if (!lastPrompt || process.env.ARCA_MEGAMIND_AUTO_NOTE === "0") return {};
    return { last_prompt: lastPromptPreview(lastPrompt) };
  }

  /** Presença completa: label, nota, branch e caminhos tocados (emenda 3). */
  async function presenceArgs(current: Presence, idle?: boolean, withLastPrompt = false): Promise<HelloArgs> {
    const { branch, paths } = await repoSnapshot(repo.root);
    // O rótulo do dispositivo pode ter chegado depois do primeiro registro: o
    // label é recalculado aqui para a presença convergir para o nome estável.
    current.label = sessionLabel(repo.root, sessionCwd ?? process.cwd());
    return {
      ...current,
      cwd: sessionCwd ?? process.cwd(),
      note: currentNote(),
      ...(branch ? { branch } : {}),
      paths,
      ...(idleFieldSupported && idle !== undefined ? { idle } : {}),
      ...(withLastPrompt ? promptPreview() : {}),
    };
  }

  /**
   * `hello` com o campo `idle` (v5: `register_agent`). Servidor que não conhece
   * o campo recusa a chamada por validação; aí o cliente guarda isso e repete
   * sem ele — uma vez por sessão, nunca a cada heartbeat.
   */
  async function sayHello(current: Presence, options: { idle?: boolean } = {}): Promise<CoreHello> {
    const engine = await core();
    // `last_prompt` só sai quando o servidor o anuncia (§2.2).
    const withLastPrompt = engine.lastPrompt && !lastPromptRefused;
    try {
      return await engine.hello(await presenceArgs(current, options.idle, withLastPrompt));
    } catch (error) {
      const message = safeMessage(error);
      // Campo novo na chamada: ele é o suspeito, a não ser que a recusa nomeie `idle`.
      if (withLastPrompt && rejectsValidation(message)) {
        lastPromptRefused = true;
        if (idleFieldSupported && options.idle !== undefined && blamesIdleField(message)) idleFieldSupported = false;
        return engine.hello(await presenceArgs(current, idleFieldSupported ? options.idle : undefined));
      }
      if (!idleFieldSupported || options.idle === undefined || !rejectsIdleField(message)) throw error;
      idleFieldSupported = false;
      return engine.hello(await presenceArgs(current));
    }
  }

  /** O que o `hello` traz de volta: quem eu sou, meu dispositivo e a prioridade. */
  function applyHello(hello: CoreHello): void {
    if (hello.handle) selfHandle = hello.handle;
    rememberDeviceLabel(text(resultRecord(hello.session)?.device_label));
    updatePriority(hello.priority);
  }

  /** Resolve o projeto pelo catálogo, remoto ou pasta. `undefined` = falha transitória. */
  async function resolveProject(cwd: string): Promise<string | null | undefined> {
    if (resolving) return undefined;
    resolving = true;
    try {
      const root = await repoRoot(cwd);
      repo = { ...(root ? { root } : {}) };
      const key = root ? await repoKeyOf(root) : null;
      if (key) repo.repo_key = key;
      const catalog = key ? await fetchCatalog() : undefined;
      const project = resolveProjectId(root ?? cwd, key, catalog);
      repo.project_id = key ? catalog?.byRepo.get(key) : undefined;
      return project;
    } catch (error) {
      warnOnce("resolve", `${megamindName()} repo catalog unavailable: ${safeMessage(error)}`);
      return undefined;
    } finally {
      resolving = false;
    }
  }

  async function refreshProject(cwd: string) {
    if (!active) return;
    const generation = epoch;
    const project_id = await resolveProject(cwd);
    if (generation !== epoch || !active) return;
    lastResolveAt = now();
    lastResolveOk = project_id !== undefined;
    if (project_id === undefined) {
      const delay = REGISTER_RETRY_MS[Math.min(bootstrapAttempt++, REGISTER_RETRY_MS.length - 1)]!;
      if (bootstrapTimer === undefined && now() - lastActivity <= IDLE_LIMIT_MS) {
        bootstrapTimer = setTimeout(() => {
          bootstrapTimer = undefined;
          if (generation === epoch && active && now() - lastActivity <= IDLE_LIMIT_MS) void refreshProject(cwd);
        }, delay);
        bootstrapTimer.unref?.();
      }
      return;
    }
    bootstrapAttempt = 0;
    if (bootstrapTimer !== undefined) clearTimeout(bootstrapTimer);
    bootstrapTimer = undefined;
    const previousProject = cwdProjectId;
    cwdProjectId = project_id ?? undefined;
    if (presence && presence.project_id === previousProject && previousProject !== cwdProjectId) dropPresence();
    // A presença também existe fora do catálogo; o ícone mantém a regra visual atual.
    if (!cwdProjectId) setConnection(undefined);
    else if (!presence && connection === undefined) setConnection("connecting");
    await ensurePresence();
  }

  /**
   * Projeto resolvido: a sessão vira presença real, com o id de sessão
   * do Pi. Nunca inventa nota fora do que o usuário já escreveu.
   */
  async function ensurePresence(): Promise<void> {
    if (!active || presence || autoRegistering) return;
    if (!sessionId || !cwdProjectId) return;
    autoRegistering = true;
    const generation = epoch;
    const candidate: Presence = {
      session_id: sessionId,
      project_id: cwdProjectId,
      harness: "pi",
      label: sessionLabel(repo.root, sessionCwd ?? process.cwd()),
    };
    try {
      const hello = await sayHello(candidate, { idle: false });
      if (generation !== epoch || !active || candidate.project_id !== cwdProjectId) return;
      autoAttempt = 0;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      if (presence) return;
      presence = candidate;
      setConnection("online");
      startHeartbeat();
      startEvents();
      applyHello(hello);
      await announceRound(hello.session);
      if (!active || generation !== epoch || presence !== candidate) return;
      // Sessão nova/recarregada: os pedidos que esta sessão já aceitou voltam do
      // servidor para restaurar o acompanhamento após /reload.
      await reconcileRequests(candidate, true);
      if (!active || generation !== epoch || presence !== candidate) return;
      void inbox.poll(candidate.session_id, now()).then(() => {
        if (active && presence === candidate) deliverNext();
      }).catch(messagingFailed);
    } catch (error) {
      if (generation !== epoch || !active) return;
      const delay = REGISTER_RETRY_MS[Math.min(autoAttempt++, REGISTER_RETRY_MS.length - 1)]!;
      warnOnce("presence", `${megamindName()} presence registration failed: ${safeMessage(error)}`);
      // Sem nova tentativa (sessão ociosa) o Megamind está fora até alguém voltar.
      setConnection(now() - lastActivity > IDLE_LIMIT_MS ? "offline" : "reconnecting");
      if (now() - lastActivity > IDLE_LIMIT_MS) return;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (generation !== epoch || now() - lastActivity > IDLE_LIMIT_MS) return;
        void ensurePresence();
      }, delay);
      retryTimer.unref?.();
    } finally {
      autoRegistering = false;
    }
  }

  /** SSE do device: só antecipa a leitura da inbox; o polling segue como garantia. */
  function startEvents() {
    if (events !== undefined || !active || !presence) return;
    if (process.env.ARCA_MEGAMIND_SSE === "0") return;
    let warned = false;
    events = openEvents(
      () => {
        lastActivity = now();
        pollSoon();
      },
      {
        onError: (error, failures, authError) => {
          if (warned || (!authError && failures < 3)) return;
          warned = true;
          notify?.(`${megamindName()} events stream offline (polling continua): ${safeMessage(error)}`, "warning");
        },
        onStable: () => {
          if (!warned) return;
          warned = false;
          notify?.(`${megamindName()} events stream online novamente`, "info");
        },
        // Cota de conexões do dispositivo (16 na v6): a leitura periódica
        // continua entregando tudo, então não há o que avisar ao usuário.
        onQuota: () => {
          eventsQuota = true;
        },
      },
    );
  }

  /**
   * Aviso de par. O forte vai como `steer`: entregue depois das tool calls
   * correntes e antes da próxima chamada ao LLM, sem `triggerTurn` (sessão
   * ociosa não acorda). O leve espera o próximo prompt do usuário.
   */
  function noticeToPeer(content: string, _line: string, strong = false) {
    try {
      // Só o agente recebe: na tela do Gabriel isso era ruído fixo acima do editor.
      // Quem está no projeto continua em megamind_who e no contador do rodapé.
      pi.sendMessage({ customType: PEER_TYPE, content, display: false }, { deliverAs: strong ? "steer" : "nextTurn" });
    } catch (error) {
      warnOnce("peer", `${megamindName()} peer notice failed: ${safeMessage(error)}`);
    }
  }

  /**
   * Uma rodada de avisos a partir do `who`: só sobreposição de arquivos com par
   * trabalhando, repetida quando a interseção muda. Estar no mesmo projeto não
   * avisa (ruído e tokens); quem está no projeto fica em megamind_who.
   */
  async function announceRound(session: unknown): Promise<void> {
    if (!active || !presence) return;
    const current = presence;
    const generation = epoch;
    let people: CorePerson[];
    try {
      people = await (await core()).who(current.project_id);
    } catch (error) {
      warnOnce("peer", `${megamindName()} who unavailable: ${safeMessage(error)}`);
      return;
    }
    if (!active || generation !== epoch || presence !== current) return;
    peerSessions = new Map();
    for (const person of people) {
      for (const peer of person.sessions) peerSessions.set(peer.session_id, { ...peer, owner: person.handle });
    }
    for (const overlap of parseOverlaps(session)) {
      if (isSelf(overlap.session_id) || overlapsSeen.get(overlap.session_id) === overlapFingerprint(overlap)) continue;
      const known = peerSessions.get(overlap.session_id);
      // Sessão que o `who` não mostra já saiu (ou ainda nem entrou): avisar dela é ruído.
      // Mesma máquina: o Peers já cobre, e o dono abre várias janelas no mesmo projeto.
      if (!known || known.status !== "working" || known.same_device) continue;
      overlapsSeen.set(overlap.session_id, overlapFingerprint(overlap));
      announced.add(overlap.session_id);
      // Nada vindo do servidor entra cru no contexto: label/owner/branch/paths são
      // de outro agente e passam pelo mesmo crivo do cabeçalho da inbox.
      const who = safeInline(overlap.label) || "agente";
      const owner = safeInline(overlap.owner_name);
      const branch = safeInline(overlap.branch);
      const paths = overlap.paths.map((path) => safeInline(path, LIMITS.pathChars)).filter(Boolean).join(", ");
      const line = `${who}${owner ? ` (${owner})` : ""}: ${paths}`;
      noticeToPeer(overlapNotice({ who, owner, branch, paths, sameBranch: overlap.same_branch, hint: hintFor(overlap.session_id) }), line, true);
    }
  }

  /**
   * Esta mesma sessão. Registro antigo com o mesmo nome no mesmo dispositivo é
   * ela também: a sessão foi retomada e o servidor ainda mostra a anterior —
   * avisar seria avisar de si mesmo.
   */
  function isSelf(session_id: string): boolean {
    const current = presence;
    if (!current) return false;
    if (session_id === current.session_id) return true;
    const peer = peerSessions.get(session_id);
    return peer?.same_device === true && peer.label === current.label;
  }

  /** Interseção anunciada: a mesma lista de caminhos não vira aviso duas vezes. */
  function overlapFingerprint(overlap: Overlap): string {
    return [...overlap.paths].sort().join("|");
  }

  /** Frase de coordenação: peers na mesma máquina, megamind fora dela. */
  function hintFor(session_id: string): string {
    const peer = peerSessions.get(session_id);
    return coordinateHint(safeInline(session_id), localityOf(peer), safeInline(peer?.harness));
  }

  function startResolving(cwd: string) {
    void refreshProject(cwd);
    if (resolveTimer !== undefined) return;
    resolveTimer = setInterval(() => {
      if (!active || now() - lastActivity > IDLE_LIMIT_MS) return;
      void refreshProject(cwd);
    }, RESOLVE_MS);
    resolveTimer.unref?.();
  }

  function activate(ctx: ExtensionContext) {
    const first = !active;
    isIdle = () => ctx.isIdle();
    priorityContext = ctx;
    sessionCwd = ctx.cwd;
    // Id real da sessão do Pi (docs/session-format.md): nada de id inventado.
    sessionId = ctx.sessionManager?.getSessionId?.();
    registerTools();
    active = true;
    if (ctx.hasUI) notify = (message, level) => ctx.ui.notify(message, level);
    // Ativação não vira mensagem: o estado mora no ícone da barra de status, e
    // ele só aparece depois que o cwd resolve para um projeto (refreshProject).
    if (cwdProjectId) setConnection("connecting");
    if (first) startResolving(ctx.cwd);
  }

  async function tick() {
    if (!active || !presence) return;
    const generation = epoch;
    const current = presence;
    // Presença expira com a ociosidade: parar de registrar (e espaçar a inbox)
    // é o que deixa o Mainframe marcar esta sessão como stale.
    const idleFor = now() - lastActivity;
    if (idleFor <= IDLE_LIMIT_MS) {
      lastIdleHelloAt = 0;
      try {
        const hello = await sayHello(current, { idle: false });
        if (!active || generation !== epoch || presence !== current) return;
        setConnection("online");
        applyHello(hello);
        await announceRound(hello.session);
      } catch (error) {
        warnOnce("presence", `${megamindName()} presence heartbeat failed: ${safeMessage(error)}`);
        setConnection("reconnecting");
      }
    } else if (idleFieldSupported && now() - lastIdleHelloAt >= IDLE_REGISTER_MS) {
      // Sessão aberta e parada: ela continua existindo para os sócios, marcada
      // como ociosa. Nada de aviso de par nem de prioridade enquanto ninguém está.
      lastIdleHelloAt = now();
      try {
        const hello = await sayHello(current, { idle: true });
        if (!active || generation !== epoch || presence !== current) return;
        rememberDeviceLabel(text(resultRecord(hello.session)?.device_label));
      } catch (error) {
        warnOnce("presence", `${megamindName()} idle presence failed: ${safeMessage(error)}`);
      }
    }
    if (!active || generation !== epoch || presence !== current) return;
    // O atendente não recebe `request_update`: quem diz se o pedido segue em
    // atendimento é o servidor.
    await reconcileRequests(current);
    if (!active || generation !== epoch || presence !== current) return;
    if (idleFor > IDLE_LIMIT_MS && now() - inbox.lastPollAt < IDLE_POLL_MS) return;
    await inbox.poll(current.session_id, now());
    if (active && generation === epoch && presence === current) deliverNext();
  }

  function startHeartbeat() {
    if (heartbeat !== undefined || !presence) return;
    heartbeat = setInterval(() => {
      void tick().catch(messagingFailed);
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  }

  /** `bye`: o que ficou desta sessão, e ela sai do who. Best-effort. */
  async function sayBye(summary: string): Promise<void> {
    if (!presence) return;
    // Um deadline só para git + chamada: o shutdown não pode esperar 3×3 s.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BYE_TIMEOUT_MS);
    timer.unref?.();
    const { branch, paths } = await repoSnapshot(repo.root, controller.signal);
    try {
      await (await core(controller.signal)).bye(presence.session_id, {
        summary: outgoing(summary, LIMITS.body) || "sessão encerrada sem resumo",
        ...(branch ? { branch } : {}),
        paths,
      }, controller.signal);
    } catch {
      // best-effort: a skill instrui `megamind_reply done` antes de encerrar
    } finally {
      clearTimeout(timer);
    }
  }

  /** Carrega o módulo de render uma vez; sem ele, renderização padrão do Pi. */
  async function loadRender(): Promise<void> {
    if (renderModule !== undefined || renderFailed) return;
    try {
      renderModule = await import("./render.ts");
    } catch {
      // Sem `pi-tui` (fora do runtime do Pi) não há como medir colunas: os
      // cards padrão do Pi assumem a tela.
      renderFailed = true;
      return;
    }
    registerMessageRenderers(renderModule);
  }

  /**
   * Mensagem de par na tela: cabeçalho com origem, corpo com barra lateral e a
   * orientação de resposta só no ctrl+o. O texto entregue ao modelo é o mesmo
   * de sempre; bloco que não casar com o formato cai no render padrão do Pi.
   */
  function registerMessageRenderers(render: RenderModule): void {
    if (messageRenderers || !render.compactToolsEnabled()) return;
    messageRenderers = true;
    const renderPeerMessage = (message: { content?: unknown }, options: { expanded: boolean }, theme: unknown) => {
      const parsed = render.parseInboxMessage(typeof message.content === "string" ? message.content : "");
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: o Theme do Pi expõe fg/bold, que é o que o componente usa.
      return parsed ? render.messageComponent(theme as { fg(color: string, text: string): string; bold(text: string): string }, parsed, options.expanded) : undefined;
    };
    for (const type of [MESSAGE_TYPE, PEER_TYPE]) {
      pi.registerMessageRenderer(type, renderPeerMessage as never);
    }
  }

  function registerTools() {
    if (registered) return;
    registered = true;
    registerMegamindTools(pi, {
      render: renderModule,
      now,
      presence: () => presence,
      core,
      readInbox,
      openRequests,
      reconcileRequests: (current) => reconcileRequests(current),
      selfHandle: () => selfHandle,
      megamindLabel: () => inboxLabel(),
      disabled: () => megamindDisabled(),
    });
  }

  pi.on("tool_call", async () => {
    lastActivity = now();
  });

  // docs/extensions.md "Tool Events > tool_result": roda depois da execução da
  // tool e expõe `event.details`, onde vem o marcador de erro do gateway.
  pi.on("tool_result", async (event) => {
    lastActivity = now();
    if (!event.toolName.startsWith(TOOL_PREFIX)) return;
    const details = object(event.details) ? event.details : undefined;
    if (details?.[ERROR_DETAIL] !== true) return;
    const { [ERROR_DETAIL]: _marker, ...rest } = details;
    return { content: event.content, details: rest, isError: true };
  });

  // Um turno gerado por follow-up (mensagem de agente par) também é atividade.
  pi.on("agent_start", async () => {
    lastActivity = now();
    // cwd sem vínculo não pode custar catálogo + git a cada turno: só re-tenta
    // depois de falha transitória ou quando a rodada periódica já venceu.
    const stale = !lastResolveOk || now() - lastResolveAt >= RESOLVE_MS;
    if (active && !presence && sessionCwd && stale && retryTimer === undefined && bootstrapTimer === undefined) {
      void refreshProject(sessionCwd);
    }
  });

  pi.on("input", async (event) => {
    lastActivity = now();
    // Nota automática (emenda 3): primeira linha do último prompt do usuário.
    // Mensagem injetada por extensão (entrega de inbox) não é prompt do usuário.
    if (event.source === "extension") return;
    const raw = text(event.text) ?? "";
    if (raw.trim()) lastPrompt = raw.trim();
  });

  // Auto-ativação: config presente e credencial legível bastam.
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.ARCA_MEGAMIND_AUTO === "0" || process.env.ARCA_PROJECTS_AUTO === "0" || active) return;
    // Projeto sem Megamind: nada de presença, caixa, eventos, item na barra nem
    // aviso de credencial — só as tools, que recusam. A sessão inteira fica off.
    if (megamindDisabled()) {
      registerTools();
      return;
    }
    try {
      const config = await metadata();
      const bearer = await token(config.tokenFile);
      const company = companyOf(megamindProfile().id);
      if (!sshTask && company) {
        // Não aguarda rede/keygen no session_start. Só /megamind espera pelo diagnóstico.
        sshTask = provisionSsh({ company: company.id, endpoint: config.endpoint, bearer }).then((result) => {
          if (result.reason && !result.silent) pi.appendEntry("megamind-ssh", { message: result.line });
          return result;
        });
      }
    } catch {
      // Sem enrollment: o aviso de setup sai uma vez por computador.
      await setupHintOnce(ctx);
      return;
    }
    if (ctx.hasUI) await loadRender();
    activate(ctx);
  });

  function confirmInboxInsertion(ctx: ExtensionContext | undefined): boolean {
    if (!active || !presence || !ctx || ctx.sessionManager.getSessionId() !== presence.session_id || !inbox.pending) return false;
    // `message_end` é emitido antes do append; consulte o histórico da sessão.
    const markers = new Set<string>();
    for (const entry of ctx.sessionManager.getBranch?.() ?? []) {
      if (entry.type !== "custom_message" || entry.customType !== MESSAGE_TYPE || !object(entry.details)) continue;
      const marker = text(entry.details.inboxInsertion);
      if (marker) markers.add(marker);
    }
    return inbox.confirmInserted(presence.session_id, markers);
  }

  pi.on("turn_end", (_event, ctx) => {
    if (confirmInboxInsertion(ctx)) pollSoon();
  });

  // Tick imediato ao ficar ocioso: a entrega pendente (e uma leitura nova, no
  // máximo a cada 5 s) acontece assim que dá.
  pi.on("agent_settled", async (_event, ctx) => {
    confirmInboxInsertion(ctx);
    if (!active || !presence || isIdle?.() !== true) return;
    deliverNext();
    // A leitura roda solta: aguardar aqui travaria o harness até o timeout do gateway.
    pollSoon();
  });

  pi.on("session_shutdown", async (event) => {
    // `bye` best-effort antes de soltar o estado (emenda 7). `/reload`, `/new`,
    // `/resume` e `/fork` não são fim de trabalho: só encerram a sessão no
    // servidor se sobrou pedido de colega em atendimento.
    const reason = text(object(event) ? event.reason : undefined);
    const closing = reason === undefined || reason === "quit" || openRequests.size > 0;
    const sendBye = active && presence && closing;
    active = false;
    epoch += 1;
    stopTimers();
    if (sendBye) {
      const summary = [
        currentNote() || "sessão encerrada",
        openRequests.size > 0 ? `pedidos em aberto: ${[...openRequests.keys()].join(", ")}` : "",
      ].filter(Boolean).join(" · ");
      await sayBye(summary);
    }
    openRequests.clear();
    freshSession();
  });

  /** Aviso de enrollment: um por computador, marcado no cache local. */
  async function setupHintOnce(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;
    const marker = setupHintFile();
    try {
      await stat(marker);
      return; // já avisado nesta máquina
    } catch {
      // segue e avisa
    }
    try {
      await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
      await writeFile(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
    } catch {
      // marcador é otimização; sem ele o aviso volta na próxima sessão
    }
    const profile = megamindProfile();
    const setup = companyOf(profile.id)?.setup;
    ctx.ui.notify(
      `${megamindName(profile)}: este computador ainda não foi autorizado. Rode o setup uma vez${setup ? ` (${setup})` : ""} e um sócio aprova o código no mainframe.`,
      "info",
    );
  }

  // Diagnóstico local: estado em memória, credencial no disco e pares já vistos.
  pi.registerCommand("megamind", {
    description: `Estado do ${megamindName()} nesta sessão (presença, conexão, pedidos e pares conhecidos)`,
    handler: async (_args, ctx) => {
      if (megamindDisabled()) {
        if (ctx.hasUI) ctx.ui.notify(MEGAMIND_OFF, "info");
        return;
      }
      const profile = megamindProfile();
      let credential = "ausente";
      let host = "endpoint desconhecido";
      try {
        const config = await metadata();
        try {
          host = new URL(config.endpoint).hostname;
        } catch {
          // endpoint ilegal já aparece como erro de conexão; aqui só o host falta
        }
        await token(config.tokenFile);
        credential = `ok (${configPath()})`;
      } catch (error) {
        credential = `ausente/inválida: ${safeMessage(error)}`;
      }
      // Primeira linha: de qual empresa é o Megamind desta sessão e contra qual
      // servidor — com duas empresas, era a pergunta que faltava.
      const lines: string[] = [`- Megamind: ${profile.label ?? "desconhecido"} (${host})`];
      lines.push(`- extensão: carregada, ${active ? "ativa nesta sessão" : "inativa (sem enrollment ou ARCA_MEGAMIND_AUTO=0)"}`);
      lines.push(`- credencial local: ${credential}`);
      const ssh = sshTask ? await sshTask : undefined;
      lines.push(`- ${ssh?.line ?? "ssh: indisponível (sem ativação com enrollment de empresa válido)"}`);
      lines.push(
        gatewayStatus.lastOkAt > 0
          ? `- conexão: comprovada (última resposta ok em ${new Date(gatewayStatus.lastOkAt).toISOString()})`
          : "- conexão: não comprovada nesta sessão (credencial local não prova acesso)",
      );
      lines.push(`- núcleo do servidor: ${coreVersion === undefined ? "ainda não consultado" : coreVersion >= CORE_V6 ? `v${coreVersion}` : `v${coreVersion} (servidor antigo: as seis chamadas vão traduzidas)`}`);
      lines.push(
        currentPriority
          ? `- prioridade do projeto: ${safeInline(currentPriority.title, 60)} (${currentPriority.done}/${currentPriority.total})`
          : "- prioridade do projeto: nenhuma publicada pelo Mainframe",
      );
      lines.push(`- eventos (SSE): ${eventsQuota ? "desligado (cota de conexões do dispositivo; só polling)" : events ? "stream aberto ou reconectando" : "desligado (só polling)"}`);
      lines.push(
        repo.repo_key
          ? `- repo do cwd: ${repo.repo_key}${repo.project_id ? ` → projeto ${repo.project_id}` : " (não declarado em nenhum projeto do catálogo)"}`
          : "- repo do cwd: nenhum clone git com remote origin reconhecido",
      );
      lines.push(
        presence
          ? `- sessão registrada: ${presence.label} (${shortId(presence.session_id)}…, projeto ${presence.project_id}${currentNote() ? `, nota "${currentNote()}"` : ""})`
          : `- sessão registrada: não${sessionId ? "" : " (sem id de sessão do Pi)"}`,
      );
      lines.push(
        openRequests.size > 0
          ? `- pedidos em atendimento: ${[...openRequests.entries()].map(([id, title]) => `${id}${title ? ` (${title})` : ""}`).join(", ")}`
          : "- pedidos em atendimento: nenhum",
      );
      lines.push(
        announced.size > 0
          ? `- pares conhecidos: ${[...announced].map((id) => shortId(id)).join(", ")}`
          : "- pares conhecidos: nenhum anunciado nesta sessão",
      );
      const failure = gatewayStatus.lastError && gatewayStatus.lastErrorAt >= gatewayStatus.lastOkAt ? gatewayStatus.lastError : undefined;
      if (failure) lines.push(`- último erro: ${failure}`);
      if (credential.startsWith("ausente")) {
        lines.push("- setup: INSTALAR.md seção 6, uma vez por computador");
      }
      if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
      else pi.sendMessage({ customType: "megamind-diagnostic", content: lines.join("\n"), display: true }, { triggerTurn: false });
    },
  });
}
