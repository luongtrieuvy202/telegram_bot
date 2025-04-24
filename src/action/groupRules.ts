import {
    Action,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
    generateText,
    ModelClass,
    Validator,
    Handler,
    ActionExample
} from "@elizaos/core";
import {Context} from "telegraf";
import {Update} from "telegraf/types";

import redis from "../redis/redis.ts";
import {getGroupsByUserId} from "./utils.ts";

interface RuleCondition {
    type: 'contains' | 'not_contains' | 'starts_with' | 'ends_with' | 'matches_regex' | 'length_greater' | 'length_less';
    value: string | number;
    case_sensitive?: boolean;
}

interface GroupRule {
    id: string;
    groupId: string;
    name: string;
    description: string;
    conditions: RuleCondition[];
    action: 'warn' | 'mute' | 'ban' | 'kick';
    duration?: number; // Duration in minutes for temporary actions
    createdBy: string;
    createdAt: number;
}


interface ValidationResult {
    is_rule_management: boolean;
    action: 'create' | 'list' | 'delete' | 'update';
    confidence: number;
    group_name: string;
    rule_details?: {
        name: string;
        description: string;
        conditions: RuleCondition[];
        action: 'warn' | 'mute' | 'ban' | 'kick';
        duration?: number;
    };
}

interface Group {
    id: string;
    name: string;
    type: string;
}

// Helper function to extract JSON from text response
function extractJsonFromResponse(response: string): any {
    try {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        return null;
    } catch (error) {
        return null;
    }
}

async function handleRuleCreate(groupId: string, rule: GroupRule) {
    const ruleId = `rule:${Date.now()}`;

    // Transform conditions to match expected format
    const transformedConditions = rule.conditions.map(condition => {
        // Handle numeric values for length conditions
        if (condition.type === 'length_greater' || condition.type === 'length_less') {
            return {
                type: condition.type,
                value: Number(condition.value),
                case_sensitive: condition.case_sensitive || false
            };
        }

        // Handle string conditions
        return {
            type: condition.type,
            value: String(condition.value),
            case_sensitive: condition.case_sensitive || false
        };
    });

    // Ensure rule has required structure
    const validatedRule: GroupRule = {
        id: ruleId,
        groupId,
        name: rule.name,
        description: rule.description,
        conditions: transformedConditions,
        action: rule.action,
        duration: rule.duration,
        createdBy: rule.createdBy,
        createdAt: Date.now()
    };

    await redis.hset(`group:${groupId}:rules`, ruleId, JSON.stringify(validatedRule));
    return ruleId;
}

async function handleRuleList(groupId: string) {
    const rules = await redis.hgetall(`group:${groupId}:rules`);
    return Object.entries(rules).map(([id, rule]) => ({
        id,
        ...JSON.parse(rule as string)
    }));
}

async function handleRuleDelete(groupId: string, ruleId: string) {
    await redis.hdel(`group:${groupId}:rules`, ruleId);
}

async function handleRuleUpdate(groupId: string, ruleId: string, rule: GroupRule) {
    await redis.hset(`group:${groupId}:rules`, ruleId, JSON.stringify(rule));
}

