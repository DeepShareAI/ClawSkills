export interface ToolParameter {
    type: string;
    description?: string;
    enum?: string[];
}
export interface ToolParameters {
    type: "object";
    properties: Record<string, ToolParameter>;
    required?: string[];
}
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: ToolParameters;
}
export interface SkillJson {
    tools: Record<string, ToolDefinition>;
}
export declare const tools: Record<string, ToolDefinition>;
//# sourceMappingURL=skill-types.d.ts.map