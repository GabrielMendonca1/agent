/** Legacy session-entry type; not an execution admission policy. */
export type JuiceMode = 'simple' | 'complex';
export interface AgentPreferences { supportModel: string | null }
export interface AgentClient {
  runtimeEnabled(): boolean;
  isChild(): boolean;
  getAgentPreferences(): AgentPreferences;
  setAgentPreferences(patch: Partial<AgentPreferences>): AgentPreferences;
}
