// The in-process `dispatch` MCP server: tracker tools for the agent, backed by server RPC.
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { RpcMethod } from '../shared/protocol.ts';
import type { SessionKind } from '../shared/types.ts';

export type Rpc = (method: RpcMethod, params: unknown) => Promise<unknown>;

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true });
const call = (rpc: Rpc, method: RpcMethod) => async (params: unknown) => {
  try {
    return ok(await rpc(method, params));
  } catch (e) {
    return fail(e);
  }
};

const itemShape = {
  type: z.enum(['backlog', 'bug']).describe('bug = defect, backlog = improvement or feature'),
  title: z.string().describe('Short title, max 200 chars'),
  body_md: z.string().describe('Markdown description with context'),
  importance: z.number().int().min(1).max(4).describe('1–4, see the project importance scale'),
  effort: z.number().int().min(0).nullable().describe('Index into the project effort scale, or null if unknown'),
};

export function dispatchMcp(kind: SessionKind, rpc: Rpc) {
  const tools: SdkMcpToolDefinition<any>[] = [
    tool('list_items', 'List open tracker items in this project (key, title, type, status, importance, effort).', {
      status: z.array(z.string()).optional().describe('Filter by status; default: all open statuses'),
      type: z.enum(['backlog', 'bug']).optional(),
    }, call(rpc, 'list_items')),
    tool('get_item', 'Read one item with its description, comments and source (retro/report).', {
      key: z.string().describe('Item key, e.g. HC-42'),
    }, call(rpc, 'get_item')),
    tool('add_comment', 'Add a comment to an item.', {
      key: z.string(),
      body: z.string(),
    }, call(rpc, 'add_comment')),
  ];
  if (kind === 'work') {
    tools.push(tool('create_item', 'File a new backlog item or bug you found that is outside this batch. It is linked to this session.', itemShape, call(rpc, 'create_item')));
  } else {
    tools.push(
      tool('propose_batch', 'Show the owner a proposed batch as a card they can edit and start. A batch = one session, one branch, one PR.', {
        title: z.string().describe('Short name for the batch'),
        item_ids: z.array(z.number().int()).describe('Numeric ids (from list_items) of existing items in the batch'),
        new_items: z.array(z.object(itemShape)).default([]).describe('New items to create as part of the batch'),
        prompt: z.string().describe('Extra instructions for the session that will do the work'),
        force_plan: z.boolean().default(false).describe('True if the work needs a written plan before code'),
      }, async (p) => call(rpc, 'propose')({ type: 'batch', ...p })),
      tool('propose_items', 'Show the owner a list of new items (e.g. split from a retro) as a card they can edit and create.', {
        source_id: z.number().int().nullable().describe('Source the items come from, if any'),
        items: z.array(z.object(itemShape)).min(1),
      }, async (p) => call(rpc, 'propose')({ type: 'items', ...p })),
    );
  }
  return createSdkMcpServer({ name: 'dispatch', version: '1.0.0', tools });
}