export const groupRulesAction: Action = {
    name: 'GROUP_RULES',
    similes: ['group rules', 'rules', 'moderation', 'group settings'],
    description: 'Manage group rules and moderation settings',
    examples: [
        [{text: 'Create a rule to warn users who post links'}] as unknown as ActionExample[],
        [{text: 'List all rules in the group'}] as unknown as ActionExample[],
        [{text: 'Delete the no-spam rule'}] as unknown as ActionExample[],
        [{text: 'Update the greeting rule to be case sensitive'}] as unknown as ActionExample[]
    ] as ActionExample[][],
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
        if (!state.handle) return false

        return true
        // if (!message?.content?.text) return false;

        // const prompt = `Analyze the following message to determine if it's about managing group rules.
        // Consider if the user wants to:
        // - Create a new rule
        // - List existing rules
        // - Delete a rule
        // - Update a rule
        
        // Message: ${message.content.text}
        
        // Return a JSON object with:
        // {
        //     "is_rule_management": boolean,
        //     "action": "create" | "list" | "delete" | "update",
        //     "confidence": number,
        //     "group_name": string,
        //     "rule_details": {
        //         "name": string,
        //         "description": string,
        //         "conditions": [
        //             {
        //                 "type": "contains" | "not_contains" | "starts_with" | "ends_with" | "matches_regex" | "length_greater" | "length_less",
        //                 "value": string | number,
        //                 "case_sensitive": boolean
        //             }
        //         ],
        //         "action": "warn" | "mute" | "ban" | "kick",
        //         "duration": number
        //     }
        // }

        // For rule creation/update, ensure:
        // - At least one condition is provided
        // - Action is one of: warn, mute, ban, kick
        // - Duration is optional and in minutes
        // - Conditions have valid types and values
        // - For length conditions, value must be a number
        // - For regex conditions, value must be a valid regex pattern
        // - For other conditions, value must be a string`;

        // const response = await generateText({
        //     runtime,
        //     context: prompt,
        //     modelClass: ModelClass.SMALL
        // });

        // const result = extractJsonFromResponse(response) as ValidationResult;
        // if (!result || !result.is_rule_management || result.confidence < 0.7) {
        //     return false;
        // }

        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: any,
        callback?: HandlerCallback
    ): Promise<void> => {
        try {
            const ctx = options.ctx as Context<Update>;
            const groupId = ctx.chat.id.toString();
            const prompt = `Analyze the following message to determine the rule management action and details.
            Message: ${message.content.text}

            Return a JSON object with:
            {
                "is_rule_management": boolean,
                "action": "create" | "list" | "delete" | "update",
                "confidence": number,
                "group_name": string,
                "rule_details": {
                    "name": string,
                    "description": string,
                    "conditions": [
                        {
                            "type": "contains" | "not_contains" | "starts_with" | "ends_with" | "matches_regex" | "length_greater" | "length_less",
                            "value": string | number,
                            "case_sensitive": boolean
                        }
                    ],
                    "action": "warn" | "mute" | "ban" | "kick",
                    "duration": number
                }
            }

            For rule creation/update, ensure:
            - At least one condition is provided
            - Action is one of: warn, mute, ban, kick
            - Duration is optional and in minutes
            - Conditions have valid types and values
            - For length conditions, value must be a number
            - For regex conditions, value must be a valid regex pattern
            - For other conditions, value must be a string

            Examples of valid rules:
            1. {
                "name": "No Links",
                "description": "Prevent posting links in the group",
                "conditions": [
                    {
                        "type": "matches_regex",
                        "value": "https?://\\S+",
                        "case_sensitive": false
                    }
                ],
                "action": "warn"
            }
            2. {
                "name": "Message Length",
                "description": "Prevent very long messages",
                "conditions": [
                    {
                        "type": "length_greater",
                        "value": 500,
                        "case_sensitive": false
                    }
                ],
                "action": "mute",
                "duration": 30
            }
            3. {
                "name": "No Spam",
                "description": "Prevent repeated messages",
                "conditions": [
                    {
                        "type": "contains",
                        "value": "spam",
                        "case_sensitive": false
                    }
                ],
                "action": "ban",
                "duration": 60
            }`;

            const response = await generateText({
                runtime,
                context: prompt,
                modelClass: ModelClass.SMALL
            });

            await runtime.messageManager.createMemory({
                content: {
                    text: message.content.text
                },
                roomId: message.roomId,
                userId: message.userId,
                agentId: message.agentId
            });

            const result = extractJsonFromResponse(response) as ValidationResult;
            if (!result || !result.is_rule_management || result.confidence < 0.7) {
                callback({
                    text: "I couldn't understand your rule management request. Please try again.",
                    action: "GROUP_RULES"
                });
                return;
            }

            const [groupIds, groupInfos] = await getGroupsByUserId(ctx.from.id.toString());
            const targetGroup = groupInfos.find(group =>
                group.title?.toLowerCase() === result.group_name?.toLowerCase()
            );
            if (!targetGroup) {
                callback({
                    text: `Group "${result.group_name}" not found or you don't have access to it.`,
                    action: "GROUP_RULES"
                });
                return;
            }

            switch (result.action) {
                case 'create':
                    await handleRuleCreate(targetGroup.id, result.rule_details as GroupRule);
                    callback({
                        text: `Rule "${result.rule_details.name}" has been created successfully.`,
                        action: "GROUP_RULES"
                    });
                    break;
                case 'list':
                    const rules = await redis.hgetall(`group:${targetGroup.id}:rules`);
                    if (!rules || Object.keys(rules).length === 0) {
                        callback({
                            text: "No rules have been set for this group yet.",
                            action: "GROUP_RULES"
                        });
                        return;
                    }
                    const ruleList = Object.values(rules)
                        .map(rule => JSON.parse(rule as string))
                        .map(rule => `• ${rule.name}: ${rule.description}`)
                        .join('\n');
                    callback({
                        text: `📜 Group Rules:\n\n${ruleList}`,
                        action: "GROUP_RULES"
                    });
                    break;
                case 'delete':
                    await handleRuleDelete(targetGroup.id, result.rule_details?.name);
                    callback({
                        text: `Rule "${result.rule_details.name}" has been deleted successfully.`,
                        action: "GROUP_RULES"
                    });
                    break;
                case 'update':
                    await handleRuleUpdate(targetGroup.id, result.rule_details?.name, result.rule_details as GroupRule);
                    callback({
                        text: `Rule "${result.rule_details.name}" has been updated successfully.`,
                        action: "GROUP_RULES"
                    });
                    break;
                default:
                    callback({
                        text: "Invalid rule management action.",
                        action: "GROUP_RULES"
                    });
            }
        } catch (error) {
            console.error('Error in groupRulesAction handler:', error);
            callback({
                text: "Sorry, I encountered an error while processing your request.",
                action: "GROUP_RULES"
            });
        }
    }
}; 