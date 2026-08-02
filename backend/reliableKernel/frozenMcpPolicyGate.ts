import type { ContentAddressedStore } from './contentAddressedStore';
import { readFrozenTurnAuthority } from './frozenAuthority';
import type { McpAuthorizationRequest, McpExistingPolicyGate } from './mcpEffects';
import type { PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';

/** Evaluates MCP authorization only from the ToolCall's frozen Turn authority and durable plan facts. */
export class FrozenAuthorityMcpPolicyGate implements McpExistingPolicyGate {
  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore
  ) {}

  public async authorize(request: McpAuthorizationRequest): Promise<{
    toolPolicyAllowed: boolean;
    planReviewAllowed: boolean;
    reason?: string;
  }> {
    const toolCall = await this.requireExisting('ToolCall', request.toolCallId);
    const turnId = requireId(toolCall.turn_id, 'ToolCall.turn_id');
    const snapshots = await this.list('AuthoritySnapshot', { turn_id: turnId }, 2);
    if (snapshots.length !== 1) throw new Error(`Turn ${turnId} must have exactly one AuthoritySnapshot.`);
    const frozen = await readFrozenTurnAuthority(
      this.database,
      this.contentStore,
      requireId(snapshots[0].id, 'AuthoritySnapshot.id'),
      turnId
    );
    const authority = requireRecord(frozen.document, 'AuthoritySnapshot');
    const toolPolicy = requireRecord(authority.toolPolicy, 'AuthoritySnapshot.toolPolicy');
    const allowed = Array.isArray(toolPolicy.allowedTools)
      && toolPolicy.allowedTools.some((name) => name === toolCall.tool_name);
    if (!allowed) {
      return {
        toolPolicyAllowed: false,
        planReviewAllowed: false,
        reason: `冻结 ToolPolicy 不允许 MCP 工具 ${String(toolCall.tool_name)}。`
      };
    }

    const planPolicy = requireRecord(authority.planReviewPolicy, 'AuthoritySnapshot.planReviewPolicy');
    const mode = planPolicy.mode === 'before_mutation' ? 'before_mutation' : 'off';
    if (mode === 'off') return { toolPolicyAllowed: true, planReviewAllowed: true };
    if (request.riskLevel === 'read' && planPolicy.allowReadonlyBeforeApproval === true) {
      return { toolPolicyAllowed: true, planReviewAllowed: true };
    }
    const required = Array.isArray(planPolicy.requireForToolRiskLevels)
      ? planPolicy.requireForToolRiskLevels
      : [];
    const requiredRisk = request.riskLevel === 'write' ? 'write' : request.riskLevel === 'command' ? 'command' : null;
    if (!requiredRisk || !required.includes(requiredRisk)) {
      return { toolPolicyAllowed: true, planReviewAllowed: true };
    }
    const approved = await this.hasApprovedPlan(turnId, requireBigInt(toolCall.call_seq, 'ToolCall.call_seq'));
    return approved
      ? { toolPolicyAllowed: true, planReviewAllowed: true }
      : {
          toolPolicyAllowed: true,
          planReviewAllowed: false,
          reason: '冻结 PlanReviewPolicy 要求先提交并批准 Plan。'
        };
  }

  private async hasApprovedPlan(turnId: string, beforeCallSeq: bigint): Promise<boolean> {
    const calls = (await this.list('ToolCall', { turn_id: turnId }, 1000))
      .filter((call) => call.tool_name === 'submit_plan' && requireBigInt(call.call_seq, 'ToolCall.call_seq') < beforeCallSeq);
    for (const call of calls) {
      const outcomes = await this.list('ToolOutcome', { tool_call_id: call.id }, 2);
      if (outcomes.length === 1 && outcomes[0].outcome === 'succeeded') return true;
    }
    return false;
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    if (!row || Array.isArray(row)) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    const rows = snapshot.snapshot[0];
    if (!Array.isArray(rows)) throw new TypeError(`${domain} list did not return rows.`);
    return rows;
  }
}

function requireRecord(value: PlainJsonValue | undefined, label: string): { [key: string]: PlainJsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError(`${label} must remain a non-negative bigint.`);
  return value;
}
