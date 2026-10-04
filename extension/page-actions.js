(() => {
  const INTERACTIVE_SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="listbox"]',
    '[role="textbox"]',
    '[role="searchbox"]',
    '[contenteditable="true"]',
    '[onclick]',
    '[tabindex="0"]'
  ].join(',');

  function walkElements(root, visit, depth = 0) {
    if (!root || depth > 6) return;
    const scope = root.querySelectorAll ? root : root.documentElement;
    if (!scope?.querySelectorAll) return;
    for (const element of scope.querySelectorAll('*')) {
      visit(element);
      if (element.shadowRoot) walkElements(element.shadowRoot, visit, depth + 1);
    }
  }

  function normalize(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function cleanText(value, limit = 80) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function isVisible(element) {
    if (!element || element.disabled || element.getAttribute('aria-hidden') === 'true') return false;
    if (element.getAttribute('aria-disabled') === 'true') return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2;
  }

  function inTopFrame() {
    try { return window.top === window; } catch { return false; }
  }

  function inputType(element) {
    return (element.getAttribute('type') || '').toLowerCase();
  }

  function kindOf(element) {
    const type = inputType(element);
    const role = element.getAttribute('role');
    if (element.tagName === 'SELECT') return 'select';
    if (type === 'checkbox' || role === 'checkbox' || role === 'switch') return 'checkbox';
    if (type === 'radio' || role === 'radio') return 'radio';
    if (type === 'file') return 'file';
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'click';
    if (element.matches('textarea, input, [contenteditable="true"], [role="textbox"], [role="searchbox"]')) return 'text';
    return 'click';
  }

  function roleOf(element) {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const kind = kindOf(element);
    if (kind === 'select') return 'combobox';
    if (kind === 'checkbox') return 'checkbox';
    if (kind === 'radio') return 'radio';
    if (kind === 'text') return inputType(element) === 'search' ? 'searchbox' : 'textbox';
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    return tag;
  }

  function accessibleName(element) {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/)
        .map(id => document.getElementById(id)?.innerText || '')
        .filter(Boolean)
        .join(' ');
      if (text.trim()) return cleanText(text);
    }
    const aria = element.getAttribute('aria-label');
    if (aria) return cleanText(aria);
    if (element.labels?.length) {
      const text = Array.from(element.labels).map(label => {
        const clone = label.cloneNode(true);
        clone.querySelectorAll('input, textarea, select, button').forEach(control => control.remove());
        return clone.innerText || clone.textContent || '';
      }).join(' ');
      if (text.trim()) return cleanText(text);
    }
    for (const attribute of ['placeholder', 'title', 'alt']) {
      const value = element.getAttribute(attribute);
      if (value) return cleanText(value);
    }
    if (element.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(inputType(element))) {
      return cleanText(element.value);
    }
    const text = cleanText(element.innerText || element.textContent || '');
    if (text) return text;
    return cleanText(element.getAttribute('name') || '');
  }

  function scoreText(name, query) {
    const left = normalize(name);
    const right = normalize(query);
    if (!left || !right) return 0;
    if (left === right) return 100;
    if (left.startsWith(right)) return 88;
    if (left.includes(right)) return 76;
    const words = right.split(' ').filter(Boolean);
    const hits = words.filter(word => left.includes(word)).length;
    if (!hits) return 0;
    return Math.round(48 * hits / words.length);
  }

  function stamp(element) {
    if (!element.dataset.gptRef) {
      const next = Number(document.documentElement.dataset.gptLiveSeq || 0) + 1;
      document.documentElement.dataset.gptLiveSeq = String(next);
      element.dataset.gptRef = `e${next}`;
    }
    return element.dataset.gptRef;
  }

  function findByRef(ref) {
    const wanted = String(ref || '').toLowerCase();
    let found = null;
    walkElements(document, element => {
      if (!found && element.dataset?.gptRef === wanted) found = element;
    });
    return found;
  }

  function descriptor(element) {
    return [
      accessibleName(element),
      element.getAttribute('placeholder'),
      element.getAttribute('name'),
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      inputType(element)
    ].filter(Boolean).join(' ');
  }

  function destinationUrl(element) {
    const anchor = element.matches?.('a[href]') ? element : element.closest?.('a[href]');
    if (!anchor) return null;
    try {
      const url = new URL(anchor.href, location.href);
      if ((/(^|\.)google\./.test(url.hostname) && url.pathname === '/url') || (url.hostname.endsWith('bing.com') && url.pathname === '/ck/a')) {
        const target = url.searchParams.get('q') || url.searchParams.get('url') || url.searchParams.get('u');
        if (target) return new URL(target);
      }
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      return url;
    } catch {
      return null;
    }
  }

  function navigableHref(element) {
    const url = destinationUrl(element);
    if (!url) return undefined;
    if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search) return undefined;
    return url.href;
  }

  function hostOf(element) {
    return destinationUrl(element)?.hostname.replace(/^www\./, '') || '';
  }

  function isSearchHost(host) {
    return /(^|\.)google\./.test(host) || /(^|\.)bing\.com$/.test(host) || host.endsWith('duckduckgo.com') || host === 'search.yahoo.com';
  }

  function resultLinks() {
    const searchPage = isSearchHost(location.hostname.replace(/^www\./, '')) || Boolean(document.querySelector('#rso, #b_results, #links'));
    const scope = document.querySelector('#rso, #b_results, #links') || document.querySelector('main') || document.body;
    const heading = [];
    const other = [];
    const seen = new Set();
    walkElements(scope, element => {
      if (!element.matches?.('a[href]') || !isVisible(element) || element.closest('nav, header, footer, [role="navigation"]')) return;
      const url = destinationUrl(element);
      if (!url || seen.has(url.href)) return;
      const host = url.hostname.replace(/^www\./, '');
      if (searchPage && (isSearchHost(host) || host === location.hostname.replace(/^www\./, ''))) return;
      seen.add(url.href);
      (element.querySelector('h3') || element.closest('h3') ? heading : other).push(element);
    });
    const list = heading.length ? heading : other;
    return list.sort((first, second) => first.getBoundingClientRect().top - second.getBoundingClientRect().top
      || first.getBoundingClientRect().left - second.getBoundingClientRect().left);
  }

  function ordinalIndex(query) {
    const text = normalize(query);
    if (!/\b(link|links|result|results|site|sites|website|websites|one|item)\b/.test(text)) return null;
    const ordinals = {
      first: 1, '1st': 1, top: 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4,
      fifth: 5, '5th': 5, sixth: 6, '6th': 6, seventh: 7, '7th': 7, eighth: 8, '8th': 8,
      ninth: 9, '9th': 9, tenth: 10, '10th': 10
    };
    const named = text.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th|top)\b/);
    if (named) return ordinals[named[1]];
    const numeric = text.match(/\b(?:number\s+)?(\d+)\b/);
    return numeric ? Number(numeric[1]) : null;
  }

  function domainQuery(query) {
    const candidate = String(query || '').trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split(/[\s/]/)[0];
    return /^[\w.-]+\.[a-z]{2,}$/.test(candidate) ? candidate : '';
  }

  function snapshot(element, score = 0) {
    const rect = element.getBoundingClientRect();
    const kind = kindOf(element);
    const sensitive = inputType(element) === 'password' || element.getAttribute('autocomplete') === 'current-password';
    const value = kind === 'text' || kind === 'select'
      ? cleanText(element.isContentEditable ? element.textContent : element.value, 60)
      : undefined;
    return {
      ok: true,
      ref: stamp(element),
      name: accessibleName(element) || kind,
      role: roleOf(element),
      kind,
      href: navigableHref(element),
      type: inputType(element) || undefined,
      score,
      sensitive,
      value: sensitive ? undefined : value,
      checked: kind === 'checkbox' || kind === 'radio' ? Boolean(element.checked || element.getAttribute('aria-checked') === 'true') : undefined,
      options: kind === 'select'
        ? Array.from(element.options || []).map(option => cleanText(option.text, 40)).filter(Boolean).slice(0, 12)
        : undefined,
      inView: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth,
      isTop: inTopFrame(),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }

  function collectInteractive() {
    const elements = [];
    const seen = new Set();
    walkElements(document, element => {
      if (seen.has(element) || !element.matches?.(INTERACTIVE_SELECTOR) || !isVisible(element)) return;
      if (element.matches('label') && element.querySelector('input, textarea, select, button')) return;
      const kind = kindOf(element);
      const name = accessibleName(element);
      if (!name && kind === 'click') return;
      seen.add(element);
      elements.push(element);
    });
    return elements;
  }

  function describe(payload = {}) {
    const limit = Math.max(1, Math.min(Number(payload.limit) || 40, 60));
    const elements = collectInteractive()
      .map(element => snapshot(element))
      .sort((first, second) => Number(second.inView) - Number(first.inView));
    return {
      ok: true,
      title: cleanText(document.title, 120),
      url: location.href,
      elements: elements.slice(0, limit).map(({ score, rect, isTop, ...element }) => element)
    };
  }

  function bareRef(value) {
    return String(value || '').trim().replace(/^\d+:/, '').toLowerCase();
  }

  function scoreElement(element, payload) {
    const query = payload.label || payload.target || '';
    const ref = bareRef(payload.ref);
    const queryRef = bareRef(query);
    if (ref && /^e\d+$/.test(ref) && element.dataset.gptRef === ref) return 1000;
    if (/^e\d+$/.test(queryRef) && element.dataset.gptRef === queryRef) return 1000;
    let score = Math.max(
      scoreText(accessibleName(element), query),
      scoreText(element.getAttribute('placeholder'), query),
      scoreText(element.getAttribute('aria-label'), query),
      scoreText(element.getAttribute('title'), query) - 4,
      scoreText(element.getAttribute('name'), query) - 8
    );
    const kind = kindOf(element);
    const wantedHost = domainQuery(query);
    if (wantedHost && (hostOf(element) === wantedHost || hostOf(element).endsWith(`.${wantedHost}`))) score = Math.max(score, 98);
    if (payload.preferEditable && !['text', 'select', 'checkbox', 'radio'].includes(kind)) return 0;
    if (payload.preferButtons && kind !== 'click') score -= 20;
    if (payload.prefer === 'search' && /search|query|find/.test(normalize(descriptor(element)))) score += 24;
    if (payload.kind && payload.kind !== kind) score -= 30;
    return score;
  }

  function resolve(payload = {}) {
    const query = payload.ref || payload.label || payload.target || '';
    const ordinal = ordinalIndex(query);
    if (ordinal) {
      const links = resultLinks();
      const chosen = links[ordinal - 1];
      if (!chosen) {
        return { ok: false, error: `This page has ${links.length} result links, so link ${ordinal} is not there.` };
      }
      return focusAndMeasure(chosen, 1000);
    }
    if (!String(query).trim() && payload.preferEditable) {
      const active = document.activeElement;
      if (active && isVisible(active) && ['text', 'select'].includes(kindOf(active))) {
        return focusAndMeasure(active, 90);
      }
      const fields = collectInteractive().filter(element => ['text', 'select'].includes(kindOf(element)));
      if (fields.length === 1) return focusAndMeasure(fields[0], 80);
      if (fields.length > 1) {
        return {
          ok: false,
          ambiguous: true,
          error: 'Several fields are visible. Say which one to use.',
          candidates: fields.slice(0, 5).map(element => ({
            ref: stamp(element),
            name: accessibleName(element) || kindOf(element),
            role: roleOf(element)
          }))
        };
      }
    }
    const ranked = collectInteractive()
      .map(element => ({ element, score: scoreElement(element, payload) }))
      .filter(item => item.score >= 40)
      .sort((first, second) => second.score - first.score);
    if (!ranked.length) {
      const candidates = collectInteractive().slice(0, 8).map(element => ({
        ref: stamp(element),
        name: accessibleName(element),
        role: roleOf(element)
      }));
      return { ok: false, error: `Could not find "${query}" on this page.`, candidates };
    }
    const wantedHost = domainQuery(query);
    if (wantedHost) {
      const hostMatches = ranked
        .filter(item => hostOf(item.element) === wantedHost || hostOf(item.element).endsWith(`.${wantedHost}`))
        .sort((first, second) => first.element.getBoundingClientRect().top - second.element.getBoundingClientRect().top);
      if (hostMatches[0]) return focusAndMeasure(hostMatches[0].element, hostMatches[0].score);
    }
    const [best, second] = ranked;
    const ambiguous = second
      && best.score < 1000
      && second.score >= 70
      && best.score - second.score < 12;
    if (ambiguous) {
      return {
        ok: false,
        ambiguous: true,
        error: `Several controls match "${query}".`,
        candidates: ranked.slice(0, 5).map(item => ({
          ref: stamp(item.element),
          name: accessibleName(item.element),
          role: roleOf(item.element)
        }))
      };
    }
    return focusAndMeasure(best.element, best.score);
  }

  function focusAndMeasure(element, score) {
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    return snapshot(element, score);
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function setValue(payload = {}) {
    const target = payload.ref ? resolve({ ref: payload.ref }) : resolve({
      label: payload.target || payload.label,
      preferEditable: true,
      kind: payload.kind
    });
    if (!target.ok) return target;
    const element = findByRef(target.ref);
    if (!element) return { ok: false, error: 'The field disappeared before it could be edited.' };
    const value = payload.value == null ? '' : String(payload.value);
    const kind = kindOf(element);
    if (kind === 'file') {
      return { ok: false, error: 'File uploads need to be chosen manually in the file dialog.' };
    }
    if (kind === 'select') {
      const wanted = normalize(value);
      const option = Array.from(element.options || []).find(item => {
        const text = normalize(item.text);
        const optionValue = normalize(item.value);
        return text === wanted || optionValue === wanted || text.includes(wanted) || optionValue.includes(wanted);
      });
      if (!option) {
        return {
          ok: false,
          error: `Could not find option "${value}".`,
          options: Array.from(element.options || []).map(item => item.text.trim()).slice(0, 12)
        };
      }
      element.value = option.value;
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return { ok: true, field: target.name, value: option.text.trim(), kind };
    }
    if (kind === 'checkbox' || kind === 'radio') {
      const shouldCheck = payload.checked != null
        ? Boolean(payload.checked)
        : !/^(false|no|off|unchecked)$/i.test(value);
      const checked = Boolean(element.checked || element.getAttribute('aria-checked') === 'true');
      if (checked !== shouldCheck) element.click();
      return { ok: true, field: target.name, checked: shouldCheck, kind };
    }
    element.focus();
    if (element.isContentEditable) {
      element.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand('insertText', false, value)) element.textContent = value;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    } else {
      setNativeValue(element, value);
    }
    return {
      ok: true,
      field: target.name,
      kind,
      entered: target.sensitive ? '[hidden]' : value
    };
  }

  function activate(payload = {}) {
    const target = resolve(payload);
    if (!target.ok) return target;
    const element = findByRef(target.ref);
    if (!element) return { ok: false, error: 'The control disappeared before it could be clicked.' };
    element.focus?.();
    element.click();
    return { ok: true, clicked: target.name, role: target.role, ref: target.ref, method: 'dom' };
  }

  function focusedMatches(payload = {}) {
    const element = findByRef(payload.ref);
    const active = document.activeElement;
    const matches = Boolean(element && active && (active === element || element.contains(active)));
    return { ok: matches };
  }

  function scrollingElement() {
    const root = document.scrollingElement || document.documentElement;
    if (root.scrollHeight > root.clientHeight + 40) return root;
    let best = root;
    let bestRoom = 0;
    walkElements(document, element => {
      const style = getComputedStyle(element);
      if (!/auto|scroll/.test(`${style.overflowY} ${style.overflow}`)) return;
      const room = element.scrollHeight - element.clientHeight;
      if (room > bestRoom && element.clientHeight > 80) {
        best = element;
        bestRoom = room;
      }
    });
    return best;
  }

  function scrollPage(payload = {}) {
    const direction = String(payload.direction || 'down').toLowerCase();
    const amount = Number(payload.amount) > 0 ? Number(payload.amount) : Math.max(window.innerHeight * 0.8, 400);
    const root = scrollingElement();
    if (direction === 'top') root.scrollTo({ top: 0, behavior: 'auto' });
    else if (direction === 'bottom') root.scrollTo({ top: root.scrollHeight, behavior: 'auto' });
    else if (direction === 'up' || direction === 'down') root.scrollBy({ top: direction === 'up' ? -amount : amount, behavior: 'auto' });
    else return { ok: false, error: `Unsupported scroll direction: ${direction}` };
    return { ok: true, direction, amount, y: root.scrollTop };
  }

  function dispatchKey(payload = {}) {
    const element = (payload.ref && findByRef(payload.ref)) || document.activeElement || document.body;
    const key = payload.key || 'Enter';
    const code = payload.code || key;
    const eventInit = { key, code, bubbles: true, cancelable: true, composed: true };
    element.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    element.dispatchEvent(new KeyboardEvent('keyup', eventInit));
    if (key === 'Enter' && element.form?.requestSubmit) element.form.requestSubmit();
    return { ok: true, key };
  }

  function submitTarget(payload = {}) {
    if (payload.label) return resolve({ label: payload.label, preferButtons: true });
    const nativeSubmit = Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"]')).find(isVisible);
    if (nativeSubmit) return focusAndMeasure(nativeSubmit, 100);
    for (const label of ['submit', 'send', 'search', 'continue', 'save']) {
      const match = resolve({ label, preferButtons: true });
      if (match.ok && match.score >= 100) return match;
    }
    return { ok: false, error: 'Could not find a submit button.' };
  }

  globalThis.gptLiveActions = {
    describe,
    resolve,
    setValue,
    activate,
    focusedMatches,
    scrollPage,
    submitTarget,
    dispatchKey
  };
})();
