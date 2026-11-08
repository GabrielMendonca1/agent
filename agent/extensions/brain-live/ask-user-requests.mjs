// Compartilhado com o Megamind no mesmo processo, inclusive após reload.
const key = Symbol.for("mark.askUser.requests");

export function registerAskUserRequest(id) {
	(globalThis[key] ??= new Set()).add(id);
}
