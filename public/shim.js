// Remplace l'environnement claude.ai (window.claude.use("db" | "user")) par l'API du dashboard.
// MyGym et Le Brief ont été écrits pour claude.ai : ce fichier leur donne la même base de données,
// stockée ici sur Cloudflare D1. L'IA ("sample") n'existe pas en dehors de claude.ai : elle reste indisponible.
(function () {
  var TOKEN_KEY = "myself.token";
  var token = function () { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } };
  var enc = encodeURIComponent;
  var inFrame = window.parent !== window;

  function authError() {
    var err = new Error("auth"); err.code = "auth";
    if (inFrame) window.parent.postMessage({ type: "myself-auth" }, location.origin);
    showLock();
    return err;
  }
  function showLock() {
    if (document.getElementById("myself-lock")) return;
    var d = document.createElement("div");
    d.id = "myself-lock";
    d.style.cssText = "position:fixed;inset:0;z-index:99999;background:#000;color:#f4f4f5;display:grid;place-items:center;padding:24px;text-align:center;font:16px -apple-system,system-ui,sans-serif";
    d.innerHTML = '<div><p style="margin:0 0 14px">Connecte-toi depuis le dashboard pour ouvrir cette appli.</p><a href="/" target="_top" style="color:#000;background:#fff;border-radius:12px;padding:14px 22px;text-decoration:none;font-weight:600;display:inline-block">Ouvrir le dashboard</a></div>';
    (document.body || document.documentElement).appendChild(d);
  }
  function api(path, opts) {
    opts = opts || {};
    var t = token();
    if (!t) return Promise.reject(authError());
    var headers = { authorization: "Bearer " + t };
    if (opts.body) headers["content-type"] = "application/json";
    return fetch("/api/" + path, { method: opts.method || "GET", body: opts.body, headers: headers }).then(function (r) {
      if (r.status === 401) { try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} throw authError(); }
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("api " + r.status);
      return r.json();
    });
  }

  function autoId() {
    var s = "", a = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    var r = crypto.getRandomValues(new Uint8Array(20));
    for (var i = 0; i < 20; i++) s += a[r[i] % a.length];
    return s;
  }
  function Snap(id, data, exists) { this.id = id; this.exists = exists; this._d = data; }
  Snap.prototype.data = function () { return this._d; };

  function field(obj, f) { return f.split(".").reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj); }
  function match(doc, w) {
    var v = field(doc, w[0]), op = w[1], x = w[2];
    switch (op) {
      case "==": case "eq": return v === x;
      case "!=": case "ne": return v !== x;
      case "<": case "lt": return v < x;
      case "<=": case "lte": return v <= x;
      case ">": case "gt": return v > x;
      case ">=": case "gte": return v >= x;
      case "in": return Array.isArray(x) && x.indexOf(v) > -1;
      case "not-in": return Array.isArray(x) && x.indexOf(v) === -1;
      case "array-contains": return Array.isArray(v) && v.indexOf(x) > -1;
    }
    return true;
  }

  function docRef(path) {
    var id = path.split("/").pop();
    var url = "doc?path=" + enc(path);
    return {
      id: id, path: path,
      get: function () { return api(url).then(function (r) { return new Snap(id, r ? r.data : undefined, !!r); }); },
      set: function (data) { return api(url, { method: "PUT", body: JSON.stringify({ data: data }) }).then(function () {}); },
      update: function (data) {
        return api(url).then(function (r) {
          return api(url, { method: "PUT", body: JSON.stringify({ data: Object.assign({}, r ? r.data : {}, data) }) });
        }).then(function () {});
      },
      delete: function () { return api(url, { method: "DELETE" }).then(function () {}); },
      collection: function (name) { return colRef(path + "/" + name); }
    };
  }
  function colRef(path, q) {
    q = q || {};
    function next(extra) { return colRef(path, Object.assign({}, q, extra)); }
    function run() {
      return api("col?path=" + enc(path)).then(function (rows) {
        var docs = (rows || []).filter(function (r) { return (q.where || []).every(function (w) { return match(r.data, w); }); });
        if (q.order) {
          var f = q.order[0], dir = q.order[1] === "desc" ? -1 : 1;
          docs.sort(function (a, b) { var x = field(a.data, f), y = field(b.data, f); return x < y ? -dir : x > y ? dir : 0; });
        }
        if (q.limit) docs = docs.slice(0, q.limit);
        docs = docs.map(function (r) { return new Snap(r.id, r.data, true); });
        return { docs: docs, size: docs.length, empty: !docs.length, forEach: function (fn) { docs.forEach(fn); } };
      });
    }
    return {
      doc: function (id) { return docRef(path + "/" + (id || autoId())); },
      where: function (f, op, v) { return next({ where: (q.where || []).concat([[f, op, v]]) }); },
      orderBy: function (f, dir) { return next({ order: [f, dir || "asc"] }); },
      limit: function (n) { return next({ limit: n }); },
      get: run,
      // Pas de temps réel : on relit toutes les 30 s et quand l'écran redevient visible.
      onSnapshot: function (cb, errCb) {
        var stopped = false;
        function tick() { if (stopped) return; run().then(cb, function (e) { if (errCb) errCb(e); }); }
        tick();
        var timer = setInterval(function () { if (!document.hidden) tick(); }, 30000);
        var onVis = function () { if (!document.hidden) tick(); };
        document.addEventListener("visibilitychange", onVis);
        return function () { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVis); };
      }
    };
  }

  window.claude = {
    use: function (name) {
      if (name === "db") return Promise.resolve({ collection: function (p) { return colRef(p); } });
      if (name === "user") return Promise.resolve({ id: function () { return Promise.resolve("me"); } });
      var e = new Error("not available outside claude.ai"); e.code = "not_declared";
      return Promise.reject(e);
    }
  };
  if (!token()) { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", showLock); else showLock(); }
})();
