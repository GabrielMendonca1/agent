import { createCodemodeExtension, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { codemodeModeFor } from '../../juice/codemode-policy.mjs';

export default function (pi: ExtensionAPI) {
  let model: ExtensionContext['model'];
  let mode = codemodeModeFor(model);
  // Relies on Pi 1.4.0 reading options.mode lazily on each loadout.
  // Keep interactive tools declared without removing their script-callable exposure.
  // subagent: its schema exceeds the codemode inline budget, so hiding it left the model without it.
  const alwaysDeclared = new Set(['ask_user', 'plan', 'subagent']);
  const codemodePi = new Proxy(pi, {
    get(target, property, receiver) {
      if (property !== 'registerTool') return Reflect.get(target, property, receiver);
      return ((tool) => {
        if (tool.name !== 'codemode' || !tool.prepareLoadout) return target.registerTool(tool);
        const prepareLoadout = tool.prepareLoadout;
        target.registerTool({
          ...tool,
          prepareLoadout(loadout) {
            const changes = prepareLoadout(loadout);
            if (!changes) return changes;
            // Hide a direct declaration only when the codemode catalog actually lists the tool;
            // the catalog drops sections over the inline budget without saying so.
            const catalog = changes.descriptions?.codemode ?? '';
            const listed = (name: string) => catalog.includes(`(\`${name}\`)`) || catalog.includes(`### \`${name}\`\n`);
            return {
              ...changes,
              hiddenDeclarations: changes.hiddenDeclarations?.filter(name => !alwaysDeclared.has(name) && listed(name)),
            };
          },
        });
      }) satisfies ExtensionAPI['registerTool'];
    },
  });
  createCodemodeExtension({ get mode() { return codemodeModeFor(model); } })(codemodePi);

  const select = (next: ExtensionContext['model']) => {
    model = next;
    const nextMode = codemodeModeFor(model);
    if (mode === nextMode) return;
    mode = nextMode;
    pi.setActiveTools(pi.getActiveTools());
  };
  pi.on('session_start', (_event, ctx) => { select(ctx.model); });
  pi.on('model_select', (event) => { select(event.model); });
}
