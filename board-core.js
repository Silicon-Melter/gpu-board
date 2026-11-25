/* Shared by the board page (index.html) and the Agent office (office.html): browser storage, time text, and the
   GitHub client both pages use to read and write agent-board. No DOM, no rendering. */
(function (root) {
  "use strict";
  const MIN = 60e3, HR = 3600e3, DAY = 24 * HR;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* storage blocked: lasts for this visit */ } }
  };
  const readJson = (k, fallback) => { try { return JSON.parse(store.get(k) || "null") ?? fallback; } catch (e) { return fallback; } };

  // a timestamp in seconds, milliseconds or ISO text -> milliseconds (NaN when unreadable)
  const ms = (v) => typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v || "");
  function ago(ts, now) {
    const d = (now ?? Date.now()) - ts;
    if (!isFinite(d)) return "at an unknown time";
    if (d < 45e3) return "just now";
    if (d < HR) return Math.max(1, Math.round(d / MIN)) + " min ago";
    if (d < 48 * HR) { const h = Math.floor(d / HR), m = Math.round((d % HR) / MIN); return h + " h" + (m ? " " + m + " min" : "") + " ago"; }
    return Math.round(d / DAY) + " d ago";
  }
  const sessionUrl = (s) => (/^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+$/.test(String(s || "")) ? s : null);

  function b64decode(s) { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, "")), (c) => c.charCodeAt(0))); }
  function b64encode(text) { let bin = ""; new TextEncoder().encode(text).forEach((b) => { bin += String.fromCharCode(b); }); return btoa(bin); }

  // The token both pages share (localStorage "gpu-board.token"), and for a signed-in token its refresh token and expiry
  // ("gpu-board.auth"; null for a pasted token). `relay` swaps GitHub's sign-in code, or later the refresh token, for a
  // token pair (signed-in tokens last 8 h); a 401 renews once and retries.
  function github({ api, relay }) {
    const session = { token: store.get("gpu-board.token"), auth: readJson("gpu-board.auth", null) };
    function save(token, auth) {
      session.token = token; session.auth = auth;
      store.set("gpu-board.token", token); store.set("gpu-board.auth", auth && JSON.stringify(auth));
    }
    async function swap(body) {
      const r = await fetch(relay, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || "the sign-in relay said " + r.status);
      save(j.access_token, j.refresh_token ? { refresh: j.refresh_token, exp: j.expires_in ? Date.now() + j.expires_in * 1000 : null } : null);
    }
    let renewing = null;
    const renew = () => (renewing = renewing || swap({ refresh_token: session.auth.refresh }).finally(() => { renewing = null; }));
    async function gh(path, opts) {
      const auth = session.auth;
      if (auth && auth.exp && Date.now() > auth.exp - MIN) await renew().catch(() => {});
      for (let tries = 0; ; tries++) {
        const r = await fetch(/^https:/.test(path) ? path : api + path, Object.assign({ cache: "no-store" }, opts, {
          headers: Object.assign({ Authorization: "Bearer " + session.token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, (opts && opts.headers) || {})
        }));
        if (r.status === 401 && session.auth && !tries && await renew().then(() => true, () => false)) continue;
        if (r.status === 401) { const e = new Error("GitHub rejected the token"); e.auth = true; throw e; }
        return r;
      }
    }
    // a file on a branch or commit: {text, sha}, or null when it doesn't exist
    async function readFile(path, ref) {
      const r = await gh("/contents/" + path + "?ref=" + encodeURIComponent(ref));
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("GitHub said " + r.status + " for " + path + " on " + ref);
      const j = await r.json();
      return { text: b64decode(j.content), sha: j.sha };
    }
    return { session, save, swap, gh, readFile };
  }

  root.BoardCore = { MIN, HR, DAY, store, readJson, ms, ago, sessionUrl, b64decode, b64encode, github };
})(typeof window !== "undefined" ? window : globalThis);
