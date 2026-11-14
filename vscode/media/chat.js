(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const messages = $('messages');
  const input = $('input');
  const form = $('composer');
  const stopBtn = $('stop');
  const sendBtn = $('send');
  const planEl = $('plan');
  const statusEl = $('status');
  const orchestrate = $('orchestrate');
  const best3 = $('best3');
  const working = $('working');
  const modelSel = $('model');
  const fileInput = $('file');
  const attachBtn = $('attach');
  const attachEl = $('attachments');
  let attached = [];

  function renderAttachments() {
    attachEl.hidden = !attached.length;
    attachEl.innerHTML = attached.map((a, i) => `<span class="chip">${esc(a.name)} <button type="button" class="remove" data-i="${i}" aria-label="Remover ${esc(a.name)}">×</button></span>`).join('');
  }

  function attach(files) {
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        attached.push({ name: file.name || 'print.png', mime: file.type, data: String(reader.result).split(',')[1] ?? '' });
        renderAttachments();
      };
      reader.readAsDataURL(file);
    }
  }


  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  const REF = /(^|[\s(\[>,;:])((?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z][\w]{0,5}):(\d+)(?:-(\d+))?/g;
  const linkRefs = (html) =>
    html.replace(REF, (_, pre, file, line, end) => `${pre}<a class="ref" href="#" data-file="${file}" data-line="${line}">${file}:${line}${end ? `-${end}` : ''}</a>`);

  function inline(raw) {
    return esc(raw)
      .split(/(`[^`]+`)/g)
      .map((part) => {
        if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return `<code>${linkRefs(part.slice(1, -1))}</code>`;
        return linkRefs(
          part
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>'),
        );
      })
      .join('');
  }

  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  function markdown(src) {
    const lines = src.replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*```(\S*)/);
      if (fence) {
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        html += `<pre>${fence[1] ? `<span class="lang">${esc(fence[1])}</span>` : ''}<code>${esc(buf.join('\n'))}</code></pre>`;
        continue;
      }
      if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
        html += `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`;
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*)/);
      if (heading) {
        const level = Math.min(heading[1].length + 2, 6);
        html += `<h${level}>${inline(heading[2])}</h${level}>`;
        i++;
        continue;
      }
      const listKind = /^\s*[-*+]\s+/.test(line) ? 'ul' : /^\s*\d+[.)]\s+/.test(line) ? 'ol' : null;
      if (listKind) {
        const items = [];
        const marker = listKind === 'ul' ? /^\s*[-*+]\s+/ : /^\s*\d+[.)]\s+/;
        while (i < lines.length && marker.test(lines[i])) {
          let item = lines[i++].replace(marker, '');
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !marker.test(lines[i])) item += ' ' + lines[i++].trim();
          items.push(`<li>${inline(item)}</li>`);
        }
        html += `<${listKind}>${items.join('')}</${listKind}>`;
        continue;
      }
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        html += `<blockquote>${inline(buf.join(' '))}</blockquote>`;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        html += '<hr>';
        i++;
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(lines[i]) && !isTableRow(lines[i])) para.push(lines[i++]);
      if (!para.length) para.push(lines[i++]);
      html += `<p>${para.map(inline).join('<br>')}</p>`;
    }
    return html;
  }

  const ALIEN =
    '<svg class="alien" viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" fill="currentColor" d="M8 16L3.54223 12.3383C1.93278 11.0162 1 9.04287 1 6.96005C1 3.11612 4.15607 0 8 0C11.8439 0 15 3.11612 15 6.96005C15 9.04287 14.0672 11.0162 12.4578 12.3383L8 16ZM3 6H5C6.10457 6 7 6.89543 7 8V9L3 7.5V6ZM11 6C9.89543 6 9 6.89543 9 8V9L13 7.5V6H11Z"/></svg>';
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let words = ['Pensando'];
  let work = null;

  const pick = () => words[Math.floor(Math.random() * words.length)];
  const seconds = (w) => Math.max(1, Math.round((Date.now() - w.started) / 1000));
  const toolCount = (w) => (w.tools ? ` · ${w.tools} ${w.tools === 1 ? 'ferramenta' : 'ferramentas'}` : '');
  const compact = (n) => n.toLocaleString('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });

  let stick = true;
  messages.addEventListener('scroll', () => {
    stick = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
  });

  function scroll() {
    if (stick) messages.scrollTop = messages.scrollHeight;
  }

  const append = (el) => messages.insertBefore(el, working);
  const clearMessages = () => {
    for (const el of [...messages.children]) if (el !== working) el.remove();
  };

  function add(className, html, parent = messages) {
    const el = document.createElement('div');
    el.className = className;
    el.innerHTML = html;
    if (parent === messages) append(el);
    else parent.appendChild(el);
    scroll();
    return el;
  }

  const CARET = '<span class="caret"></span>';
  const withCaret = (html) => (/<\/[a-z0-9]+>\s*$/i.test(html) ? html.replace(/(<\/[a-z0-9]+>)\s*$/i, `${CARET}$1`) : html + CARET);

  function typer(el, render) {
    const t = { el, render, target: '', shown: 0, raf: 0, open: true };
    const tick = () => {
      const backlog = t.target.length - t.shown;
      t.shown = Math.min(t.target.length, t.shown + Math.max(2, Math.ceil(backlog / 6)));
      const html = render(t.target.slice(0, t.shown));
      t.el.innerHTML = t.open ? withCaret(html) : html;
      scroll();
      t.raf = t.shown < t.target.length ? requestAnimationFrame(tick) : 0;
    };
    t.feed = (delta) => {
      t.target += delta;
      if (!t.raf) t.raf = requestAnimationFrame(tick);
    };
    t.close = () => {
      cancelAnimationFrame(t.raf);
      t.raf = 0;
      t.open = false;
      t.shown = t.target.length;
      t.el.innerHTML = render(t.target);
    };
    return t;
  }

  function startWork() {
    if (work) return work;
    const el = document.createElement('div');
    el.className = 'timeline';
    append(el);
    working.innerHTML = `${ALIEN}<span class="verb"></span><span class="meta"></span>`;
    working.hidden = false;
    working.classList.remove('idle');
    work = {
      el,
      body: el,
      verb: working.querySelector('.verb'),
      meta: working.querySelector('.meta'),

      started: Date.now(),
      tools: 0,
      tokens: '',
      tick: 0,
      text: null,
      think: null,
      lastTool: null,
    };
    const w = work;
    const paint = () => {
      if (w.tick % 4 === 0) typeVerb(w, `${pick()}…`);
      w.meta.textContent = `(${seconds(w)}s${toolCount(w)}${w.tokens})`;
      w.tick++;
    };
    paint();
    w.timer = setInterval(paint, 1000);
    scroll();
    return w;
  }

  function typeVerb(w, word) {
    clearInterval(w.verbTimer);
    if (still) {
      w.verb.textContent = word;
      return;
    }
    let shown = 0;
    w.verb.innerHTML = '<span class="caret"></span>';
    w.verbTimer = setInterval(() => {
      w.verb.innerHTML = `${esc(word.slice(0, ++shown))}<span class="caret"></span>`;
      if (shown < word.length) return;
      clearInterval(w.verbTimer);
      w.verb.textContent = word;
    }, 70);
  }

  function endThinking() {
    const w = work;
    if (!w?.think) return;
    w.think.typer.close();
    const secs = Math.max(1, Math.round((Date.now() - w.think.started) / 1000));
    w.think.label.textContent = `Pensou por ${secs}s`;
    w.think.el.classList.remove('live');
    w.think.el.open = false;
    w.think = null;
  }

  function endThought() {
    const w = work;
    if (!w) return;
    endThinking();
    if (w.text) {
      w.text.typer.close();
      w.text = null;
    }
  }

  const thinkingNow = (on) => working.classList.toggle('idle', !on);

  function finishWork(state) {
    const w = work;
    if (!w) return;
    endThought();
    work = null;
    clearInterval(w.timer);
    clearInterval(w.verbTimer);
    working.hidden = true;
    working.innerHTML = '';
    if (!w.el.children.length) w.el.remove();
    else if (state !== 'done') add('item notice warn', `Interrompido após ${seconds(w)}s`, w.el);
  }

  function thinkingDelta(delta) {
    const w = startWork();
    if (w.text) {
      w.text.typer.close();
      w.text = null;
    }
    if (!w.think) {
      const el = document.createElement('details');
      el.className = 'item thinking live';
      el.innerHTML = '<summary><span class="label">Pensando…</span><span class="count"></span></summary><div class="think-body"></div>';
      w.el.appendChild(el);
      w.think = { el, label: el.querySelector('.label'), count: el.querySelector('.count'), chars: 0, started: Date.now(), typer: typer(el.querySelector('.think-body'), markdown) };
    }
    w.think.chars += delta.length;
    w.think.count.textContent = ` · ${compact(Math.ceil(w.think.chars / 4))} tokens`;
    w.think.typer.feed(delta);
  }

  function textDelta(delta) {
    const w = startWork();
    endThinking();
    if (!w.text) {
      const el = add('item text', '', w.el);
      w.text = { el, raw: '', typer: typer(el, markdown) };
    }
    w.text.raw += delta;
    w.text.typer.feed(delta);
  }

  const target = () => (work ? work.body : messages);
  const agentTag = (agent) => (agent ? `<span class="agent">${esc(agent)}</span>` : '');

  function renderPlan(items) {
    if (!items.length) {
      planEl.hidden = true;
      return;
    }
    const icon = { pending: '○', in_progress: '◐', done: '●' };
    planEl.hidden = false;
    planEl.innerHTML = `<div class="plan-title">Plano</div>${items
      .map((it) => `<div class="plan-item ${it.status}">${icon[it.status] ?? '○'} ${inline(it.step)}</div>`)
      .join('')}`;
  }

  function showAnswer(text) {
    const w = work;
    if (w?.text && w.text.raw.trim() === String(text).trim()) {
      w.text.typer.close();
      w.text.el.remove();
      w.text = null;
    }
    finishWork('done');
    add('msg assistant', markdown(text));
  }

  function setBusy(busy) {
    stopBtn.hidden = !busy;
    modelSel.disabled = busy;
    if (busy) startWork();
    else finishWork('stopped');
  }

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'skills':
        skills = Array.isArray(m.skills) ? m.skills : [];
        break;
      case 'words':
        if (Array.isArray(m.words) && m.words.length) words = m.words;
        break;
      case 'text':
        textDelta(m.delta);
        thinkingNow(false);
        break;
      case 'thinking':
        if (m.delta) thinkingDelta(m.delta);
        else startWork();
        thinkingNow(true);
        break;
      case 'tokens':
        if (work && m.input + m.output) work.tokens = ` · ↑ ${compact(m.input)} ↓ ${compact(m.output)} tokens`;
        break;
      case 'tool': {
        const w = startWork();
        endThought();
        w.tools++;
        thinkingNow(false);
        w.lastTool = add(`item tool${m.agent ? ' sub' : ''}`, `<div class="tool-head">${agentTag(m.agent)}<span class="tool-name">${esc(m.name)}</span> <span class="tool-args">${esc(m.args)}</span></div>`, w.body);
        break;
      }
      case 'observation': {
        const lines = String(m.output).trim().split('\n');
        const first = esc(lines[0].slice(0, 160));
        const more = lines.length > 1 ? ` <span class="muted">(+${lines.length - 1} linhas)</span>` : '';
        const details = document.createElement('details');
        details.className = `obs ${m.ok ? 'ok' : 'fail'}${m.agent ? ' sub' : ''}`;
        details.innerHTML = `<summary>${m.ok ? '✓' : '✗'} ${first}${more}</summary><pre><code>${linkRefs(esc(m.output))}</code></pre>`;
        (work?.lastTool ?? target()).appendChild(details);
        if (work) thinkingNow(true);
        scroll();
        break;
      }
      case 'plan':
        renderPlan(m.items);
        break;
      case 'phase':
        endThought();
        add(work ? 'item phase' : 'phase', esc(m.title), target());
        break;
      case 'info':
      case 'warn':
        endThought();
        add(`${work ? 'item ' : ''}notice ${m.type}${m.agent ? ' sub' : ''}`, `${agentTag(m.agent)}${inline(m.message)}`, target());
        break;
      case 'error':
        finishWork('stopped');
        add('notice error', inline(m.message));
        break;
      case 'answer':
      case 'final':
        showAnswer(m.text);
        break;
      case 'confirm': {
        const w = startWork();
        endThought();
        thinkingNow(false);
        const always = m.alwaysLabel ? `<button class="always secondary">Sempre: ${esc(m.alwaysLabel)}</button>` : '';
        const box = add(
          'item confirm',
          `${agentTag(m.agent)}<div class="question">${inline(m.question)}</div><div class="buttons"><button class="allow">Permitir</button>${always}<button class="deny secondary">Negar</button></div>`,
          w.body,
        );
        box.dataset.id = m.id;
        const LABEL = { yes: 'permitido', always: `permitido sempre nesta conversa (${esc(m.alwaysLabel ?? '')})`, no: 'negado' };
        const answer = (decision) => {
          vscode.postMessage({ type: 'confirmResult', id: m.id, decision });
          box.querySelector('.buttons').innerHTML = `<span class="muted">${LABEL[decision]}</span>`;
        };
        box.querySelector('.allow').addEventListener('click', () => answer('yes'));
        box.querySelector('.always')?.addEventListener('click', () => answer('always'));
        box.querySelector('.deny').addEventListener('click', () => answer('no'));
        break;
      }
      case 'confirmClosed': {
        const box = messages.querySelector(`.confirm[data-id="${m.id}"] .buttons`);
        if (box) box.innerHTML = '<span class="muted">cancelado</span>';
        break;
      }
      case 'busy':
        setBusy(m.value);
        break;
      case 'usage': {
        const cost = m.cost === null ? 'custo desconhecido' : m.cost === 0 ? 'US$ 0 (local)' : `~US$ ${m.cost.toFixed(4)}`;
        add('usage', `tokens na conversa: ${m.input.toLocaleString('pt-BR')} entrada · ${m.output.toLocaleString('pt-BR')} saída · ${cost}`);
        break;
      }
      case 'status':
        statusEl.textContent = m.text;
        break;
      case 'models':
        modelSel.innerHTML = m.models.map((name) => `<option value="${esc(name)}"${name === m.current ? ' selected' : ''}>${esc(name)}</option>`).join('');
        break;
      case 'restored':
        messages.querySelector('.welcome')?.remove();
        clearMessages();
        for (const turn of m.turns) {
          add('msg user', esc(turn.task).replace(/\n/g, '<br>'));
          add('msg assistant', markdown(turn.answer));
        }
        renderPlan(m.plan ?? []);
        add('notice info', `Conversa anterior restaurada (${esc(m.id)}). Continue de onde parou ou clique em Nova conversa.`);
        break;
      case 'cleared':
        finishWork('stopped');
        clearMessages();
        renderPlan([]);
        add('notice info', 'Nova conversa.');
        break;
    }
  });

  function send() {
    const text = input.value.trim();
    if (!text && !attached.length) return;
    messages.querySelector('.welcome')?.remove();
    stick = true;
    const names = attached.length ? `<div class="muted">📎 ${attached.map((a) => esc(a.name)).join(', ')}</div>` : '';
    if (work) endThought();
    add('msg user', esc(text).replace(/\n/g, '<br>') + names, work ? work.el : messages);
    vscode.postMessage({ type: 'send', text, orchestrate: orchestrate.checked, best3: best3.checked, attachments: attached });
    input.value = '';
    attached = [];
    renderAttachments();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  const slash = $('slash');
  let skills = [];
  let picks = [];
  let slashAt = 0;

  function renderSlash() {
    const m = /^\/([\w:.-]*)$/.exec(input.value);
    const q = m ? m[1].toLowerCase() : null;
    picks = q === null ? [] : skills.filter((s) => s.name.toLowerCase().includes(q));
    slash.hidden = !picks.length;
    slashAt = Math.min(slashAt, Math.max(picks.length - 1, 0));
    slash.innerHTML = picks
      .map((s, i) => `<div class="slash-item${i === slashAt ? ' on' : ''}" role="option" data-i="${i}"><b>/${esc(s.name)}</b> <span class="muted">${esc(s.description)}</span></div>`)
      .join('');
  }

  function choose(i) {
    input.value = `/${picks[i].name} `;
    picks = [];
    slash.hidden = true;
    input.focus();
  }

  input.addEventListener('input', renderSlash);
  slash.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.slash-item');
    if (!item) return;
    e.preventDefault();
    choose(Number(item.dataset.i));
  });
  input.addEventListener('keydown', (e) => {
    if (!slash.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        slashAt = (slashAt + (e.key === 'ArrowDown' ? 1 : picks.length - 1)) % picks.length;
        renderSlash();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        choose(slashAt);
        return;
      }
      if (e.key === 'Escape') {
        slash.hidden = true;
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    attach(fileInput.files);
    fileInput.value = '';
  });
  attachEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.remove');
    if (!btn) return;
    attached.splice(Number(btn.dataset.i), 1);
    renderAttachments();
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    attach(files);
  });
  form.addEventListener('dragover', (e) => e.preventDefault());
  form.addEventListener('drop', (e) => {
    e.preventDefault();
    attach(e.dataTransfer?.files ?? []);
  });
  modelSel.addEventListener('change', () => vscode.postMessage({ type: 'setModel', model: modelSel.value }));
  messages.addEventListener('click', (e) => {
    const ref = e.target.closest('a.ref');
    if (!ref) return;
    e.preventDefault();
    vscode.postMessage({ type: 'open', file: ref.dataset.file, line: Number(ref.dataset.line) });
  });

  vscode.postMessage({ type: 'ready' });
  input.focus();
})();
