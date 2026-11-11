// Managed requests never accept caller-supplied authentication fields.
const AUTH_FIELDS = new Set(['accesstoken','refreshtoken','idtoken','token','apikey','clientsecret','password','passwd','authorization','credential','credentials','authtoken','secretkey','apisecret','xapikey','xaccesstoken','oauthtoken','jwt','accesskey','privatekey','authkey','sessiontoken','secret','bearer','signature','sig','auth']);
function authField(name: string): boolean {
  return name.split(/[.\[\]]/).some(part=>AUTH_FIELDS.has(part.toLowerCase().replace(/[^a-z]/g,'')));
}
export function checkManagedJson(value: unknown, seen = new WeakSet<object>(), depth=0): void {
  if (depth>32) throw new Error('composio: request body is too complex');
  if (value===null || typeof value!=='object') return;
  if (seen.has(value)) throw new Error('composio: cyclic request body refused');
  seen.add(value);
  for (const [key,child] of Object.entries(value)) {
    if (authField(key)) throw new Error('composio: credentials in request bodies are refused');
    checkManagedJson(child,seen,depth+1);
  }
  seen.delete(value);
}
export function checkManagedForm(entries: Iterable<[string,string]>): void {
  for (const [key] of entries) if (authField(key)) throw new Error('composio: credentials in request bodies are refused');
}
export function checkManagedBytes(bytes: Uint8Array, contentType: string): void {
  if (/json/i.test(contentType)) {
    let parsed:unknown;
    try { parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
    catch { throw new Error('composio: malformed JSON body refused'); }
    checkManagedJson(parsed);
  } else if (/^application\/x-www-form-urlencoded(?:;|$)/i.test(contentType)) {
    checkManagedForm(new URLSearchParams(new TextDecoder().decode(bytes)));
  } else if (/^multipart\/form-data(?:;|$)/i.test(contentType)) {
    const boundary = /(?:^|;)\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(contentType);
    if (!boundary) throw new Error('composio: multipart boundary required');
    for (const part of Buffer.from(bytes).toString('latin1').split(`--${boundary[1]??boundary[2]}`).slice(1)) {
      const end=part.indexOf('\r\n\r\n'); if(end<0) continue;
      const headers=part.slice(0,end).replace(/\r\n[ \t]+/g,' ');
      const disposition=/^content-disposition:([^\r\n]*)/im.exec(headers)?.[1];
      if (!disposition || /;\s*name\s*\*/i.test(disposition)) throw new Error('composio: ambiguous multipart field refused');
      const names=[...disposition.matchAll(/;\s*name\s*=\s*(?:"([^"\r\n]*)"|([^;\s\r\n]+))/gi)].map(m=>m[1]??m[2]);
      if(names.some(authField)) throw new Error('composio: credentials in request bodies are refused');
      if(names.length!==1) throw new Error('composio: ambiguous multipart field refused');
    }
  }
}
