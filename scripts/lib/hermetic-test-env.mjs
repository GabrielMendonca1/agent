// Testes rodam de dentro de um pi Agent, que exporta NODE_OPTIONS=--import <runtime da release>
// e AGENT_*. Herdados, os filhos de um teste sobem o runtime de uma release instalada
// (às vezes velha) e o broker real: o teste passa a medir a sessão, não o repo. Importe primeiro.
// AGENT_STORE, AGENT_REPO e AGENT_STALE_NOTICE são do instalador (antes PI_OVERLAY_*) e ficam.
const installerEnv = new Set(['AGENT_STORE', 'AGENT_REPO', 'AGENT_STALE_NOTICE']);
for (const name of Object.keys(process.env)) {
  if (name.startsWith('AGENT_') && !installerEnv.has(name)) delete process.env[name];
}
if (/agent|juice/i.test(process.env.NODE_OPTIONS ?? '')) delete process.env.NODE_OPTIONS;
// Nenhum teste instala Rust de verdade.
process.env.AGENT_RUST_AUTO_INSTALL = '0';
// Nem abre o pi instalado para aquecer o cache de abertura.
process.env.AGENT_WARM_START = '0';
