/** Legacy session-entry type; not an execution admission policy. */
export type JuiceMode = 'simple' | 'complex';
export interface AgentPreferences { supportModel: string | null }
export interface AgentClient {
  runtimeEnabled(): boolean;
  isChild(): boolean;
  subagentsEnabled(ctx?: { sessionManager: object }): boolean;
  setSessionSubagents(ctx: { sessionManager: object }, enabled: boolean): void;
  getAgentPreferences(): AgentPreferences;
  setAgentPreferences(patch: Partial<AgentPreferences>): AgentPreferences;
}
