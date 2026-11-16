'use strict';

const assistant = {
  history: [],
  busy: false
};
const ai = id => document.getElementById(id);
const ASSISTANT_API = location.hostname.endsWith('.github.io') ? 'https://dcs-trendweb.onrender.com' : '';

function appendInline(parent, text) {
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_)/g;
  let start = 0, match;
  while ((match = pattern.exec(text))) {
    parent.append(document.createTextNode(text.slice(start, match.index)));
    const token = match[0], content = token.slice(token.startsWith('**') || token.startsWith('__') ? 2 : 1, -(token.startsWith('**') || token.startsWith('__') ? 2 : 1));
    const element = document.createElement(token.startsWith('**') || token.startsWith('__') ? 'strong' : token.startsWith('`') ? 'code' : 'em');
    element.textContent = content;
    parent.append(element);
    start = pattern.lastIndex;
  }
  parent.append(document.createTextNode(text.slice(start)));
}

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function renderMarkdown(container, text) {
  const lines = text.replace(/\r/g, '').split('\n');
  let index = 0;
  const isTableRule = line => tableCells(line).length > 1 && tableCells(line).every(cell => /^:?-{3,}:?$/.test(cell));

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) { index++; continue; }

    if (index + 1 < lines.length && line.includes('|') && isTableRule(lines[index + 1])) {
      const wrapper = document.createElement('div');
      wrapper.className = 'ai-table-wrap';
      const table = document.createElement('table');
      const head = document.createElement('thead');
      const headerRow = document.createElement('tr');
      for (const cell of tableCells(line)) {
        const th = document.createElement('th');
        appendInline(th, cell);
        headerRow.append(th);
      }
      head.append(headerRow);
      table.append(head);
      const body = document.createElement('tbody');
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const row = document.createElement('tr');
        for (const cell of tableCells(lines[index])) {
          const td = document.createElement('td');
          appendInline(td, cell);
          row.append(td);
        }
        body.append(row);
        index++;
      }
      table.append(body);
      wrapper.append(table);
      container.append(wrapper);
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const element = document.createElement(heading[1].length === 1 ? 'h3' : 'h4');
      appendInline(element, heading[2]);
      container.append(element);
      index++;
      continue;
    }

    if (/^(---+|\*\*\*+)$/.test(line)) {
      container.append(document.createElement('hr'));
      index++;
      continue;
    }

    const listMatch = /^\s*([-*]|\d+\.)\s+(.+)$/.exec(lines[index]);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const item = /^\s*([-*]|\d+\.)\s+(.+)$/.exec(lines[index]);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        const li = document.createElement('li');
        appendInline(li, item[2]);
        list.append(li);
        index++;
      }
      container.append(list);
      continue;
    }

    const paragraph = document.createElement('p');
    const paragraphLines = [];
    while (index < lines.length && lines[index].trim() &&
        !(index + 1 < lines.length && lines[index].includes('|') && isTableRule(lines[index + 1])) &&
        !/^\s*([-*]|\d+\.)\s+/.test(lines[index]) &&
        !/^#{1,3}\s+/.test(lines[index].trim()) &&
        !/^(---+|\*\*\*+)$/.test(lines[index].trim())) {
      paragraphLines.push(lines[index].trim());
      index++;
    }
    appendInline(paragraph, paragraphLines.join(' '));
    container.append(paragraph);
  }
}

function addAiMessage(text, kind = '', markdown = false) {
  const message = document.createElement('div');
  message.className = `ai-message${kind ? ` ${kind}` : ''}${markdown ? ' ai-response' : ''}`;
  if (markdown) renderMarkdown(message, text);
  else message.textContent = text;
  ai('aiLog').append(message);
  ai('aiLog').scrollTop = ai('aiLog').scrollHeight;
  return message;
}

function toggleAssistant(open) {
  ai('aiPanel').hidden = !open;
  ai('aiToggle').setAttribute('aria-expanded', String(open));
  if (open) ai('aiInput').focus();
}

ai('aiToggle').addEventListener('click', () => toggleAssistant(ai('aiPanel').hidden));
ai('aiClose').addEventListener('click', () => {
  toggleAssistant(false);
  ai('aiToggle').focus();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !ai('aiPanel').hidden) {
    toggleAssistant(false);
    ai('aiToggle').focus();
  }
});

