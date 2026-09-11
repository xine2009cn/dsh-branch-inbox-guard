/**
 * dsh-branch-inbox-guard — a fork child must not inherit its parent's
 * undelivered inbox prompts.
 *
 * 背景（详见修复记录 README §7）：0.1.1-rc.2 的 `Inbox` 用
 * `session.events.slice(header.seedLength)` 重建队列，**跳过 fork 继承前缀**；
 * 0.1.5 把 inbox 改成 `dsh-agent-loop` 的 session 投影后折叠**全量日志**，
 * 于是种子里的 `agent/inbox/spliced`（父会话未投递的提问）变成子会话的待执行队列，
 * 分支里新输入的问题被排到它们后面 —— 表现为"分支跑的是主干分支点后的下一个问题"。
 *
 * 本插件在不改核心包的前提下恢复旧规则：每次 agent 创建时，只删除那些
 * **插入位置落在本会话继承切点之前**的待执行项：
 *
 *   * 刚 fork 出来的子会话 → 继承项被清空（等价于旧版行为）；
 *   * 已经被污染、之后又排了自有消息的会话 → 只清继承项，**保留会话自己排的队**；
 *   * 普通新会话 / 未 seed 的会话 → 完全不动；
 *   * 删除是持久化的（追加 `agent/inbox/spliced` 取消事件），重启后依然干净。
 *
 * 与核心补丁（fork 后 `inbox.clear()`）相比：覆盖所有 seeded 创建路径
 * （普通分支 + fork 型 subagent），并且能顺带治好历史遗留的脏队列。
 *
 * @module dsh-branch-inbox-guard
 */

/** Cordis plugin name used by the loader row. */
export const name = 'branch-inbox-guard';

/**
 * Map every pending message id to the seq of the `agent/inbox/spliced` event that
 * inserted it — the durable origin of a queue item.
 * @param events - the session's full event log in seq order.
 * @returns message id -> insertion seq.
 */
function insertionSeqs(events) {
  const origin = new Map();
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue;
    for (const message of event.data?.inserted ?? []) {
      if (message?.id !== undefined) origin.set(message.id, event.seq);
    }
  }
  return origin;
}

/**
 * The session's own fork cut: the exact number of events inherited from its fork
 * parent (`0` for an unseeded session, where nothing can be inherited).
 * @param session - the agent's session.
 * @returns the inherited event count, or 0.
 */
function inheritedCut(session) {
  const count = session?.inheritedEventCount;
  return typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? count : 0;
}

/**
 * Remove the pending items that came from the fork parent.
 * @param ctx - owning cordis context (for logging).
 * @param agent - the just-created agent.
 * @param verbose - log even when nothing had to be dropped.
 * @returns the number of dropped items.
 */
function dropInheritedPending(ctx, agent, verbose) {
  const session = agent?.session;
  const inbox = agent?.inbox;
  if (session === undefined || session === null || inbox === undefined || inbox === null) return 0;
  const cut = inheritedCut(session);
  if (cut === 0) return 0; // unseeded session: nothing inherited
  const pending = [...(inbox.nextTurn ?? []), ...(inbox.nextStep ?? [])];
  if (pending.length === 0) return 0;
  const origin = insertionSeqs(session.snapshotEvents());
  const inherited = pending.filter((message) => {
    const at = origin.get(message.id);
    return at !== undefined && at < cut; // spliced INSIDE the inherited prefix
  });
  if (inherited.length === 0) {
    if (verbose) ctx.logger?.info?.(`[branch-inbox-guard] session ${session.id}: no inherited prompt pending (cut=${cut})`);
    return 0;
  }
  if (inherited.length === pending.length) {
    inbox.clear(); // single durable cancel for the pure-fork-child case
  } else {
    for (const message of inherited) inbox.remove(message.id); // keep the session's own queue
  }
  ctx.logger?.info?.(
    `[branch-inbox-guard] session ${session.id}: dropped ${inherited.length} inherited prompt(s) from its fork parent` +
    `${inherited.length === pending.length ? '' : ` (kept ${pending.length - inherited.length} own item(s))`}`
  );
  return inherited.length;
}

/**
 * Mount the guard.
 * @param ctx - profile host context.
 * @param config - optional `{ verbose: boolean }`.
 */
export function apply(ctx, config) {
  const verbose = config?.verbose === true;
  ctx.on('agent/created', ({ agent }) => {
    try {
      dropInheritedPending(ctx, agent, verbose);
    } catch (error) {
      ctx.logger?.warn?.(`[branch-inbox-guard] guard failed for agent "${agent?.id ?? '?'}": ${String(error)}`);
    }
  });
}

/** Exported for the offline test; not part of the plugin surface. */
export const internals = { insertionSeqs, inheritedCut, dropInheritedPending };
