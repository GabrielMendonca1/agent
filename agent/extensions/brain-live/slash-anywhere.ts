import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  CombinedAutocompleteProvider,
  Editor,
} from "@earendil-works/pi-tui";

const PATCH = Symbol.for("garime.slash-anywhere");

type EditorState = { lines: string[]; cursorLine: number; cursorCol: number };
type LegacyEditor = Editor & {
  state: EditorState;
  isAtStartOfMessage(): boolean;
  isInSlashCommandContext(textBeforeCursor: string): boolean;
  handleSlashCommandCompletion(): void;
  handleTabCompletion(): void;
};
type LegacyEditorPrototype = {
  isAtStartOfMessage(this: LegacyEditor): boolean;
  isInSlashCommandContext(this: LegacyEditor, textBeforeCursor: string): boolean;
  handleTabCompletion(this: LegacyEditor): void;
};
type PatchRegistry = Record<symbol, boolean | undefined>;

type SlashContext = { prefix: string; commandName: string; argumentText: string | null; slashIndex: number };

function slashContext(text: string): SlashContext | null {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (text[index] !== "/") continue;
    const previous = text[index - 1];
    if (index !== 0 && previous !== " " && previous !== "\t") continue;
    const prefix = text.slice(index);
    if (prefix.slice(1).includes("/")) return null;
    const space = prefix.search(/[ \t]/);
    return space === -1
      ? { prefix, commandName: prefix.slice(1), argumentText: null, slashIndex: index }
      : { prefix, commandName: prefix.slice(1, space), argumentText: prefix.slice(space + 1), slashIndex: index };
  }
  return null;
}

async function nativeSupport(): Promise<boolean> {
  const provider = new CombinedAutocompleteProvider([{ name: "garime-probe" }], process.cwd());
  const text = "x /garime-pr";
  const result = await provider.getSuggestions([text], 0, text.length, {
    signal: new AbortController().signal,
    force: false,
  });
  return result?.items.some((item) => item.value === "garime-probe") ?? false;
}

function patchAutocompleteProvider(): void {
  const prototype = CombinedAutocompleteProvider.prototype;
  const originalGet = prototype.getSuggestions;
  const originalApply = prototype.applyCompletion;

  prototype.getSuggestions = async function (
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const currentLine = lines[cursorLine] ?? "";
    const beforeCursor = currentLine.slice(0, cursorCol);
    const context = slashContext(beforeCursor);
    if (!context || context.slashIndex === 0) {
      return originalGet.call(this, lines, cursorLine, cursorCol, options);
    }

    const syntheticLines = [...lines];
    syntheticLines[cursorLine] = context.prefix;
    const result = await originalGet.call(this, syntheticLines, cursorLine, context.prefix.length, {
      ...options,
      force: false,
    });
    if (!result || context.argumentText !== null) return result;
    return { ...result, prefix: context.commandName };
  };

  prototype.applyCompletion = function (
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ) {
    const currentLine = lines[cursorLine] ?? "";
    const slashIndex = cursorCol - prefix.length - 1;
    const previous = currentLine[slashIndex - 1];
    if (currentLine[slashIndex] === "/" && (slashIndex === 0 || previous === " " || previous === "\t")) {
      const next = [...lines];
      next[cursorLine] = `${currentLine.slice(0, slashIndex)}/${item.value} ${currentLine.slice(cursorCol)}`;
      return { lines: next, cursorLine, cursorCol: slashIndex + item.value.length + 2 };
    }
    return originalApply.call(this, lines, cursorLine, cursorCol, item, prefix);
  };
}

function patchEditor(): void {
  const prototype = Editor.prototype as unknown as LegacyEditorPrototype;
  const originalTab = prototype.handleTabCompletion;

  prototype.isAtStartOfMessage = function () {
    const line = this.state.lines[this.state.cursorLine] ?? "";
    return slashContext(line.slice(0, this.state.cursorCol))?.prefix === "/";
  };
  prototype.isInSlashCommandContext = function (textBeforeCursor: string) {
    return slashContext(textBeforeCursor) !== null;
  };
  prototype.handleTabCompletion = function () {
    const line = this.state.lines[this.state.cursorLine] ?? "";
    const context = slashContext(line.slice(0, this.state.cursorCol));
    if (context?.argumentText === null) {
      this.handleSlashCommandCompletion();
      return;
    }
    originalTab.call(this);
  };
}

export default async function slashAnywhere(_pi: ExtensionAPI) {
  const registry = globalThis as unknown as PatchRegistry;
  if (registry[PATCH] || (await nativeSupport())) return;
  registry[PATCH] = true;
  patchAutocompleteProvider();
  patchEditor();
}