// Voice input. The browser turns speech into text (Chrome, Edge and Android Chrome support this;
// they send the audio to their own speech service). The words appear in the box as you speak and the
// question is sent when you stop. EN understands Indian English and Hinglish, हि understands Hindi.
(() => {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return;   // browser without speech input: the mic stays hidden
  ai('aiVoice').hidden = false;
  const LANGS = [{ code: 'en-IN', label: 'EN', name: 'English' }, { code: 'hi-IN', label: 'हि', name: 'Hindi' }];
  let lang = Number(localStorage.getItem('voiceLang')) || 0, rec = null, finalText = '', typedBefore = '';

  function showLang() {
    ai('aiLang').textContent = LANGS[lang].label;
    ai('aiLang').title = `Speaking in ${LANGS[lang].name}. Click to change.`;
  }
  showLang();
  ai('aiLang').addEventListener('click', () => {
    lang = (lang + 1) % LANGS.length;
    try { localStorage.setItem('voiceLang', String(lang)); } catch (e) { /* not saved, still works */ }
    showLang();
  });

  function stop() { if (rec) rec.stop(); }
  function setListening(on) {
    ai('aiMic').setAttribute('aria-pressed', String(on));
    ai('aiMic').setAttribute('aria-label', on ? 'Stop listening' : 'Speak your question');
    ai('aiInput').placeholder = on ? `Listening (${LANGS[lang].name})…` : 'Ask a question…';
  }

  ai('aiMic').addEventListener('click', () => {
    if (rec) return stop();
    if (assistant.busy) return;
    rec = new Recognition();
    rec.lang = LANGS[lang].code;
    rec.interimResults = true;
    rec.continuous = false;
    finalText = '';
    typedBefore = ai('aiInput').value.trim();
    rec.onresult = event => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) finalText += event.results[i][0].transcript;
        else interim += event.results[i][0].transcript;
      }
      ai('aiInput').value = [typedBefore, (finalText + interim).trim()].filter(Boolean).join(' ');
    };
    rec.onerror = event => {
      const messages = {
        'not-allowed': 'Microphone permission was refused. Allow the microphone for this site in the browser, then try again.',
        'service-not-allowed': 'Speech input is not allowed in this browser.',
        'no-speech': 'Nothing was heard. Tap the mic and speak again.',
        'audio-capture': 'No microphone was found.',
        network: 'Speech input needs an internet connection.'
      };
      if (event.error !== 'aborted') addAiMessage(messages[event.error] || `Speech input stopped: ${event.error}`, 'error');
    };
    rec.onend = () => {
      rec = null;
      setListening(false);
      if (finalText.trim() && !assistant.busy) ai('aiForm').requestSubmit();
    };
    setListening(true);
    rec.start();
  });

  // Closing the panel stops listening.
  ai('aiClose').addEventListener('click', stop);
})();

ai('aiForm').addEventListener('submit', async event => {
  event.preventDefault();
  const input = ai('aiInput');
  const text = input.value.trim();
  if (!text || assistant.busy) return;

  assistant.history.splice(0, Math.max(0, assistant.history.length - 10));
  assistant.history.push({ role: 'user', content: text });
  addAiMessage(text, 'user');
  input.value = '';
  assistant.busy = true;
  input.disabled = true;
  ai('aiSend').disabled = true;
  const pending = addAiMessage('Thinking...');

  try {
    const response = await fetch(`${ASSISTANT_API}/api/assistant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': sessionStorage.getItem('trendKey') || ''
      },
      body: JSON.stringify({
        messages: assistant.history,
        dashboard: {
          tag: ai('tagInput').value.trim(),
          from: ai('from').value,
          to: ai('to').value
        }
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
    if (typeof result.reply !== 'string' || !result.reply.trim()) throw new Error('The assistant returned an empty reply.');
    assistant.history.push({ role: 'assistant', content: result.reply });
    pending.remove();
    addAiMessage(result.reply, '', true);
  } catch (error) {
    assistant.history.pop();
    pending.remove();
    addAiMessage(error.message || 'The assistant could not respond. Please try again.', 'error');
  } finally {
    assistant.busy = false;
    input.disabled = false;
    ai('aiSend').disabled = false;
    input.focus();
  }
});
