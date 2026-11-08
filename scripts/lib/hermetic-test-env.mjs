// Testes rodam de dentro de um pi Mark II, que exporta NODE_OPTIONS=--import <runtime da release>
// e MARK_*/MARK_JUICE_*. Herdados, os filhos de um teste sobem o runtime de uma release instalada
// (às vezes velha) e o broker real: o teste passa a medir a sessão, não o repo. Importe primeiro.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('MARK_')) delete process.env[name];
}
if (/mark-ii|juice/i.test(process.env.NODE_OPTIONS ?? '')) delete process.env.NODE_OPTIONS;
// Nenhum teste instala Rust de verdade.
process.env.MARK_RUST_AUTO_INSTALL = '0';
// Nem abre o pi instalado para aquecer o cache de abertura.
process.env.MARK_WARM_START = '0';
