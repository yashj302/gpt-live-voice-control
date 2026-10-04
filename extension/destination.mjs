const SITE_ALIASES = {
  gmail: 'https://mail.google.com/',
  google: 'https://www.google.com/',
  youtube: 'https://www.youtube.com/',
  github: 'https://github.com/',
  maps: 'https://maps.google.com/',
  drive: 'https://drive.google.com/',
  docs: 'https://docs.google.com/',
  calendar: 'https://calendar.google.com/',
  chatgpt: 'https://chatgpt.com/',
  amazon: 'https://www.amazon.com/',
  wikipedia: 'https://www.wikipedia.org/',
  reddit: 'https://www.reddit.com/',
  netflix: 'https://www.netflix.com/',
  linkedin: 'https://www.linkedin.com/',
  stackoverflow: 'https://stackoverflow.com/',
  twitter: 'https://x.com/',
  x: 'https://x.com/'
};

export function resolveDestination(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Say a website, a URL, or what to search for.');
  const alias = SITE_ALIASES[raw.toLowerCase().replace(/^(?:https?:\/\/)?(?:www\.)?/, '').replace(/\/$/, '')];
  if (alias) return alias;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Navigation is limited to HTTP and HTTPS URLs.');
    }
    return url.href;
  }
  if (/^[\w.-]+\.[a-z]{2,}([/?#].*)?$/i.test(raw)) return new URL(`https://${raw}`).href;
  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
}
