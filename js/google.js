// Google sign-in (Google Identity Services token model) and Drive app-folder storage.
(() => {
'use strict';
const C = window.GID_CONFIG;
let token = null, tokenExp = 0, client = null, waiters = [], profile = null;
const G = window.GID = {
  ready: false, signedIn: false, email: null, onChange: () => {},
  init(){
    if (!window.google || !google.accounts || !google.accounts.oauth2) return false;
    client = google.accounts.oauth2.initTokenClient({
      client_id: C.clientId, scope: C.scopes, include_granted_scopes: true,
      callback: r => {
        if (r.error) { waiters.splice(0).forEach(w => w.reject(new Error(r.error))); return; }
        token = r.access_token; tokenExp = Date.now() + (r.expires_in - 60) * 1000;
        try { sessionStorage.setItem('gid-tok', JSON.stringify({token, tokenExp})); } catch (e) {}
        G.signedIn = true; try { localStorage.setItem('gid-was-signed-in', '1'); } catch (e) {}
        waiters.splice(0).forEach(w => w.resolve(token)); G.onChange();
      },
      error_callback: e => { waiters.splice(0).forEach(w => w.reject(new Error(e.type || 'popup_closed'))); }
    });
    try { const s = JSON.parse(sessionStorage.getItem('gid-tok') || 'null'); if (s && s.tokenExp > Date.now()) { token = s.token; tokenExp = s.tokenExp; G.signedIn = true; } } catch (e) {}
    G.ready = true; return true;
  },
  wasSignedIn(){ try { return localStorage.getItem('gid-was-signed-in') === '1'; } catch (e) { return false; } },
  signIn(prompt){
    return new Promise((resolve, reject) => {
      if (!client) return reject(new Error('Google sign-in did not load. Check your internet connection.'));
      waiters.push({resolve, reject});
      client.requestAccessToken({prompt: prompt === undefined ? '' : prompt});
    });
  },
  signOut(){
    if (token && window.google) google.accounts.oauth2.revoke(token, () => {});
    token = null; tokenExp = 0; G.signedIn = false; G.email = null;
    try { sessionStorage.removeItem('gid-tok'); localStorage.removeItem('gid-was-signed-in'); } catch (e) {}
    G.onChange();
  },
  async tok(){
    if (token && Date.now() < tokenExp) return token;
    if (!G.signedIn) throw new Error('not signed in');
    return G.signIn('');
  },
  async api(url, opts = {}){
    const t = await G.tok();
    const r = await fetch(url, Object.assign({}, opts, {headers: Object.assign({Authorization: 'Bearer ' + t}, opts.headers || {})}));
    if (r.status === 401) { token = null; tokenExp = 0; const t2 = await G.signIn(''); const r2 = await fetch(url, Object.assign({}, opts, {headers: Object.assign({Authorization: 'Bearer ' + t2}, opts.headers || {})})); if (!r2.ok) throw new Error('Google ' + r2.status); return r2; }
    if (!r.ok) throw new Error('Google ' + r.status + ': ' + (await r.text()).slice(0, 200));
    return r;
  },
  async whoami(){
    if (G.email) return G.email;
    try { const r = await G.api('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)'); const j = await r.json(); G.email = j.user.emailAddress; profile = j.user; } catch (e) {}
    return G.email;
  },
  // ---- Drive app folder ----
  async findFile(){
    const q = encodeURIComponent(`name='${C.dataFile}'`);
    const r = await G.api(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime,version)`);
    const j = await r.json(); return j.files && j.files[0] || null;
  },
  async readFile(id){ const r = await G.api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`); return r.json(); },
  async writeFile(id, data){
    const body = JSON.stringify(data);
    if (id) {
      const r = await G.api(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&fields=id,modifiedTime,version`, {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body});
      return r.json();
    }
    const b = 'gid' + Math.random().toString(36).slice(2);
    const multi = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({name: C.dataFile, parents: ['appDataFolder']})}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`;
    const r = await G.api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime,version', {method: 'POST', headers: {'Content-Type': 'multipart/related; boundary=' + b}, body: multi});
    return r.json();
  }
};
})();
