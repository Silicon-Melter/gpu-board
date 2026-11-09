/* Agent office flow views: pure layout and analysis, no DOM, no network, no globals besides OfficeModel.
   OfficeFlow.connections(M, {machines, queue, now, expanded, states}) -> {W, H, lanes, nodes, edges, stats}
   OfficeFlow.workflow(M, {queue, jobs, events, question, now}) -> {stages, cards, deps, attention, question}
   Everything is computed from the model (OfficeModel.derive) and the parsed queue; nothing is hand-written. */
(function (root) {
  "use strict";
  const OM = root.OfficeModel;
  const MIN = 60e3, HR = 3600e3, DAY = 24 * HR;
  const RECENT = 10 * MIN, GLOW = 60 * MIN, KID_MAX = 6;
  const OVER = ["done", "withdrawn", "cancelled", "superseded", "dropped"];  // queue words for an item that is finished or off the table
  const WAITERS = ["ready", "blocked", "queued", "waiting"];

  // ---------------- Connections ----------------
  // Layout constants (px): shared column, message rail, leads, children. Machines are lanes, top to bottom.
  const X = { shared: 6, sharedW: 148, lane: 170, lead: 304, leadW: 224, kid: 584, kidW: 290 };
  const W = X.kid + X.kidW + 14, LEAD_H = 94, KID_H = 70, PITCH = 78, HEAD = 58;

  const modelLabel = (m) => {
    const sm = OM.shortModel(m);
    if (!sm) return "Unknown model";
    const parts = sm.split("-"), nums = parts.slice(1).filter((p) => /^\d{1,2}$/.test(p));
    return parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + (nums.length ? " " + nums.join(".") : "");
  };
  const byText = (f) => (a, b) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0);
  const JOB_ORDER = { running: 0, paused: 1, queued: 2, blocked: 3, failed: 4, done: 5 };

  function kidsOf(d, now, opts) {
    const groups = new Map();
    d.subs.forEach((s) => { const k = modelLabel(s.model); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); });
    const kids = [...groups.entries()].sort(byText((g) => g[0])).map(([label, subs]) => {
      const running = subs.filter((s) => OM.subState(s, now) === "running").length;
      const tok = subs.reduce((n, s) => n + (s.tok != null && !isNaN(s.tok) ? s.tok : 0), 0);
      const items = subs.slice().sort((a, b) => (OM.subStart(b) || 0) - (OM.subStart(a) || 0)).map((s) => {
        const parent = s.parent && d.by["c:" + s.parent];
        return { desc: s.desc, start: OM.subStart(s), tok: s.tok, state: OM.subState(s, now), inside: parent && parent.desc ? parent.desc : s.parent ? String(s.parent).slice(0, 8) : "" };
      });
      return { kind: "helpers", id: "k:" + d.sid + ":h:" + label, lead: "d:" + d.sid, label, count: subs.length, running, tok, items };
    });
    const jobs = d.jobs.slice().sort((a, b) => (JOB_ORDER[a.state] ?? 9) - (JOB_ORDER[b.state] ?? 9) || (a.id < b.id ? -1 : 1));
    jobs.forEach((j) => {
      const away = j.machine !== d.machine;
      kids.push({ kind: "job", id: "k:" + d.sid + ":j:" + j.id, lead: "d:" + d.sid, job: { id: j.id, task: j.task || j.id, state: j.state, pct: Number(j.pct) || 0, res: j.res || "", machine: j.machine, progress: j.progress || "", eta: j.eta || "", result: j.result || "", updated: OM.ms(j.updated) },
        where: (away ? "on " : "") + j.machine + (j.res ? " " + j.res : ""), away });
    });
    const open = opts.expanded && opts.expanded.includes(d.sid);
    if (kids.length > KID_MAX && !open) {
      const keep = kids.slice(0, KID_MAX - 1), rest = kids.slice(KID_MAX - 1);
      return keep.concat([{ kind: "more", id: "k:" + d.sid + ":more", lead: "d:" + d.sid, sid: d.sid, count: rest.length, label: "+" + rest.length + " more", names: rest.map((k) => (k.kind === "job" ? k.job.task : k.label + " ×" + k.count)) }]);
    }
    return kids;
  }

  function connections(M, opts) {
    opts = opts || {};
    const now = opts.now, machines = (opts.machines || []).slice(), queue = opts.queue && opts.queue.items ? opts.queue.items : [];
    const mids = machines.map((m) => m.id);
    const nodes = {}, lanes = [], edges = [];

    // 1. who is a lead: every desk; messages to a name that is no desk become an untraced node
    const leadOf = new Map();  // node id -> lead data
    const deskLead = (d) => {
      const sent = 0;
      return { id: "d:" + d.sid, sid: d.sid, kind: "lead", name: d.name, repo: d.repo, machine: d.machine, lastTs: d.lastTs, untraced: !d.traced,
        glow: !!d.vaultLast && now - d.vaultLast <= GLOW, vault: d.vault ? { n: d.vault, ops: Object.assign({}, d.ops), last: d.vaultLast } : null, aliases: [], sent, got: 0, d };
    };
    M.list.forEach((d) => leadOf.set("d:" + d.sid, deskLead(d)));
    const untracedIn = (mid) => [...leadOf.values()].filter((l) => l.untraced && l.machine === mid);
    const target = (name) => {  // where a message to `name` (no desk of that name) lands
      const low = String(name || "").toLowerCase(), hit = mids.filter((id) => low.includes(String(id).toLowerCase()));
      if (hit.length === 1) { const u = untracedIn(hit[0]); if (u.length === 1) { if (!u[0].aliases.includes(name)) u[0].aliases.push(name); return u[0].id; } }
      const id = "x:" + low;
      if (!leadOf.has(id)) leadOf.set(id, { id, sid: null, kind: "lead", name: String(name || "?"), repo: "", machine: "elsewhere", lastTs: NaN, untraced: true, glow: false, vault: null, aliases: [], sent: 0, got: 0, d: null, elsewhere: true });
      return id;
    };

    // 2. messages, one entry per message, then one line per unordered pair
    const msgs = [];
    M.arcs.forEach((a) => a.list.forEach((ev) => msgs.push({ ts: OM.ms(ev.ts), from: "d:" + a.from, to: "d:" + a.to, summary: ev.summary || "" })));
    M.list.forEach((d) => d.out.forEach((ev) => msgs.push({ ts: OM.ms(ev.ts), from: "d:" + d.sid, to: target(ev.to), summary: ev.summary || "", toName: ev.to })));
    msgs.sort((a, b) => a.ts - b.ts);
    msgs.forEach((m) => { m.fromName = leadOf.get(m.from).name; m.toName = leadOf.get(m.to).name; leadOf.get(m.from).sent++; leadOf.get(m.to).got++; });
    const pairs = new Map();
    msgs.forEach((m) => {
      const [a, b] = m.from < m.to ? [m.from, m.to] : [m.to, m.from], k = a + "|" + b;
      if (!pairs.has(k)) pairs.set(k, { a, b, list: [] });
      pairs.get(k).list.push(m);
    });

    // 3. lanes and nodes
    const known = new Set(mids);
    const laneDefs = machines.map((m) => ({ id: m.id, name: m.name || m.id, spec: m.spec || "", devices: m.devices || [] }));
    const lastLanes = [...leadOf.values()].filter((l) => !known.has(l.machine));
    if (lastLanes.length) laneDefs.push({ id: "elsewhere", name: "Elsewhere", spec: "sessions known only from a message or a job on an unlisted machine", devices: [] });
    let y = 26;
    laneDefs.forEach((ln) => {
      const top = y; y += HEAD;
      const leads = [...leadOf.values()].filter((l) => (known.has(l.machine) ? l.machine : "elsewhere") === ln.id).sort((p, q) => (p.untraced - q.untraced) || byText((l) => l.name.toLowerCase())(p, q));
      leads.forEach((l, i) => {
        const kids = l.d ? kidsOf(l.d, now, opts) : [], kh = kids.length ? kids.length * PITCH - (PITCH - KID_H) : 0, block = Math.max(kh, LEAD_H);
        nodes[l.id] = Object.assign({}, l, { d: undefined, x: X.lead, y: y + (block - LEAD_H) / 2, w: X.leadW, h: LEAD_H, lane: ln.id });
        delete nodes[l.id].d;
        kids.forEach((k, j) => { nodes[k.id] = Object.assign({}, k, { x: X.kid, y: y + (block - kh) / 2 + j * PITCH, w: X.kidW, h: KID_H, lane: ln.id }); });
        y += block + (i < leads.length - 1 ? 20 : 12);
      });
      if (!leads.length) y += 28;
      lanes.push({ id: ln.id, name: ln.name, spec: ln.spec, devices: ln.devices, top, bottom: y, x: X.lane, w: W - X.lane });
      y += 14;
    });
    let H = y + 4;
    const cy = (id) => nodes[id].y + nodes[id].h / 2;
    const leadIds = Object.keys(nodes).filter((id) => nodes[id].kind === "lead");

    // 4. shared column: vault, you, A100 queue (stacked, never overlapping)
    const writers = leadIds.filter((id) => nodes[id].vault);
    const open = queue.filter((it) => !OVER.includes(it.word)), shownQ = open.slice(0, 6);
    const qh = 40 + shownQ.length * 26 + (queue.length > open.length || open.length > shownQ.length ? 22 : 0);
    const a100Lead = leadIds.filter((id) => nodes[id].machine === "a100").sort((p, q) => (nodes[p].untraced - nodes[q].untraced))[0];
    const vc = writers.length ? writers.reduce((s, id) => s + cy(id), 0) / writers.length : 160;
    const vaultY = Math.max(50, vc - 50);
    const qDesired = a100Lead ? cy(a100Lead) - qh / 2 : vaultY + 200;
    const queueY = Math.max(qDesired, vaultY + 100 + 16 + 70 + 34), youY = Math.max(vaultY + 116, queueY - 104);
    const wTot = writers.reduce((s, id) => s + nodes[id].vault.n, 0), ops = {}, glowers = [];
    writers.forEach((id) => { Object.entries(nodes[id].vault.ops).forEach(([k, n]) => { ops[k] = (ops[k] || 0) + n; }); if (nodes[id].glow) glowers.push(id); });
    nodes.vault = { id: "vault", kind: "vault", x: X.shared, y: vaultY, w: X.sharedW, h: 100, total: wTot, ops, glowers: glowers.length, lane: "shared" };
    nodes.you = { id: "you", kind: "you", x: X.shared, y: youY, w: X.sharedW, h: 70, lane: "shared" };
    nodes.queue = { id: "queue", kind: "queue", x: X.shared, y: queueY, w: X.sharedW, h: qh, items: shownQ.map((it) => ({ id: it.id, word: it.word, task: it.task, text: it.text, added: it.added })), openCount: open.length, finished: queue.length - open.length, error: opts.queue && opts.queue.error ? String(opts.queue.error) : "", lane: "shared" };
    H = Math.max(H, queueY + qh + 10);

    // 5. edges
    // spawn and job edges: lead right side to child left side
    Object.values(nodes).filter((n) => ["helpers", "job", "more"].includes(n.kind)).forEach((k) => {
      const a = nodes[k.lead], x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = k.x, y2 = k.y + k.h / 2, mx = (x1 + x2) / 2;
      const type = k.kind === "job" ? "job" : "spawn";
      edges.push({ id: "e:" + k.id, type, cls: type === "job" && k.job.state === "queued" ? "queued" : "", d: `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2 - 2} ${y2}`, ends: [k.lead, k.id], end: true });
    });
    // messages: one line per pair, bowing into the rail left of the leads
    const P = [...pairs.values()].map((p) => Object.assign(p, { span: Math.abs(cy(p.a) - cy(p.b)) })).sort((p, q) => p.span - q.span || (p.a + p.b < q.a + q.b ? -1 : 1));
    const ports = {};
    P.forEach((p) => { [p.a, p.b].forEach((s) => { (ports[s] = ports[s] || []).push(p); }); });
    Object.entries(ports).forEach(([s, list]) => list.sort((p, q) => cy(p.a === s ? p.b : p.a) - cy(q.a === s ? q.b : q.a) || (p.a + p.b < q.a + q.b ? -1 : 1)));
    const portY = (s, p) => nodes[s].y + 14 + Math.min(ports[s].indexOf(p), 4) * 9;
    const step = Math.min(18, 100 / Math.max(1, P.length - 1));
    P.forEach((p, depth) => {
      const y1 = portY(p.a, p), y2 = portY(p.b, p), x = X.lead, reach = 14 + depth * step, cx = x - reach / 0.75;
      const ab = p.list.filter((m) => m.from === p.a).length, ba = p.list.length - ab, last = p.list[p.list.length - 1];
      edges.push({ id: "m:" + p.a + "|" + p.b, type: "msg", width: 1.3 + Math.min(p.list.length, 4) * 0.45, d: `M${x} ${y1}C${cx} ${y1} ${cx} ${y2} ${x} ${y2}`, ends: [p.a, p.b],
        start: ba > 0, end: ab > 0, label: "×" + p.list.length, lx: x - reach, ly: (y1 + y2) / 2, n: p.list.length, msgs: p.list.slice(), lastTs: last.ts, recent: now - last.ts < RECENT });
    });
    // shared edges: ports in the lower half of each lead, spread along the target
    const shared = [];
    writers.forEach((id) => shared.push({ lead: id, to: "vault", type: "vault", recent: now - nodes[id].vault.last < RECENT, vault: nodes[id].vault, note: null }));
    const qBy = {};
    queue.forEach((it) => {
      const add = (it.added || "").toLowerCase();
      leadIds.forEach((id) => {
        const repo = (nodes[id].repo || "").toLowerCase();
        if ((repo && add.includes(repo)) || (add.includes("manager") && repo === "ad-research")) (qBy[id] = qBy[id] || []).push(it.id);
      });
    });
    Object.entries(qBy).forEach(([id, ids]) => shared.push({ lead: id, to: "queue", type: "q", ids, note: "added " + ids.join(", ") + " (QUEUE.md, Added column)" }));
    const running = queue.filter((it) => it.word === "running");
    if (running.length && a100Lead) shared.push({ lead: a100Lead, to: "queue", type: "q", dir: "in", ids: running.map((it) => it.id), note: "the A100 runs " + running.map((it) => it.id).join(", ") + " from the queue" });
    const sp = {}, inc = {};
    shared.forEach((s) => { (sp[s.lead] = sp[s.lead] || []).push(s); (inc[s.to] = inc[s.to] || []).push(s); });
    Object.values(sp).forEach((list) => list.sort((a, b) => cy(a.to) - cy(b.to) || (a.type < b.type ? -1 : 1)));
    Object.values(inc).forEach((list) => list.sort((a, b) => cy(a.lead) - cy(b.lead)));
    shared.forEach((s) => {
      const n = nodes[s.lead], t = nodes[s.to], i = inc[s.to].indexOf(s), cnt = inc[s.to].length;
      const yl = n.y + n.h - 26 + Math.min(sp[s.lead].indexOf(s), 3) * 9, top = t.y + (s.to === "queue" ? 30 : 12), span = t.h - (s.to === "queue" ? 38 : 24);
      const ys = top + span * (i + 0.5) / cnt, x1 = t.x + t.w, x2 = n.x, mx = x1 + (x2 - x1) * 0.45;
      const d = s.dir === "in" ? `M${x1} ${ys}C${mx} ${ys} ${mx} ${yl} ${x2 - 2} ${yl}` : `M${x2} ${yl}C${mx} ${yl} ${mx} ${ys} ${x1 + 2} ${ys}`;
      edges.push({ id: "s:" + s.lead + ">" + s.to + (s.dir ? ":in" : ""), type: s.type, d, ends: [s.lead, s.to], end: true, note: s.note, vault: s.vault, ids: s.ids, recent: !!s.recent });
    });
    const yq = nodes.queue, yo = nodes.you;
    edges.push({ id: "s:you>queue", type: "you", d: `M${yo.x + yo.w / 2} ${yo.y + yo.h}L${yq.x + yq.w / 2} ${yq.y - 3}`, ends: ["you", "queue"], end: true, note: "you dispatch the A100 queue (a standing rule, not traced)" });

    const jobs = Object.values(nodes).filter((n) => n.kind === "job");
    const stats = { sessions: leadIds.length, untraced: leadIds.filter((id) => nodes[id].untraced).length, helpersRunning: M.running, messages: msgs.length, vaultWrites: M.vault.total, jobsRunning: jobs.filter((n) => n.job.state === "running").length };
    return { W, H, lanes, nodes, edges, stats };
  }

  // ---------------- Work flow ----------------
  const STAGES = [
    { key: "brief", name: "Brief", sub: "manager writes the task" }, { key: "dev", name: "Develop / prepare", sub: "code and data" }, { key: "queue", name: "A100 queue", sub: "QUEUE.md" },
    { key: "train", name: "Train", sub: "A100" }, { key: "eval", name: "Eval", sub: "4090, CARLA 0.9.16" }, { key: "verify", name: "Verify", sub: "manager checks the numbers" }, { key: "decide", name: "Decision", sub: "DECISIONS.md" }
  ];
  const STOP = new Set(["blocked", "waiting", "wait", "after", "needs", "need", "with", "from", "that", "this", "have", "been", "will", "done", "ready", "running", "queued", "until", "before", "then", "than", "into", "when"]);
  const TROUBLE = /crash|\boom\b|out of memory|\bnan\b|diverg|killed|traceback|error/i;  // not "FAIL": test results use it
  const idsOf = (text) => { const out = []; String(text || "").replace(/\b([TAUE]\d{2,3})\b/g, (m, id) => { if (id !== "A100" && !out.includes(id)) out.push(id); return m; }); return out; };
  const words = (text) => new Set((String(text || "").toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 4 && !STOP.has(w)));
  const agoText = (d) => (d < 45e3 ? "just now" : d < HR ? Math.max(1, Math.round(d / MIN)) + " min ago" : d < 48 * HR ? Math.floor(d / HR) + " h" + (Math.round((d % HR) / MIN) ? " " + Math.round((d % HR) / MIN) + " min" : "") + " ago" : Math.round(d / DAY) + " d ago");
  const stageOfJob = (text) => (/eval|bench/i.test(text) ? "eval" : /audit|verify|check|review/i.test(text) ? "verify" : "dev");

  // a Task-file cell ("tasks/A18-R1prime-lead4x.md") reads better as its name without folder, extension or leading id
  const fileTitle = (s, id) => String(s || "").replace(/^.*\//, "").replace(/\.md$/i, "").replace(new RegExp("^" + id + "[-_ ]*"), "") || String(s || "");
  const jobsOf = (M) => M.list.flatMap((d) => d.jobs).concat(Object.values(M.orphans).flat());
  const eventsOf = (M) => M.list.flatMap((d) => d.ev.map((ev) => Object.assign({}, ev, { sid: d.sid, session: d.name })));

  function workflow(M, opts) {
    const now = opts.now, DAYMS = DAY, items = opts.queue && opts.queue.items ? opts.queue.items : [], jobs = opts.jobs || jobsOf(M), events = opts.events || eventsOf(M);
    const q = opts.question && Array.isArray(opts.question.path) ? opts.question : null;
    const over = (it) => OVER.includes(it.word), qIds = new Set(items.map((it) => it.id));
    const path = q ? q.path.map((e, i) => (e && e.id ? { key: String(e.id), id: String(e.id), stage: e.stage || null } : { key: "path:" + i, id: null, label: String((e && e.label) || "next"), stage: (e && e.stage) || "eval" })) : [];
    const onPath = new Set(path.map((e) => e.key));
    const owner = (j) => { const d = j.session_id && M.desks.get(j.session_id); return d ? d.name + (d.traced ? "" : " (not traced)") : j.repo || ""; };
    const machineTokens = new Set([...(opts.machines || []).map((m) => m.id), ...jobs.map((j) => j.machine)].flatMap((id) => String(id || "").toUpperCase().split(/[^A-Z0-9]+/)).filter(Boolean));  // "u24" in a job id is the machine, not a task
    const taskIds = (text) => idsOf(text).filter((x) => !machineTokens.has(x));
    const live = jobs.filter((j) => j.state !== "done" || now - OM.ms(j.updated) <= DAYMS);
    const cards = [], byKey = new Map(), add = (c) => { cards.push(c); byKey.set(c.key, c); return c; };
    let finished = 0;

    // queue items: open ones by their word; done ones only when on the question's path
    items.forEach((it) => {
      if (over(it) && !(it.word === "done" && onPath.has(it.id))) { finished++; return; }
      const stage = it.word === "done" ? "eval" : it.word === "running" ? "train" : "queue";
      add({ key: it.id, id: it.id, ghost: false, stage, title: fileTitle(it.task, it.id) || it.text, state: it.word || "open", onpath: onPath.has(it.id), owner: it.added ? "added by " + it.added : "", meta: it.est ? "est. " + it.est + " A100 h" : "", dep: "", flags: [], jobs: [], item: it, last: "" });
    });
    // board jobs: merge into the queue item they name, else one card per task id (or per job)
    const groups = new Map();
    live.forEach((j) => {
      const ids = taskIds(j.id.toUpperCase() + " " + (j.task || ""));
      const qid = ids.find((x) => qIds.has(x) && byKey.has(x));
      if (qid) { const c = byKey.get(qid); c.jobs.push(j); return; }
      const key = ids[0] || "job:" + j.id;
      if (!groups.has(key)) groups.set(key, { key, id: ids[0] || null, jobs: [] });
      groups.get(key).jobs.push(j);
    });
    byKey.forEach((c) => { if (c.jobs.length) { const j = c.jobs.slice().sort((a, b) => (JOB_ORDER[a.state] ?? 9) - (JOB_ORDER[b.state] ?? 9))[0]; c.meta = [j.machine + " " + (j.res || ""), j.pct && j.state !== "done" ? j.pct + "%" : "", j.progress, j.eta && "ETA " + j.eta, c.meta].filter(Boolean).join(" · "); } });
    groups.forEach((g) => {
      const sorted = g.jobs.slice().sort((a, b) => (JOB_ORDER[a.state] ?? 9) - (JOB_ORDER[b.state] ?? 9) || (a.id < b.id ? -1 : 1)), j = sorted[0], text = g.jobs.map((x) => x.id + " " + (x.task || "")).join(" ");
      const state = sorted.some((x) => x.state === "running") ? "running" : sorted.some((x) => x.state === "queued") ? "queued" : j.state;
      add({ key: g.key, id: g.id, ghost: false, stage: stageOfJob(text), title: (g.id ? (j.task || "").replace(new RegExp("^" + g.id + "\\s*"), "") || j.task : j.task) || j.id, state, onpath: !!g.id && onPath.has(g.id), owner: owner(j),
        meta: [j.machine + " " + (j.res || ""), j.pct && j.state !== "done" ? j.pct + "%" : "", j.progress, j.eta && "ETA " + j.eta, j.state === "done" ? j.result : ""].filter(Boolean).join(" · "), dep: "", flags: [], jobs: g.jobs, last: "" });
    });
    // the path: ids with no card, and label-only steps, become dashed "next" cards in their stage
    path.forEach((e) => {
      const c = byKey.get(e.key);
      if (c) { c.onpath = true; return; }
      add({ key: e.key, id: e.id, ghost: true, stage: e.stage || "eval", title: e.label || e.id, state: "open", onpath: true, owner: e.id ? "on the path, not in the queue or a job" : "", meta: "", dep: "", flags: [], jobs: [], last: "" });
    });
    cards.forEach((c) => { if (!STAGES.some((s) => s.key === c.stage)) c.stage = "dev"; });

    // what the last message that names a card's id said
    const msgs = events.filter((ev) => ev.ev === "message").sort((a, b) => OM.ms(a.ts) - OM.ms(b.ts));
    cards.forEach((c) => { if (!c.id) return; const m = msgs.filter((ev) => idsOf(ev.summary).includes(c.id)).pop(); if (m) c.last = "'" + (m.summary || "") + "' from " + m.session + ", " + agoText(now - OM.ms(m.ts)); });

    const deps = [], flags = [], attention = [];
    const flag = (c, kind, title, text) => { c.flags.push({ kind, text }); attention.push({ card: c.key, kind, title, text }); };
    const hasDep = (a, b, type) => deps.some((d) => d.a === a && d.b === b && (!type || d.type === type));
    // wait: only a ready/blocked/queued/waiting item, and only on an open item named in its Needs or right after "after" in its State
    items.filter((it) => WAITERS.includes(it.word) && byKey.has(it.id)).forEach((it) => {
      const named = idsOf(it.needs);
      it.text.replace(/\b(?:run\s+)?after\s+([TAUE]\d{2,3})\b/gi, (m, id) => { named.push(id.toUpperCase()); return m; });
      [...new Set(named)].filter((x) => x !== it.id && byKey.has(x) && items.some((o) => o.id === x && !over(o))).forEach((x) => {
        deps.push({ a: x, b: it.id, type: "wait", label: "after " + x });
        const eta = byKey.get(x).jobs.map((j) => j.eta).find(Boolean);
        byKey.get(it.id).dep = "Starts after " + x + (eta ? " (ETA " + eta + ")" : "");
      });
    });
    // flow: consecutive entries of the question path
    for (let i = 0; i + 1 < path.length; i++) { const a = path[i], b = path[i + 1]; if (byKey.has(a.key) && byKey.has(b.key) && !hasDep(a.key, b.key)) deps.push({ a: a.key, b: b.key, type: "flow", label: a.id || "" }); }
    // stale blocker: a blocked item and a job that finished in the window which shares a task id or two significant words
    items.filter((it) => it.word === "blocked" && byKey.has(it.id)).forEach((it) => {
      const text = it.text + " " + it.needs, bw = words(text), bid = idsOf(text);
      const fin = live.filter((j) => j.state === "done" && now - OM.ms(j.updated) <= DAYMS).find((j) => {
        const jt = (j.task || "") + " " + j.id.toUpperCase();
        return idsOf(jt).some((x) => bid.includes(x) && x !== it.id) || [...words(jt)].filter((w) => bw.has(w)).length >= 2;
      });
      if (!fin) return;
      const jc = cards.find((c) => c.jobs.includes(fin));
      flag(byKey.get(it.id), "stale", it.id + " may be unblocked", "Its blocker may be cleared: '" + (fin.task || fin.id) + "' finished " + agoText(now - OM.ms(fin.updated)) + (fin.result ? " (" + fin.result + ")" : "") + ".");
      if (jc) deps.push({ a: jc.key, b: it.id, type: "stale", label: "may unblock" });
    });
    // quiet hand-off: a done item on the path that nothing in the window mentions
    const corpus = events.map((ev) => [ev.summary, ev.description, ev.to].join(" ")).concat(live.map((j) => j.id.toUpperCase() + " " + (j.task || "") + " " + (j.result || "")));
    const mentioned = new Set(corpus.flatMap(idsOf));
    items.filter((it) => it.word === "done" && onPath.has(it.id) && byKey.has(it.id)).forEach((it) => {
      if (!mentioned.has(it.id)) flag(byKey.get(it.id), "bad", it.id + " hand-off went quiet", "No job, message or session has mentioned " + it.id + " in the last 24 h.");
    });
    // gpu wait: a queued job on the machine of a running job, same resource (or either one just "gpu")
    const running = live.filter((j) => j.state === "running");
    live.filter((j) => j.state === "queued").forEach((j) => {
      const hold = running.find((r) => r.machine === j.machine && (r.res === j.res || r.res === "gpu" || j.res === "gpu"));
      const c = cards.find((x) => x.jobs.includes(j)), hc = hold && cards.find((x) => x.jobs.includes(hold));
      if (!hold || !c || c === hc || c.flags.some((f) => f.kind === "gpu")) return;
      const text = "Waits for " + j.machine + " " + hold.res + ", held by '" + (hold.task || hold.id) + "'" + (hold.eta ? ", ETA " + hold.eta : "") + ".";
      c.dep = text;
      flag(c, "gpu", (c.id || c.title) + " waits for the " + j.machine + " " + hold.res, text);
      if (hc) deps.push({ a: hc.key, b: c.key, type: "gpu", label: "holds the GPU" });
    });
    // trouble: a message in the window that sounds like a failure and names the card or comes from the session that owns its job
    msgs.filter((ev) => TROUBLE.test(ev.summary || "")).forEach((ev) => {
      cards.forEach((c) => {
        const named = c.id && idsOf(ev.summary).includes(c.id), owns = c.jobs.some((j) => j.session_id && j.session_id === ev.sid);
        if ((named || owns) && !c.flags.some((f) => f.kind === "trouble" && f.text.includes(ev.summary))) flag(c, "trouble", (c.id || c.title) + ": possible trouble", ev.session + " reported '" + ev.summary + "' " + agoText(now - OM.ms(ev.ts)) + ".");
      });
    });
    // an id-less job is a card only when a flag or a dependency refers to it, or it is on the path; the rest are only counted
    const ref = new Set(deps.flatMap((d) => [d.a, d.b]));
    let otherJobs = 0;
    for (let i = cards.length - 1; i >= 0; i--) { const c = cards[i]; if (!c.id && !c.ghost && !c.onpath && !c.flags.length && !ref.has(c.key)) { otherJobs += c.jobs.length; cards.splice(i, 1); } }
    const att = ["stale", "bad", "trouble", "gpu"];
    attention.sort((a, b) => att.indexOf(a.kind) - att.indexOf(b.kind));
    const stats = { inflight: cards.filter((c) => !c.ghost && ["running", "queued", "ready", "blocked", "waiting"].includes(c.state)).length, onpath: cards.filter((c) => c.onpath).length, attention: attention.length, finished };
    return { stages: STAGES, cards, deps, attention, question: q ? { text: String(q.text || ""), path } : null, finished, otherJobs, stats };
  }

  const api = { connections, workflow, jobsOf, eventsOf, idsOf, X, W, modelLabel };
  root.OfficeFlow = Object.assign(root.OfficeFlow || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = root.OfficeFlow;
})(typeof window !== "undefined" ? window : globalThis);
