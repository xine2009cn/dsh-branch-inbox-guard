// guard.test.mjs — self-contained unit test for dsh-branch-inbox-guard.
//
// No dependencies and no real session data: the guard only touches
// `session.inheritedEventCount`, `session.snapshotEvents()` and the four inbox
// methods (`nextTurn`/`nextStep`/`clear`/`remove`), so fakes are enough to pin
// the rule:
//
//   * a pending item whose inserting `agent/inbox/spliced` event lies INSIDE the
//     inherited prefix (seq < inheritedEventCount) belongs to the fork parent
//     and is dropped;
//   * a pending item inserted by the session's own events is kept;
//   * an unseeded session (cut = 0) is never touched;
//   * running the guard again appends nothing.
//
// Run: node test/guard.test.mjs
import { apply, internals } from '../index.js';

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) console.log(`       actual:   ${JSON.stringify(actual)}\n       expected: ${JSON.stringify(expected)}`);
}

/** Minimal session face: only what the guard reads. */
function fakeSession(events, inheritedEventCount, id = 'session-fake') {
  return { id, inheritedEventCount, snapshotEvents: () => events };
}

/** Minimal inbox face: real splice bookkeeping, `clear`/`remove` recorded. */
function fakeInbox(pending) {
  const state = { 'next-turn': [...pending.filter(m => m.target !== 'next-step')], 'next-step': [...pending.filter(m => m.target === 'next-step')] };
  const calls = [];
  const spliceEvents = [];
  return {
    calls,
    spliceEvents,
    get nextTurn() { return state['next-turn']; },
    get nextStep() { return state['next-step']; },
    clear() {
      calls.push(['clear']);
      const removed = state['next-turn'].length + state['next-step'].length;
      state['next-turn'] = [];
      state['next-step'] = [];
      if (removed > 0) spliceEvents.push({ removedCount: removed, outcome: 'canceled' });
    },
    remove(id) {
      for (const target of ['next-step', 'next-turn']) {
        const index = state[target].findIndex(m => m.id === id);
        if (index < 0) continue;
        state[target].splice(index, 1);
        calls.push(['remove', id]);
        spliceEvents.push({ target, removedCount: 1, outcome: 'canceled' });
        return true;
      }
      return false;
    }
  };
}

/** Mount the plugin against a fake ctx and return the captured agent/created handler. */
function mount() {
  let handler;
  const logs = [];
  apply({ on: (event, fn) => { if (event === 'agent/created') handler = fn; }, logger: { info: (l) => logs.push(String(l)), warn: (l) => logs.push(`WARN ${l}`) } }, {});
  if (typeof handler !== 'function') throw new Error('plugin did not register an agent/created listener');
  return { handler, logs };
}

/** Session log: two inherited inserts (seq 0,1), the inherited marker (seq 2 = cut), one own insert (seq 3). */
const inheritedA = { id: 'msg-inherited-a' };
const inheritedB = { id: 'msg-inherited-b' };
const inheritedStep = { id: 'msg-inherited-step' };
const own = { id: 'msg-own' };
const log = [
  { type: 'agent/inbox/spliced', seq: 0, data: { target: 'next-turn', start: 0, inserted: [inheritedA] } },
  { type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, inserted: [inheritedB, inheritedStep] } },
  { type: 'session/end-seed', seq: 2, data: { inherited: true } },
  { type: 'agent/inbox/spliced', seq: 3, data: { target: 'next-turn', start: 0, inserted: [own] } }
];
const CUT = 3; // events 0..2 are the fork parent's

console.log('dsh-branch-inbox-guard unit tests\n');

console.log('[1] mixed queue: inherited dropped, own kept');
{
  const { handler, logs } = mount();
  const inbox = fakeInbox([inheritedA, inheritedB, own]);
  handler({ agent: { id: 'a', session: fakeSession(log, CUT), inbox } });
  check('own prompt survives', inbox.nextTurn.map(m => m.id), [own.id]);
  check('the two inherited prompts were removed individually', inbox.calls.filter(c => c[0] === 'remove').map(c => c[1]), [inheritedA.id, inheritedB.id]);
  check('clear() was NOT used for a mixed queue', inbox.calls.some(c => c[0] === 'clear'), false);
  check('the drop is logged', logs.some(l => l.includes('dropped 2 inherited prompt(s)')), true);
}

console.log('\n[2] pure fork child: one durable clear()');
{
  const { handler } = mount();
  const inbox = fakeInbox([inheritedA, inheritedB]);
  handler({ agent: { id: 'a', session: fakeSession(log, CUT), inbox } });
  check('queue is empty', inbox.nextTurn.length + inbox.nextStep.length, 0);
  check('clear() used exactly once', inbox.calls.filter(c => c[0] === 'clear').length, 1);
  check('one cancel event written', inbox.spliceEvents, [{ removedCount: 2, outcome: 'canceled' }]);
}

console.log('\n[3] inherited steering input (next-step) is dropped too');
{
  const { handler } = mount();
  const inbox = fakeInbox([inheritedB, inheritedStep]);
  handler({ agent: { id: 'a', session: fakeSession(log, CUT), inbox } });
  check('next-step queue is empty', inbox.nextStep.length, 0);
  check('next-turn queue is empty', inbox.nextTurn.length, 0);
}

console.log('\n[4] unseeded session: untouched');
{
  const { handler } = mount();
  const inbox = fakeInbox([own]);
  handler({ agent: { id: 'a', session: fakeSession([log[3]], 0), inbox } });
  check('pending prompt survives', inbox.nextTurn.map(m => m.id), [own.id]);
  check('no calls', inbox.calls, []);
}

console.log('\n[5] nothing pending: no calls, no events');
{
  const { handler, logs } = mount();
  const inbox = fakeInbox([]);
  handler({ agent: { id: 'a', session: fakeSession(log, CUT), inbox } });
  check('no calls', inbox.calls, []);
  check('no events', inbox.spliceEvents, []);
  check('nothing logged', logs, []);
}

console.log('\n[6] idempotent');
{
  const { handler } = mount();
  const inbox = fakeInbox([inheritedA, own]);
  const agent = { id: 'a', session: fakeSession(log, CUT), inbox };
  handler({ agent });
  const after = JSON.stringify([inbox.calls, inbox.spliceEvents]);
  handler({ agent });
  check('second run changes nothing', JSON.stringify([inbox.calls, inbox.spliceEvents]), after);
}

console.log('\n[7] conservative: unknown-origin pending item is kept');
{
  const { handler } = mount();
  const stranger = { id: 'msg-not-in-log' };
  const inbox = fakeInbox([stranger, inheritedA]);
  handler({ agent: { id: 'a', session: fakeSession(log, CUT), inbox } });
  check('only the traceable inherited item was removed', inbox.nextTurn.map(m => m.id), [stranger.id]);
}

console.log('\n[8] helper sanity');
{
  check('insertion map points at the inserting seq', internals.insertionSeqs(log).get(inheritedA.id), 0);
  check('cut of an unseeded session is 0', internals.inheritedCut(fakeSession(log, 0)), 0);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — dsh-branch-inbox-guard`);
process.exitCode = failures === 0 ? 0 : 1;
