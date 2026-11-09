/* Agent office model: pure functions, no DOM, no network, no globals.
   OfficeModel.derive({control, states, now}) -> desks, helper subagents, message pairs, vault writes
   OfficeModel.parseQueue(md) -> the A100 queue items (columns found by header name)
   control.dismissed hides a desk until its session does something new (Dismiss on the page)
   OfficeModel.orderBy / moveKey / mergeOrder -> the viewer's own order of machines and sessions (Arrange)
   Loaded by office.html and, in tests, by a plain page under headless Chrome. */
(function (root) {
  "use strict";
  const MIN = 60e3, HR = 3600e3, DAY = 24 * HR;
  const GLOW = 60 * MIN, SUB_STALE = 6 * HR;
  const ms = (v) => typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v || "");
  const shortModel = (m) => String(m || "").replace(/^claude-/, "");
  const machinesOf = (control) => ((control && control.machines) || []).slice().sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  const plain = (s) => String(s == null ? "" : s).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`_]/g, "").replace(/\s+/g, " ").trim();

  // The queue tables under "## Queue". Each table's own header row decides its columns (found by name, never by position):
  // ID, State, Task / Task file, Added / Added by, Needs, Est. A100 h.
  function parseQueue(md) {
    const lines = String(md || "").split("\n"), i = lines.findIndex((l) => /^##\s+queue\s*$/i.test(l)), rest = i >= 0 ? lines.slice(i + 1) : lines;
    const end = rest.findIndex((l) => /^##\s/.test(l));
    const rows = (end >= 0 ? rest.slice(0, end) : rest).filter((l) => /^\s*\|/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    const items = [];
    let col = null;
    rows.forEach((r) => {
      const first = (r[0] || "").toLowerCase();
      if (/^id\b/.test(first) && !/\d/.test(first)) {  // a header row starts (or restarts) a table
        const head = r.map((c) => c.toLowerCase());
        const at = (...names) => head.findIndex((c) => names.some((n) => c.startsWith(n)));
        col = { id: Math.max(0, at("id")), state: at("state"), task: at("task"), added: at("added"), needs: at("needs"), est: at("est") };
        if (col.state < 0) col.state = 1;
        return;
      }
      if (!col || !/^[A-Za-z]+\d+/.test(r[col.id] || "")) return;
      const cell = (k) => (k >= 0 ? plain(r[k]) : "");
      const text = cell(col.state), m = text.match(/^([A-Za-z]+)/);
      items.push({ id: r[col.id], text, word: m ? m[1].toLowerCase() : "", added: cell(col.added), needs: cell(col.needs), task: cell(col.task), est: cell(col.est) });
    });
    return { items };
  }

  const subStart = (s) => (isNaN(s.start) ? s.begin : s.start);
  // done = has a stop event; a helper with no stop for over 6 h is shown as "no stop seen" rather than running forever
  const subState = (s, now) => (!isNaN(s.stop) ? "done" : now - subStart(s) > SUB_STALE ? "stale" : "running");

  // desks (one per Claude session), their helper subagents, message pairs, vault writes
  function derive({ control, states, now }) {
    states = states || {};
    const t = now, cut = t - DAY, desks = new Map(), evs = [], orphans = {}, cleared = (control && control.cleared) || {};
    const machines = () => machinesOf(control);
    const mk = (sid, mid) => {
      if (!desks.has(sid)) desks.set(sid, { sid, machine: mid, name: "", repo: "", lastTs: 0, jobs: [], ev: [], subs: [], by: {}, out: [], sent: 0, vault: 0, vaultLast: 0, ops: {}, traced: false });
      return desks.get(sid);
    };
    machines().forEach((m) => {  // sessions the machine's tracer saw, and their events (old state.json files have no agents key)
      const ag = states[m.id] && states[m.id].agents;
      if (!ag || typeof ag !== "object") return;
      Object.entries(ag.sessions || {}).forEach(([sid, s]) => {
        const d = mk(sid, m.id); d.machine = m.id; d.traced = true; d.name = (s && s.name) || ""; d.repo = (s && s.repo) || ""; d.lastTs = Math.max(d.lastTs, ms(s && s.last) || 0);
      });
      (Array.isArray(ag.events) ? ag.events : []).forEach((ev) => { if (ev && ev.session_id && ms(ev.ts) >= cut) { mk(ev.session_id, m.id).traced = true; evs.push(ev); } });
    });
    machines().forEach((m) => {  // sessions only known from a board job
      const st = states[m.id];
      Object.entries((st && st.jobs) || {}).forEach(([id, j]) => {
        if (cleared[id] && cleared[id].for === j.created) return;
        const job = Object.assign({}, j, { id, machine: m.id });
        if (!j.session_id) { (orphans[m.id] = orphans[m.id] || []).push(job); return; }
        const d = mk(j.session_id, m.id); d.repo = d.repo || j.repo || ""; d.jobs.push(job); d.lastTs = Math.max(d.lastTs, ms(j.updated) || 0);
      });
    });
    const named = {};  // Remote Control names the machines publish, for desks known only from a board job
    const addrs = {};  // sid -> the uds:/bridge: addresses messages may name it by
    machines().forEach((m) => {
      const ag = states[m.id] && states[m.id].agents;
      if (ag && ag.names && typeof ag.names === "object") Object.assign(named, ag.names);
      if (ag && ag.addrs && typeof ag.addrs === "object") Object.entries(ag.addrs).forEach(([k, v]) => { if (Array.isArray(v)) addrs[k] = v.filter((a) => typeof a === "string"); });
    });
    const list = [...desks.values()];
    list.forEach((d) => { d.name = d.name || (typeof named[d.sid] === "string" && named[d.sid]) || (d.repo || "session") + " " + d.sid.slice(0, 8); });
    const byName = new Map();
    list.forEach((d) => byName.set(d.sid.toLowerCase(), d));
    list.forEach((d) => (addrs[d.sid] || []).forEach((a) => byName.set(a.toLowerCase(), d)));
    list.forEach((d) => byName.set(d.name.toLowerCase(), d));  // names win over ids

    // a helper desk joins its events by tool_use_id (start, launched) and by child id (launched, begin, stop), in either order
    const sub = (d, tool, child) => {
      let a = tool && d.by["t:" + tool], b = child && d.by["c:" + child], s = a || b;
      if (a && b && a !== b) { Object.keys(b).forEach((k) => { if (a[k] == null || a[k] === "" || (typeof a[k] === "number" && isNaN(a[k]))) a[k] = b[k]; }); d.subs.splice(d.subs.indexOf(b), 1); s = a; }
      if (!s) { s = { tool: null, child: null, desc: "", type: "", atype: "", model: "", status: "", parent: null, tok: null, start: NaN, begin: NaN, stop: NaN }; d.subs.push(s); }
      if (tool) { s.tool = tool; d.by["t:" + tool] = s; }
      if (child) { s.child = child; d.by["c:" + child] = s; }
      return s;
    };
    const pairs = new Map(), ops = {};
    let msgs = 0, vaultTotal = 0;
    evs.sort((a, b) => ms(a.ts) - ms(b.ts)).forEach((ev) => {
      const d = desks.get(ev.session_id), ts = ms(ev.ts), kid = ev.child || ev.agent_id;
      d.ev.push(ev); d.lastTs = Math.max(d.lastTs, ts);
      if (ev.ev === "subagent_start") { const s = sub(d, ev.tool_use_id, null); s.desc = ev.description || s.desc; s.type = ev.subagent_type || s.type; s.model = ev.model || s.model; s.start = ts; s.parent = ev.agent_id || null; }
      else if (ev.ev === "subagent_launched") { const s = sub(d, ev.tool_use_id, ev.child); s.status = ev.status || s.status; }
      else if (ev.ev === "subagent_begin" && kid) { const s = sub(d, null, kid); s.atype = ev.agent_type || s.atype; s.begin = ts; }
      else if (ev.ev === "subagent_stop" && kid) { const s = sub(d, null, kid); s.model = ev.model || s.model; if (ev.tokens_total != null) s.tok = Number(ev.tokens_total); s.stop = ts; }
      else if (ev.ev === "message") {
        msgs++; d.sent++;
        const to = byName.get(String(ev.to || "").toLowerCase());
        if (to && to !== d) { const k = d.sid + ">" + to.sid; if (!pairs.has(k)) pairs.set(k, { from: d.sid, to: to.sid, n: 0, last: ev, list: [] }); const p = pairs.get(k); p.n++; p.last = ev; p.list.push(ev); }
        else d.out.push(ev);
      } else if (ev.ev === "vault_write") { d.vault++; d.vaultLast = ts; vaultTotal++; d.ops[ev.op || "?"] = (d.ops[ev.op || "?"] || 0) + 1; ops[ev.op || "?"] = (ops[ev.op || "?"] || 0) + 1; }
    });
    // desks the owner dismissed on the office page (control.dismissed[sid] = {at, for: the desk's last activity then}):
    // hidden for everyone until the session shows activity newer than that
    const dis = (control && control.dismissed) || {}, dismissed = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i], x = dis[d.sid];
      if (x && !((d.lastTs || 0) > (Number(x.for) || 0))) { dismissed.push({ sid: d.sid, name: d.name, machine: d.machine, traced: d.traced }); desks.delete(d.sid); list.splice(i, 1); }
    }
    [...pairs.keys()].forEach((k) => { const p = pairs.get(k); if (!desks.has(p.from) || !desks.has(p.to)) pairs.delete(k); });
    if (dismissed.length) {  // counts cover the desks shown, so the header agrees with the Vault box
      vaultTotal = list.reduce((n, d) => n + d.vault, 0); msgs = list.reduce((n, d) => n + d.sent, 0);
      Object.keys(ops).forEach((k) => delete ops[k]);
      list.forEach((d) => Object.entries(d.ops).forEach(([k, n]) => { ops[k] = (ops[k] || 0) + n; }));
    }
    let running = 0;
    list.forEach((d) => {
      d.lastTs = d.lastTs || NaN;
      d.glow = t - d.vaultLast <= GLOW;
      d.subs.sort((a, b) => (subState(b, t) === "running") - (subState(a, t) === "running") || (subStart(b) || 0) - (subStart(a) || 0));
      running += d.subs.filter((s) => subState(s, t) === "running").length;
    });
    const byMachine = {};
    list.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0)).forEach((d) => { (byMachine[d.machine] = byMachine[d.machine] || []).push(d); });
    return { desks, list, byMachine, orphans, dismissed: dismissed.reverse(), arcs: [...pairs.values()], msgs, running, vault: { total: vaultTotal, ops, glow: list.filter((d) => d.glow).sort((a, b) => b.vaultLast - a.vaultLast) } };
  }

  // The viewer's arrangement (user 2026-11-09). `order` is a list of keys; listed items come first in that order,
  // the rest keep their default order after them (so a new session or machine shows up at the end of its group).
  function orderBy(list, keyOf, order) {
    const at = new Map((order || []).map((k, i) => [k, i]));
    return list.map((x, i) => ({ x, i, r: at.has(keyOf(x)) ? at.get(keyOf(x)) : Infinity }))
      .sort((a, b) => (a.r - b.r) || (a.i - b.i)).map((o) => o.x);
  }
  // Move `key` by delta (-1 up, +1 down) within the keys as shown; out of range or unknown -> unchanged copy.
  function moveKey(keys, key, delta) {
    const a = keys.slice(), i = a.indexOf(key), j = i + delta;
    if (i < 0 || j < 0 || j >= a.length) return a;
    [a[i], a[j]] = [a[j], a[i]];
    return a;
  }
  // A group's new order in front, every other stored key after it in its old order (other groups keep theirs).
  const mergeOrder = (order, group) => group.concat((order || []).filter((k) => !group.includes(k)));

  const api = { MIN, HR, DAY, GLOW, SUB_STALE, ms, shortModel, plain, machines: machinesOf, parseQueue, derive, subStart, subState, orderBy, moveKey, mergeOrder };
  root.OfficeModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
